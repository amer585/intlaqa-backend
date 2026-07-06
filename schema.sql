-- ════════════════════════════════════════════════════════════════════════
-- INTLAQA / MADRASTNA — Schema v5 (Turso / libSQL) — READ-OPTIMIZED REWRITE
-- ════════════════════════════════════════════════════════════════════════
--
-- WHY v4 WASN'T ENOUGH
--   v4 normalized the lost-update bug (one row per subject grade), and added a
--   materialized `schools` table plus a couple of indexes. But the two hottest
--   list reads were still doing non-covering index seeks + post-fetch sorts:
--     • /api/hierarchy/students  → idx_students_class is (school,grade,class,
--       admin_zone). The query needs student_name_ar sorted + ssn + gender —
--       those aren't in the index, so the planner does an index→table lookup
--       PER row plus an explicit ORDER BY student_name_ar sort over the rows.
--     • /api/teacher/students    → teacher_student_relations PK is (teacher_id,
--       student_id). The query orders by created_at DESC, which ISN'T in the
--       PK order, so a full sort happens for every teacher's dashboard load.
--
-- DESIGN GOALS (v5) — READ-FIRST, ADDITIVE-ONLY
--   1. PRESERVE every table + column name + type that the live services query
--      against (verified against every SQL literal in src/services/*). No
--      rename, no type change, no removed column. The rewrite is purely:
--        (a) covering indexes added on the hot list read paths,
--        (b) redundant indexes (duplicating a PK prefix) dropped,
--        (c) tight CHECK constraints where they can't break writes,
--        (d) NEW additive reference tables for the Cairo educational model
--            (directorates, education stages, subjects, school terms). Nothing
--            in services queries them — they are reference/validation only and
--            the user explicitly asked for them ("research cairo school system").
--   2. One round-trip reads still go through libSQL `batch()` (portal = 5 stmts
--      in one HTTP call); the covering indexes eliminate per-row lookups and
--      the explicit sorts for the two hot list reads above.
--   3. Cache layer (diskCache.js + redis.js) is left UNTOUCHED. The two cache
--      keys in active use stay semantically identical:
--        portal:<ssn>:<gradeLevel>  (disk: NEVER_EXPIRES, redis: 365d)
--        student:<gradeLevel>:<ssn> (redis: 300s)
--      The schema just adds covering paths so a cold-cache miss is also cheap.
--
-- Idempotent: boot runs this via src/db/migrate.js (CREATE … IF NOT EXISTS).
-- Manual:    turso db shell <url> < schema.sql   (DDL only; seeds run on boot).
-- ════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────
-- STUDENT DATABASE  (DATABASE_URL / TURSO_AUTH_TOKEN)
-- All school/staff/student/grade/attendance data lives here.
-- ───────────────────────────────────────────────────────────────────────

-- 27 Egyptian governorates. Seeded on boot from src/utils/governorates.js.
-- Cairo = '01' = القاهرة — used as the gov_code anchor for the Cairo
-- educational directorates below.
CREATE TABLE IF NOT EXISTS governorates (
  gov_code   TEXT    PRIMARY KEY,            -- '01' .. '27'
  name_ar    TEXT    NOT NULL
);

-- NEW (v5). Cairo educational directorates (الإدارات التعليمية) — the unit
-- between governorate and individual school. Cairo historically has four
-- directorates organized compass-style; sub-directorates (Helwan, Maadi,
-- Nasr City, etc.) can be added later without changing the schema.
-- The free-form `admin_zone` TEXT column on `staff`/`students`/`schools` carries
-- the directorate name in Arabic; this table gives us a clean lookup/validation
-- surface for future tooling and the Cairo-organized portal.
CREATE TABLE IF NOT EXISTS directorates (
  directorate_code    TEXT    PRIMARY KEY,        -- e.g. 'CAI-N','CAI-E','CAI-W','CAI-S'
  gov_code            TEXT    NOT NULL,           -- references governorates.gov_code
  directorate_name_ar TEXT    NOT NULL UNIQUE,    -- Arabic name as written in admin_zone
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_directorates_gov ON directorates (gov_code);

-- NEW (v5). Egyptian K-12 education stages (المراحل الدراسية).
-- The existing `grade_level INTEGER CHECK (1..12)` on `students` is unchanged;
-- this table maps the grade range to the Ministry stage name for display.
CREATE TABLE IF NOT EXISTS education_stages (
  stage_code    TEXT    PRIMARY KEY,        -- 'P','PR','S'
  stage_name_ar TEXT    NOT NULL,          -- 'الابتدائية','الإعدادية','الثانوية'
  grade_from    INTEGER NOT NULL CHECK (grade_from BETWEEN 0 AND 12),
  grade_to      INTEGER NOT NULL CHECK (grade_to   BETWEEN 0 AND 12),
  ordinal       INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9)
);
CREATE INDEX IF NOT EXISTS idx_stages_grade ON education_stages (grade_from, grade_to);

-- NEW (v5). Subject catalog (كatalog المواد الدراسية) per stage/branch.
-- The existing `subject_name` TEXT column on `student_grades` and
-- `weekly_assessments` is unchanged; this table is reference/validation and
-- the canonical Arabic spelling ground-truth. `branch` is NULL when a subject
-- applies to all branches of a stage; otherwise 'SCI_SCIENCES' / 'SCI_MATH' /
-- 'LIT' (the Egyptian secondary-stage branches: علمي علوم / علمي رياضة / أدبي).
CREATE TABLE IF NOT EXISTS subjects (
  subject_code    TEXT    PRIMARY KEY,
  subject_name_ar TEXT    NOT NULL,
  stage_code      TEXT,                   -- references education_stages.stage_code
  branch          TEXT    CHECK (branch IS NULL
                                OR branch IN ('SCI_SCIENCES','SCI_MATH','LIT')),
  ordinal         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_subjects_stage ON subjects (stage_code, ordinal);
CREATE INDEX IF NOT EXISTS idx_subjects_name  ON subjects (subject_name_ar);

-- NEW (v5). The Egyptian school year is split into two terms (الترم الأول /
-- الترم الثاني) with mid-year and end-of-year exams. Reference for the
-- schedule/calendar UI; the existing `date` / `week_number` columns on the
-- hot tables are unchanged.
CREATE TABLE IF NOT EXISTS school_terms (
  term_code    TEXT    PRIMARY KEY,        -- 'T1','T2'
  term_name_ar TEXT    NOT NULL,          -- 'الترم الأول','الترم الثاني'
  ordinal      INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 4)
);

-- Materialized school hierarchy: governorate → admin_zone(directorate) → school.
-- Replaces the old `SELECT DISTINCT …` scans over the growing `teachers` table
-- with a tiny indexed dimension lookup. UNIQUE constraint index already serves
-- the loadSchools ORDER BY (gov_code, admin_zone, school_name) — the explicit
-- idx_schools_zone keeps admin_zone-leading seeks fast too. idx_schools_gov is
-- dropped (covered by the UNIQUE prefix).
CREATE TABLE IF NOT EXISTS schools (
  school_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  gov_code    TEXT    NOT NULL,
  admin_zone  TEXT    NOT NULL,            -- district / إدارة — Arabic name
  school_name TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (gov_code, admin_zone, school_name)
);
CREATE INDEX IF NOT EXISTS idx_schools_zone ON schools (admin_zone, school_name);

-- Staff / principals / admins / directors (username + bcrypt login).
-- Was `teachers` in v3; renamed in v4. JWT still carries `teacher_id` =
-- `staff_id` so the existing frontend token shape is unchanged. `role` is
-- left unconstrained to allow new roles without a migration (current set the
-- role middleware accepts: admin, principal, manager, directorate,
-- directorate_manager, district, district_manager, teacher).
CREATE TABLE IF NOT EXISTS staff (
  staff_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  display_name  TEXT,                          -- teacher_name_ar
  role          TEXT    NOT NULL DEFAULT 'teacher',
  gov_code      TEXT,                          -- directorate scope
  admin_zone    TEXT    NOT NULL DEFAULT 'ALL', -- district scope
  school_name   TEXT    NOT NULL DEFAULT 'ALL', -- school scope
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_staff_school ON staff (school_name);
CREATE INDEX IF NOT EXISTS idx_staff_zone   ON staff (admin_zone);

-- Student PROFILE — lean. No academic blobs live here (since v4).
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
-- Hot hierarchy read (idx from v4): school → grade → class prefix seek.
CREATE INDEX IF NOT EXISTS idx_students_class
  ON students (school_name, grade_level, class_name, admin_zone);
-- NEW (v5). Covering + ordered for /api/hierarchy/students class roster:
-- WHERE school_name=? AND grade_level=? AND class_name=?
-- ORDER BY student_name_ar ASC  LIMIT 500      (+ return ssn_encrypted, gender)
-- Every column needed (filter + sort + projection) lives IN the index → no
-- table lookup, no explicit sort. The single biggest read-path win.
CREATE INDEX IF NOT EXISTS idx_students_class_roster
  ON students (school_name, grade_level, class_name, student_name_ar,
               ssn_encrypted, gender);
-- NEW (v5). For the /grades/update existence check used by grade.service:
--   WHERE grade_level = ? AND class_name = ? AND ssn_encrypted IN (...)
-- Prior to v5 this had no supporting index (the /api/hierarchy/students had
-- a school_name-anchored index only; this batch read filtered BY grade/class
-- only, landing on a scan). Now prefix-seek by (grade, class).
CREATE INDEX IF NOT EXISTS idx_students_grade_class
  ON students (grade_level, class_name, ssn_encrypted);

-- ★ GRADES — one subject grade per student = exactly one row. PK (ssn, subject)
-- is the access path for both the portal read and the single-grade upsert.
CREATE TABLE IF NOT EXISTS student_grades (
  ssn_encrypted TEXT    NOT NULL,
  subject_name  TEXT    NOT NULL,
  grade_value   TEXT    NOT NULL,
  updated_by    INTEGER,                       -- staff_id of last editor
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ssn_encrypted, subject_name)
);
-- Index-only scan for the portal/roster grade reads (value + audit in the
-- index). The PK already serves (ssn,subject) lookup; this index makes the
-- portal read a covering scan (no table-touch).
CREATE INDEX IF NOT EXISTS idx_grades_cover
  ON student_grades (ssn_encrypted, subject_name, grade_value, updated_by, updated_at);

-- Attendance — one status per student per day. PK (ssn, date) ASC. The portal
-- reads `WHERE ssn_encrypted=? ORDER BY date DESC`, which SQLite serves via the
-- PK in reverse-scan for the matching ssn prefix — so an additional
-- `(ssn, date DESC)` index is NOT needed. The v4 `idx_attendance_ssn
-- (ssn_encrypted)` was pure redundancy with the PK prefix → dropped in v5.
CREATE TABLE IF NOT EXISTS attendance (
  ssn_encrypted TEXT    NOT NULL,
  date          TEXT    NOT NULL,              -- 'YYYY-MM-DD'
  status        TEXT    NOT NULL CHECK (status IN ('present','absent','late','excused')),
  note          TEXT,
  PRIMARY KEY (ssn_encrypted, date)
);

-- Weekly assessments per subject/week. PK (ssn, subject, week) ASC. The portal
-- reads `WHERE ssn_encrypted=? ORDER BY subject_name ASC, week_number ASC` —
-- perfect PK prefix order → no extra index. The v4 `idx_weekly_ssn
-- (ssn_encrypted)` was pure redundancy with the PK prefix → dropped in v5.
CREATE TABLE IF NOT EXISTS weekly_assessments (
  ssn_encrypted TEXT    NOT NULL,
  subject_name  TEXT    NOT NULL,
  week_number   INTEGER NOT NULL,
  score         REAL    NOT NULL CHECK (score >= 0),
  max_score     REAL    NOT NULL DEFAULT 10 CHECK (max_score > 0),
  PRIMARY KEY (ssn_encrypted, subject_name, week_number)
);

-- Teacher → (grade, class, subject) assignment. Authorizes grade edits.
-- Lives in the STUDENT DB (jointly read with staff on the roster screens).
-- PK (teacher_id, grade_level, class_name, subject_name) is the only access
-- path needed — all queries prefix-seek teacher_id and ORDER BY the remaining
-- PK columns in declaration order.
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
--   key 'schedule:7'    → { day: [{period,start_time,end_time,subject_name,teacher_name}] }
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
  is_verified   INTEGER NOT NULL DEFAULT 0 CHECK (is_verified IN (0,1)),  -- 0=pending, 1=approved
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ta_pending ON teacher_accounts (is_verified, created_at);

-- teacher ↔ student relations. The student_id is a CROSS-DATABASE soft FK to
-- students.ssn_encrypted (in the OTHER Turso DB) — libSQL doesn't enforce
-- cross-DB FKs, and the app validates existence in two round trips
-- (teacherAccount.service.linkStudent / listTeacherStudents).
CREATE TABLE IF NOT EXISTS teacher_student_relations (
  teacher_id  TEXT    NOT NULL,
  student_id  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (teacher_id, student_id)
);
-- Reverse lookup: given a student, who teaches them? (Used to enrich the
-- student portal view of "my teacher" — index on student_id leading.)
CREATE INDEX IF NOT EXISTS idx_tsr_student ON teacher_student_relations (student_id);
-- NEW (v5). Covering + ordered for /api/teacher/students — the teacher
-- dashboard's hottest read:
--   WHERE teacher_id = ?  ORDER BY created_at DESC  LIMIT 1000
--   (+ projection student_id, created_at)
-- PK is (teacher_id, student_id) — created_at isn't in PK order, so this
-- previously forced an explicit sort over the joined teacher relation rows on
-- every dashboard load. The new index covers filter+sort+projection with no
-- table-touch. The biggest teacher-DB read-path win.
CREATE INDEX IF NOT EXISTS idx_tsr_teacher_date
  ON teacher_student_relations (teacher_id, created_at DESC, student_id);

DROP TRIGGER IF EXISTS teacher_accounts_updated_at;
CREATE TRIGGER teacher_accounts_updated_at AFTER UPDATE ON teacher_accounts
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE teacher_accounts SET updated_at = datetime('now') WHERE id = NEW.id; END;
