-- ═══════════════════════════════════════════════════════════
-- INTLAQA / MADRASTNA — Turso / libSQL Schema (SQLite)
-- The app auto-creates these on boot. Run manually with:
--   turso db shell <your-db-url> < schema.sql
-- ═══════════════════════════════════════════════════════════

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

CREATE TABLE IF NOT EXISTS students (
  ssn_encrypted   TEXT PRIMARY KEY,
  student_name_ar TEXT,
  gender          TEXT,
  gov_code        TEXT,
  admin_zone      TEXT,
  school_name     TEXT,
  grade_level     INTEGER NOT NULL,
  class_name      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_class_lookup
  ON students (school_name, grade_level, class_name, admin_zone);

CREATE TABLE IF NOT EXISTS student_grades (
  grade_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ssn_encrypted TEXT NOT NULL,
  grade_level   INTEGER NOT NULL,
  class_name    TEXT NOT NULL,
  subject_name  TEXT NOT NULL,
  grade_value   TEXT,
  teacher_id    INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_student_grade_scope
  ON student_grades (ssn_encrypted, grade_level, class_name, subject_name);
CREATE INDEX IF NOT EXISTS idx_grade_roster_lookup
  ON student_grades (grade_level, class_name, ssn_encrypted);

CREATE TABLE IF NOT EXISTS activity_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ssn_encrypted TEXT NOT NULL,
  action_type   INTEGER NOT NULL,
  metadata      TEXT,
  logged_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ssn_time
  ON activity_logs (ssn_encrypted, logged_at DESC);

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

-- Triggers for auto-updating updated_at
CREATE TRIGGER IF NOT EXISTS teachers_updated_at
AFTER UPDATE ON teachers FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE teachers SET updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

CREATE TRIGGER IF NOT EXISTS students_updated_at
AFTER UPDATE ON students FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE students SET updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

CREATE TRIGGER IF NOT EXISTS student_grades_updated_at
AFTER UPDATE ON student_grades FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE student_grades SET updated_at = datetime('now') WHERE rowid = NEW.rowid; END;

-- ═══════════════════════════════════════════════════════════
-- TEACHER DATABASE (separate Turso account / DATABASE_URL)
-- Run ONLY against the teacher DB (TEACHER_DATABASE_URL). These
-- tables power the public teacher sign-up → admin approval → JWT
-- login flow, isolated from the student DB to double free limits.
-- Created automatically on boot by src/db/migrate.js#runTeacherMigrations.
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS teacher_accounts (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  phone         TEXT,
  subject       TEXT,
  is_verified   INTEGER NOT NULL DEFAULT 0,  -- 0 = pending admin approval, 1 = approved
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_teacher_accounts_email ON teacher_accounts (email);
CREATE INDEX IF NOT EXISTS idx_teacher_accounts_pending ON teacher_accounts (is_verified, created_at);

CREATE TABLE IF NOT EXISTS teacher_student_relations (
  teacher_id  TEXT NOT NULL,
  student_id  TEXT NOT NULL,  -- references students.ssn_encrypted in the STUDENT DB
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (teacher_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_tsr_student ON teacher_student_relations (student_id);
CREATE INDEX IF NOT EXISTS idx_tsr_teacher ON teacher_student_relations (teacher_id);

CREATE TRIGGER IF NOT EXISTS teacher_accounts_updated_at
AFTER UPDATE ON teacher_accounts FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE teacher_accounts SET updated_at = datetime('now') WHERE id = NEW.id; END;
