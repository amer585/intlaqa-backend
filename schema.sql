-- ════════════════════════════════════════════════════════════════════════
-- INTLAQA / MADRASTNA — Schema v4 (Turso / libSQL) — REWRITE FROM SCRATCH
-- ════════════════════════════════════════════════════════════════════════
--
-- WHY THE OLD SCHEMA WAS BAD (v3)
--   • Every student carried grades_json / attendance_json / weekly_json BLOBS
--     on its own row.
--   • Updating ONE subject grade = read whole blob → mutate in JS → write the
--     whole blob back. Two teachers editing DIFFERENT subjects for the same
--     student at the same time clobbered each other (last-write-wins = LOST
--     DATA), and the write held a lock on the entire student row.
--   • Grade history (who/when) was impossible to store, so the frontend's
--     { teacher_id, updated_at } on a grade could never be populated.
--   • Grades were un-queryable ("all students below 50%") without a full table
--     scan + per-row JSON parse.
--
-- DESIGN GOALS (v4) — OPTIMIZED FOR BOTH READ AND WRITE LATENCY
--   1. NORMALIZE the hot, contended write path: one subject grade = ONE small
--      row. Upsert touches exactly that row → concurrent teachers on different
--      subjects NEVER block each other and NEVER lose data.
--   2. SINGLE ROUND TRIP for reads via libSQL `batch()`: the whole student
--      portal (profile + grades + attendance + weekly + schedule + news) is
--      fetched in ONE HTTP call across several index-only scans.
--   3. COVERING / PREFIX indexes so the most frequent reads are index-only
--      scans (no table lookup). Primary keys double as access paths.
--   4. TIGHT constraints (CHECK, UNIQUE, NOT NULL) for data integrity instead
--      of free-form JSON.
--   5. A MATERIALIZED `schools` table collapses the old `SELECT DISTINCT …`
--      hierarchy scans into a tiny indexed lookup.
--   6. Keep `portal_meta` (schedule + announcements) as shared, low-cardinality
--      blobs — they are read together and rarely change.
--
-- Idempotent: created on boot by src/db/migrate.js (CREATE … IF NOT EXISTS),
-- which also back-fills data from the legacy v3 JSON columns / tables.
-- Manual run:  turso db shell <url> < schema.sql
-- ════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────
-- STUDENT DATABASE  (DATABASE_URL / TURSO_AUTH_TOKEN)
-- ───────────────────────────────────────────────────────────────────────

-- Reference table for the 27 Egyptian governorates. Seeded on boot; the code
-- is what we actually store everywhere (the Arabic name is resolved for view).
CREATE TABLE IF NOT EXISTS governorates (
  gov_code   TEXT    PRIMARY KEY,            -- '01' .. '27'
  name_ar    TEXT    NOT NULL
);

-- Materialized school hierarchy: governorate → admin_zone(district) → school.
-- Replaces `SELECT DISTINCT school_name, admin_zone, gov_code FROM teachers`
-- (a scan over a growing table) with an indexed read over a tiny dimension
-- table. One natural row per real school.
CREATE TABLE IF NOT EXISTS schools (
  school_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  gov_code    TEXT    NOT NULL,
  admin_zone  TEXT    NOT NULL,               -- district / إدارة
  school_name TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (gov_code, admin_zone, school_name)
);
CREATE INDEX IF NOT EXISTS idx_schools_zone ON schools (admin_zone, school_name);
CREATE INDEX IF NOT EXISTS idx_schools_gov  ON schools (gov_code);

-- Staff / principals / admins / directors (username + bcrypt login).
-- (Was `teachers`; renamed for clarity. JWT still carries `teacher_id` =
-- staff_id so the existing frontend token shape is unchanged.)
CREATE TABLE IF NOT EXISTS staff (
  staff_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  display_name  TEXT,                          -- teacher_name_ar
  role          TEXT    NOT NULL DEFAULT 'teacher',
  gov_code      TEXT,                          -- directorate scope
  admin_zone    TEXT    NOT NULL DEFAULT 'ALL', -- district scope
  school_name   TEXT    NOT NULL DEFAULT 'ALL', -- school scope
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_staff_school ON staff (school_name);
CREATE INDEX IF NOT EXISTS idx_staff_zone   ON staff (admin_zone);

-- Student PROFILE only — lean. No academic blobs live here anymore.
CREATE TABLE IF NOT EXISTS students (
  ssn_encrypted   TEXT    PRIMARY KEY,          -- 14-digit token
  student_name_ar TEXT,
  gender          TEXT    CHECK (gender IS NULL OR gender IN ('M', 'F')),
  gov_code        TEXT,
  admin_zone      TEXT,
  school_name     TEXT,
  grade_level     INTEGER NOT NULL CHECK (grade_level BETWEEN 1 AND 12),
  class_name      TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
-- Covering index for the class-roster + hierarchy reads (the hottest list read).
CREATE INDEX IF NOT EXISTS idx_students_class
  ON students (school_name, grade_level, class_name, admin_zone);

-- ★ GRADES — normalized. THIS is the fix for the lost-update bug.
-- One subject grade per student = exactly one row. PK (ssn, subject) is the
-- access path for both the portal read and the single-grade upsert.
CREATE TABLE IF NOT EXISTS student_grades (
  ssn_encrypted TEXT    NOT NULL,
  subject_name  TEXT    NOT NULL,
  grade_value   TEXT    NOT NULL,
  updated_by    INTEGER,                       -- staff_id of last editor
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ssn_encrypted, subject_name)
);
-- Index-only scan for portal/roster grade reads (value + audit in the index).
CREATE INDEX IF NOT EXISTS idx_grades_cover
  ON student_grades (ssn_encrypted, subject_name, grade_value, updated_by, updated_at);
-- Roster "who has a grade for this subject in this class" queries.
-- (class_name is denormalized here only if you later want class-wide subject
--  scans without joining students; left available but not required.)

-- Attendance — one status per student per day. Append/upsert, queryable.
CREATE TABLE IF NOT EXISTS attendance (
  ssn_encrypted TEXT    NOT NULL,
  date          TEXT    NOT NULL,              -- 'YYYY-MM-DD'
  status        TEXT    NOT NULL CHECK (status IN ('present','absent','late','excused')),
  note          TEXT,
  PRIMARY KEY (ssn_encrypted, date)
);
CREATE INDEX IF NOT EXISTS idx_attendance_ssn ON attendance (ssn_encrypted);

-- Weekly assessments per subject/week. Upsertable, queryable.
CREATE TABLE IF NOT EXISTS weekly_assessments (
  ssn_encrypted TEXT    NOT NULL,
  subject_name  TEXT    NOT NULL,
  week_number   INTEGER NOT NULL,
  score         REAL    NOT NULL,
  max_score     REAL    NOT NULL DEFAULT 10,
  PRIMARY KEY (ssn_encrypted, subject_name, week_number)
);
CREATE INDEX IF NOT EXISTS idx_weekly_ssn ON weekly_assessments (ssn_encrypted);

-- Teacher → (grade, class, subject) assignment. Authorizes grade edits.
CREATE TABLE IF NOT EXISTS teacher_classes (
  teacher_id   INTEGER NOT NULL,               -- = staff.staff_id
  grade_level  INTEGER NOT NULL,
  class_name   TEXT    NOT NULL,
  subject_name TEXT    NOT NULL,
  PRIMARY KEY (teacher_id, grade_level, class_name, subject_name)
);

-- Audit trail (bulk-inserted via libSQL batch = 1 round trip, atomic).
CREATE TABLE IF NOT EXISTS activity_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ssn_encrypted TEXT    NOT NULL,
  action_type   INTEGER NOT NULL,
  metadata      TEXT,
  logged_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_logs_ssn_time ON activity_logs (ssn_encrypted, logged_at DESC);

-- Shared portal blobs (schedule per grade + global announcements).
--   key 'schedule:7'  → { day: [{period,start_time,end_time,subject_name,teacher_name}] }
--   key 'announcements' → [ {id,title,content,category,importance,created_at} ]
CREATE TABLE IF NOT EXISTS portal_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- updated_at maintenance (SQLite pattern: DROP then CREATE).
DROP TRIGGER IF EXISTS staff_updated_at;
CREATE TRIGGER staff_updated_at AFTER UPDATE ON staff
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE staff SET updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS students_updated_at;
CREATE TRIGGER students_updated_at AFTER UPDATE ON students
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE students SET updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

-- ════════════════════════════════════════════════════════════════════════
-- TEACHER DATABASE  (TEACHER_DATABASE_URL / TEACHER_DATABASE_TOKEN)
--   separate Turso account — email self-registration → admin approval → JWT
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS teacher_accounts (
  id            TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  phone         TEXT,
  subject       TEXT,
  is_verified   INTEGER NOT NULL DEFAULT 0,    -- 0 = pending, 1 = approved
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ta_pending ON teacher_accounts (is_verified, created_at);

CREATE TABLE IF NOT EXISTS teacher_student_relations (
  teacher_id  TEXT    NOT NULL,
  student_id  TEXT    NOT NULL,                -- references students.ssn_encrypted
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (teacher_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_tsr_student ON teacher_student_relations (student_id);

DROP TRIGGER IF EXISTS teacher_accounts_updated_at;
CREATE TRIGGER teacher_accounts_updated_at AFTER UPDATE ON teacher_accounts
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE teacher_accounts SET updated_at = datetime('now') WHERE id = NEW.id; END;
