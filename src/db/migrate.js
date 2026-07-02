'use strict';

const logger = require('../lib/logger');

/**
 * Idempotent schema bootstrap. Runs on every boot via CREATE TABLE IF NOT EXISTS,
 * so the app self-heals even on a fresh/empty database (fixes the 500 "Internal
 * Server Error" when tables are missing on the HF Space).
 *
 * Statements are embedded (not read from a file) so DO/function blocks split cleanly.
 * @param {import('pg').PoolClient} client
 */
async function runMigrations(client) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS teachers (
       teacher_id      BIGSERIAL    PRIMARY KEY,
       username        VARCHAR(64)  NOT NULL UNIQUE,
       password_hash   VARCHAR(72)  NOT NULL,
       teacher_name_ar VARCHAR(100),
       role            VARCHAR(32)  NOT NULL DEFAULT 'teacher',
       gov_code        VARCHAR(10),
       admin_zone      VARCHAR(50)  DEFAULT 'ALL',
       school_name     VARCHAR(100) DEFAULT 'ALL',
       is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
       created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
       updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
     )`,
    `CREATE TABLE IF NOT EXISTS students (
       ssn_encrypted   VARCHAR(14)  PRIMARY KEY,
       student_name_ar VARCHAR(100),
       gender          CHAR(1),
       gov_code        VARCHAR(10),
       admin_zone      VARCHAR(50),
       school_name     VARCHAR(100),
       grade_level     SMALLINT     NOT NULL,
       class_name      VARCHAR(30),
       created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
       updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_class_lookup
       ON students (school_name, grade_level, class_name, admin_zone)`,
    `CREATE TABLE IF NOT EXISTS student_grades (
       grade_id      BIGSERIAL    PRIMARY KEY,
       ssn_encrypted VARCHAR(14)  NOT NULL,
       grade_level   SMALLINT     NOT NULL,
       class_name    VARCHAR(30)  NOT NULL,
       subject_name  VARCHAR(100) NOT NULL,
       grade_value   VARCHAR(50),
       teacher_id    BIGINT,
       created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
       updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
       UNIQUE (ssn_encrypted, grade_level, class_name, subject_name)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_grade_roster_lookup
       ON student_grades (grade_level, class_name, ssn_encrypted)`,
    `CREATE TABLE IF NOT EXISTS activity_logs (
       id            BIGSERIAL   PRIMARY KEY,
       ssn_encrypted VARCHAR(14) NOT NULL,
       action_type   SMALLINT    NOT NULL,
       metadata      JSONB,
       logged_at     TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_ssn_time
       ON activity_logs (ssn_encrypted, logged_at DESC)`,
    `CREATE TABLE IF NOT EXISTS teacher_classes (
       id           BIGSERIAL   PRIMARY KEY,
       teacher_id   BIGINT      NOT NULL,
       grade_level  SMALLINT    NOT NULL,
       class_name   VARCHAR(30) NOT NULL,
       subject_name VARCHAR(100) NOT NULL,
       UNIQUE (teacher_id, grade_level, class_name, subject_name)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_class_subject
       ON teacher_classes (grade_level, class_name, subject_name)`,
    `CREATE OR REPLACE FUNCTION set_updated_at()
       RETURNS TRIGGER AS $$
       BEGIN
         NEW.updated_at = now();
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS teachers_updated_at ON teachers`,
    `CREATE TRIGGER teachers_updated_at BEFORE UPDATE ON teachers
       FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,
    `DROP TRIGGER IF EXISTS students_updated_at ON students`,
    `CREATE TRIGGER students_updated_at BEFORE UPDATE ON students
       FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,
    `DROP TRIGGER IF EXISTS student_grades_updated_at ON student_grades`,
    `CREATE TRIGGER student_grades_updated_at BEFORE UPDATE ON student_grades
       FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,
  ];

  for (const sql of statements) {
    await client.query(sql);
  }
  logger.info('Database schema ready', { statements: statements.length });
}

module.exports = { runMigrations };
