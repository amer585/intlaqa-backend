-- ═══════════════════════════════════════════════════════════
-- INTLAQA — TiDB Schema Migration
-- Run this on EACH of your 3 TiDB clusters:
--   DB_PRIMARY   (grades 1–6)
--   DB_PREP      (grades 7–9)
--   DB_SECONDARY (grades 10–12)
-- ═══════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────
-- 1. STUDENTS TABLE
--    Primary table for student profiles.
--    ssn_encrypted is the SOLE unique identifier.
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS students (
  ssn_encrypted   VARCHAR(14)   NOT NULL,
  student_name_ar VARCHAR(100)  DEFAULT NULL,
  gender          CHAR(1)       DEFAULT NULL,    -- 'M' or 'F' (1 byte)
  gov_code        VARCHAR(10)   DEFAULT NULL,
  admin_zone      VARCHAR(50)   DEFAULT NULL,
  school_name     VARCHAR(100)  DEFAULT NULL,
  grade_level     TINYINT       NOT NULL,         -- 1 byte (not INT = 4 bytes)
  class_name      VARCHAR(30)   DEFAULT NULL,
  created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (ssn_encrypted)
  -- ssn_encrypted IS the clustered index in TiDB.
  -- All lookups by SSN are O(1). No secondary index needed.
);

CREATE INDEX IF NOT EXISTS idx_class_lookup
  ON students (school_name, grade_level, class_name, admin_zone);

-- ─────────────────────────────────────────────────────────
-- 1B. STUDENT GRADES TABLE
--     Scoped by student, grade level, and class to keep
--     roster joins bounded to the active class only.
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS student_grades (
  grade_id         BIGINT        NOT NULL AUTO_INCREMENT,
  ssn_encrypted    VARCHAR(14)   NOT NULL,
  grade_level      TINYINT       NOT NULL,
  class_name       VARCHAR(30)   NOT NULL,
  subject_name     VARCHAR(100)  NOT NULL,
  grade_value      VARCHAR(50)   DEFAULT NULL,
  teacher_id       BIGINT        DEFAULT NULL,
  created_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (grade_id),
  UNIQUE KEY uq_student_grade_scope (ssn_encrypted, grade_level, class_name, subject_name),
  INDEX idx_grade_roster_lookup (grade_level, class_name, ssn_encrypted)
);

ALTER TABLE student_grades
  ADD COLUMN IF NOT EXISTS grade_level TINYINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS class_name VARCHAR(30) NOT NULL DEFAULT '';

-- If your existing table still has a legacy student+subject unique key,
-- drop it before applying the scoped unique index below.
CREATE UNIQUE INDEX IF NOT EXISTS uq_student_grade_scope
  ON student_grades (ssn_encrypted, grade_level, class_name, subject_name);

CREATE INDEX IF NOT EXISTS idx_grade_roster_lookup
  ON student_grades (grade_level, class_name, ssn_encrypted);


-- ─────────────────────────────────────────────────────────
-- 2. ACTIVITY LOGS TABLE
--    Ultra-lightweight action tracking.
--
--    RU SAVINGS:
--    • action_type is TINYINT (1 byte) not VARCHAR (20+ bytes)
--      → saves ~19 bytes × 130M rows/day = 2.47 GB/day
--    • metadata is nullable JSON — only used when needed
--    • Composite index on (ssn_encrypted, logged_at) for
--      efficient "recent activity" queries
--    • AUTO_INCREMENT id for fast inserts (append-only)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_logs (
  id              BIGINT        NOT NULL AUTO_INCREMENT,
  ssn_encrypted   VARCHAR(14)   NOT NULL,
  action_type     TINYINT       NOT NULL,         -- 1 byte! See mapping below
  metadata        JSON          DEFAULT NULL,     -- nullable, only when extra data needed
  logged_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- Composite index: "show me recent activity for student X"
  -- Covers: WHERE ssn_encrypted = ? ORDER BY logged_at DESC LIMIT N
  INDEX idx_ssn_time (ssn_encrypted, logged_at DESC)
);

-- ─────────────────────────────────────────────────────────
-- ACTION TYPE REFERENCE (stored in code, not in DB)
-- Using TINYINT instead of ENUM or VARCHAR saves bytes
-- and avoids schema migrations when adding new types.
-- ─────────────────────────────────────────────────────────
--  1  = LOGIN
--  2  = LOGOUT
--  3  = VIEW_PROFILE
--  4  = VIEW_GRADES
--  5  = VIEW_ATTENDANCE
--  6  = VIEW_SCHEDULE
--  10 = TEACHER_LOGIN
--  11 = TEACHER_GRADE_ENTRY
--  12 = TEACHER_ATTENDANCE_ENTRY
-- ─────────────────────────────────────────────────────────
