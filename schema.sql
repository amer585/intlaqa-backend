-- ═══════════════════════════════════════════════════════════
-- INTLAQA / MADRASTNA — Turso / libSQL Schema (SQLite)
-- Auto-created on boot by src/db/migrate.js (idempotent).
-- Manual run: turso db shell <your-db-url> < schema.sql
-- ═══════════════════════════════════════════════════════════
--
-- READ MODEL PHILOSOPHY (optimized for minimal Turso reads):
--  • Per-student data (grades, attendance, weekly) is stored as JSON columns
--    ON the students row → one student = exactly ONE row to read everything.
--  • Shared data (schedule + announcements) is stored as single JSON blobs in
--    a tiny portal_meta key/value table → the whole week's schedule = ONE row,
--    all announcements = ONE row. (Replaces the old per-day/per-period
--    class_schedule + per-announcement rows.)
--  • A full portal fetch = 2 queries returning ~3 rows total (was ~38).
-- ═══════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- STUDENT DATABASE (DATABASE_URL)
-- ─────────────────────────────────────────────────────────────

-- Staff / principals / admins (username-based login, bcrypt).
CREATE TABLE IF NOT EXISTS teachers (
  teacher_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  teacher_name_ar TEXT,
  role            TEXT NOT NULL DEFAULT 'teacher',
  gov_code        TEXT,
  admin_zone      TEXT DEFAULT 'ALL',
  school_name     TEXT DEFAULT 'ALL',
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Students: a SINGLE row holds the profile + ALL of its data as JSON columns.
CREATE TABLE IF NOT EXISTS students (
  ssn_encrypted   TEXT PRIMARY KEY,
  student_name_ar TEXT,
  gender          TEXT,
  gov_code        TEXT,
  admin_zone      TEXT,
  school_name     TEXT,
  grade_level     INTEGER NOT NULL,
  class_name      TEXT,
  grades_json     TEXT DEFAULT '{}',      -- {subject: gradeValue}
  attendance_json TEXT DEFAULT '[]',      -- [{date,status,note}]
  weekly_json     TEXT DEFAULT '{}',      -- {subject: [{week,score,max_score}]}
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_class_lookup
  ON students (school_name, grade_level, class_name, admin_zone);

-- Teacher → class/subject assignments (used to authorize grade edits).
CREATE TABLE IF NOT EXISTS teacher_classes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id   INTEGER NOT NULL,
  grade_level  INTEGER NOT NULL,
  class_name   TEXT NOT NULL,
  subject_name TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_assignment
  ON teacher_classes (teacher_id, grade_level, class_name, subject_name);
CREATE INDEX IF NOT EXISTS idx_class_subject
  ON teacher_classes (grade_level, class_name, subject_name);

-- Audit trail.
CREATE TABLE IF NOT EXISTS activity_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ssn_encrypted TEXT NOT NULL,
  action_type   INTEGER NOT NULL,
  metadata      TEXT,
  logged_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ssn_time
  ON activity_logs (ssn_encrypted, logged_at DESC);

-- ★ NEW: lean shared-portal store. ONE row per schedule/announcement blob.
--   'schedule:7'    → full weekly schedule JSON grouped by day
--   'announcements' → array of announcement objects
CREATE TABLE IF NOT EXISTS portal_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- updated_at triggers (SQLite pattern: DROP then CREATE).
DROP TRIGGER IF EXISTS teachers_updated_at;
CREATE TRIGGER teachers_updated_at AFTER UPDATE ON teachers
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE teachers SET updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

DROP TRIGGER IF EXISTS students_updated_at;
CREATE TRIGGER students_updated_at AFTER UPDATE ON students
  FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
  BEGIN UPDATE students SET updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

-- Legacy tables (student_grades, student_attendance, weekly_assessments,
-- class_schedule, announcements) are migrated into the JSON columns /
-- portal_meta and then DROPPED automatically on boot. They are intentionally
-- NOT recreated here.

-- ═══════════════════════════════════════════════════════════
-- TEACHER DATABASE (TEACHER_DATABASE_URL) — separate Turso account
-- Email-based teacher self-registration → admin approval → JWT login.
-- Created automatically on boot by runTeacherMigrations().
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS teacher_accounts (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  phone         TEXT,
  subject       TEXT,
  is_verified   INTEGER NOT NULL DEFAULT 0,  -- 0 = pending approval, 1 = approved
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_teacher_accounts_email ON teacher_accounts (email);
CREATE INDEX IF NOT EXISTS idx_teacher_accounts_pending ON teacher_accounts (is_verified, created_at);

CREATE TABLE IF NOT EXISTS teacher_student_relations (
  teacher_id  TEXT NOT NULL,
  student_id  TEXT NOT NULL,  -- references students.ssn_encrypted (student DB)
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (teacher_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_tsr_student ON teacher_student_relations (student_id);
CREATE INDEX IF NOT EXISTS idx_tsr_teacher ON teacher_student_relations (teacher_id);

CREATE TRIGGER IF NOT EXISTS teacher_accounts_updated_at
AFTER UPDATE ON teacher_accounts FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE teacher_accounts SET updated_at = datetime('now') WHERE id = NEW.id; END;
