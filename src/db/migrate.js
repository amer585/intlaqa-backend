'use strict';

const logger = require('../lib/logger');

// Bump when the schema/migration changes. The expensive one-time data
// explosion only runs while this version marker is absent from portal_meta.
const SCHEMA_VERSION = '4';

/** @typedef {{ execute: (q: { sql: string; args?: unknown[] }) => Promise<{ rows: Record<string, unknown>[]; rowsAffected: number; lastInsertRowid: number | bigint }>, batch: (stmts: { sql: string; args?: unknown[] }[], mode?: 'read'|'write'|'deferred') => Promise<any[]> }} RawDb */

/** Thin helper so we always pass {sql,args}. @param {RawDb} db */
const exec = (db, sql, args = []) => db.execute({ sql, args });

// ── DDL (kept identical to schema.sql; duplicated so a fresh boot self-creates) ──
const STUDENT_DDL = [
  `CREATE TABLE IF NOT EXISTS governorates (
     gov_code TEXT PRIMARY KEY, name_ar TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS schools (
     school_id INTEGER PRIMARY KEY AUTOINCREMENT,
     gov_code TEXT NOT NULL, admin_zone TEXT NOT NULL, school_name TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE (gov_code, admin_zone, school_name)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_schools_zone ON schools (admin_zone, school_name)`,
  `CREATE INDEX IF NOT EXISTS idx_schools_gov  ON schools (gov_code)`,
  `CREATE TABLE IF NOT EXISTS staff (
     staff_id INTEGER PRIMARY KEY AUTOINCREMENT,
     username TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     display_name TEXT,
     role TEXT NOT NULL DEFAULT 'teacher',
     gov_code TEXT,
     admin_zone TEXT NOT NULL DEFAULT 'ALL',
     school_name TEXT NOT NULL DEFAULT 'ALL',
     is_active INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_staff_school ON staff (school_name)`,
  `CREATE INDEX IF NOT EXISTS idx_staff_zone   ON staff (admin_zone)`,
  `CREATE TABLE IF NOT EXISTS students (
     ssn_encrypted TEXT PRIMARY KEY,
     student_name_ar TEXT,
     gender TEXT CHECK (gender IS NULL OR gender IN ('M','F')),
     gov_code TEXT, admin_zone TEXT, school_name TEXT,
     grade_level INTEGER NOT NULL CHECK (grade_level BETWEEN 1 AND 12),
     class_name TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_students_class
     ON students (school_name, grade_level, class_name, admin_zone)`,
  // student_grades / attendance / weekly are created AFTER legacy renames below.
  `CREATE TABLE IF NOT EXISTS teacher_classes (
     teacher_id INTEGER NOT NULL, grade_level INTEGER NOT NULL,
     class_name TEXT NOT NULL, subject_name TEXT NOT NULL,
     PRIMARY KEY (teacher_id, grade_level, class_name, subject_name)
   )`,
  `CREATE TABLE IF NOT EXISTS activity_logs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ssn_encrypted TEXT NOT NULL, action_type INTEGER NOT NULL, metadata TEXT,
     logged_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_logs_ssn_time ON activity_logs (ssn_encrypted, logged_at DESC)`,
  `CREATE TABLE IF NOT EXISTS portal_meta (
     key TEXT PRIMARY KEY, value TEXT NOT NULL,
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
];

const NEW_GRADE_DDL = [
  `CREATE TABLE IF NOT EXISTS student_grades (
     ssn_encrypted TEXT NOT NULL, subject_name TEXT NOT NULL, grade_value TEXT NOT NULL,
     updated_by INTEGER, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (ssn_encrypted, subject_name)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_grades_cover
     ON student_grades (ssn_encrypted, subject_name, grade_value, updated_by, updated_at)`,
];
const NEW_ATTENDANCE_DDL = [
  `CREATE TABLE IF NOT EXISTS attendance (
     ssn_encrypted TEXT NOT NULL, date TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('present','absent','late','excused')),
     note TEXT, PRIMARY KEY (ssn_encrypted, date)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_attendance_ssn ON attendance (ssn_encrypted)`,
];
const NEW_WEEKLY_DDL = [
  `CREATE TABLE IF NOT EXISTS weekly_assessments (
     ssn_encrypted TEXT NOT NULL, subject_name TEXT NOT NULL, week_number INTEGER NOT NULL,
     score REAL NOT NULL, max_score REAL NOT NULL DEFAULT 10,
     PRIMARY KEY (ssn_encrypted, subject_name, week_number)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_weekly_ssn ON weekly_assessments (ssn_encrypted)`,
];

const TRIGGER_DDL = [
  `DROP TRIGGER IF EXISTS staff_updated_at`,
  `CREATE TRIGGER staff_updated_at AFTER UPDATE ON staff
     FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
     BEGIN UPDATE staff SET updated_at = datetime('now') WHERE rowid = NEW.rowid; END`,
  `DROP TRIGGER IF EXISTS students_updated_at`,
  `CREATE TRIGGER students_updated_at AFTER UPDATE ON students
     FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
     BEGIN UPDATE students SET updated_at = datetime('now') WHERE rowid = NEW.rowid; END`,
];

const TEACHER_DDL = [
  `CREATE TABLE IF NOT EXISTS teacher_accounts (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL, phone TEXT, subject TEXT,
     is_verified INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ta_pending ON teacher_accounts (is_verified, created_at)`,
  `CREATE TABLE IF NOT EXISTS teacher_student_relations (
     teacher_id TEXT NOT NULL, student_id TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (teacher_id, student_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tsr_student ON teacher_student_relations (student_id)`,
  `DROP TRIGGER IF EXISTS teacher_accounts_updated_at`,
  `CREATE TRIGGER teacher_accounts_updated_at AFTER UPDATE ON teacher_accounts
     FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
     BEGIN UPDATE teacher_accounts SET updated_at = datetime('now') WHERE id = NEW.id; END`,
];

// ── introspection helpers ──────────────────────────────────────
async function tableExists(db, name) {
  const { rows } = await exec(db, `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, [name]);
  return rows.length > 0;
}
async function columnsOf(db, name) {
  const { rows } = await exec(db, `PRAGMA table_info("${name}")`);
  return rows.map((r) => String(r.name));
}
async function getMeta(db, key) {
  try {
    const { rows } = await exec(db, `SELECT value FROM portal_meta WHERE key=?`, [key]);
    return rows.length ? String(rows[0].value) : null;
  } catch { return null; }
}
async function setMeta(db, key, value) {
  await exec(db, `INSERT INTO portal_meta(key,value,updated_at) VALUES(?,?,datetime('now'))
                  ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`, [key, String(value)]);
}
function parseJson(raw, fallback) {
  try { return typeof raw === 'string' && raw ? JSON.parse(raw) : fallback; }
  catch { return fallback; }
}

/**
 * If a legacy table (old shape) occupies a name we now use, rename it aside so
 * the new-shape CREATE can proceed. Detection by a column that only the old
 * shape has (e.g. 'grade_level' on student_grades, 'id' on attendance/weekly).
 * @param {RawDb} db @param {string} table @param {string} legacyMarkerCol
 */
async function renameLegacyShape(db, table, legacyMarkerCol) {
  if (!(await tableExists(db, table))) return false;
  const cols = await columnsOf(db, table);
  if (!cols.includes(legacyMarkerCol)) return false; // already new-shape (or compatible)
  const legacy = `${table}_legacy`;
  await exec(db, `ALTER TABLE "${table}" RENAME TO "${legacy}"`);
  logger.info('Renamed legacy table aside', { from: table, to: legacy });
  return true;
}

/** Seed the governorates reference table (27 governorates). @param {RawDb} db */
async function seedGovernorates(db) {
  const { GOVERNORATES } = require('../utils/governorates');
  const rows = GOVERNORATES.map((g) => ({ sql: `INSERT OR IGNORE INTO governorates(gov_code,name_ar) VALUES(?,?)`, args: [g.code, g.name] }));
  await db.batch(rows, 'write');
}

/** Back-fill the schools dimension table from students + staff. @param {RawDb} db */
async function backfillSchools(db) {
  await exec(db, `INSERT OR IGNORE INTO schools(gov_code,admin_zone,school_name)
      SELECT DISTINCT COALESCE(gov_code,''), COALESCE(admin_zone,''), school_name
        FROM students
       WHERE school_name IS NOT NULL AND school_name <> 'ALL' AND COALESCE(admin_zone,'') <> ''`);
  await exec(db, `INSERT OR IGNORE INTO schools(gov_code,admin_zone,school_name)
      SELECT DISTINCT COALESCE(gov_code,''), COALESCE(admin_zone,''), school_name
        FROM staff
       WHERE school_name IS NOT NULL AND school_name <> 'ALL' AND COALESCE(admin_zone,'') <> ''`);
}

/** Copy the legacy `teachers` table into `staff` (id-preserving), then drop it. @param {RawDb} db */
async function migrateTeachersToStaff(db) {
  if (!(await tableExists(db, 'teachers'))) return;
  try {
    await exec(db, `INSERT OR IGNORE INTO staff
        (staff_id, username, password_hash, display_name, role, gov_code, admin_zone, school_name, is_active, created_at, updated_at)
        SELECT teacher_id, username, password_hash, teacher_name_ar, role, gov_code, admin_zone, school_name,
               COALESCE(is_active,1), created_at, updated_at FROM teachers`);
    logger.info('Migrated teachers → staff', {});
    await exec(db, `DROP TABLE teachers`);
  } catch (error) {
    logger.warn('teachers→staff migration step skipped', { message: error.message });
  }
}

/** Copy renamed legacy normalized tables into the new tables. @param {RawDb} db */
async function copyLegacyTables(db) {
  if (await tableExists(db, 'student_grades_legacy')) {
    try {
      await exec(db, `INSERT OR IGNORE INTO student_grades(ssn_encrypted,subject_name,grade_value)
          SELECT ssn_encrypted, subject_name, grade_value FROM student_grades_legacy
           WHERE subject_name IS NOT NULL AND grade_value IS NOT NULL`);
    } catch (error) { logger.warn('legacy student_grades copy skipped', { message: error.message }); }
  }
  if (await tableExists(db, 'student_attendance_legacy')) {
    try {
      await exec(db, `INSERT OR IGNORE INTO attendance(ssn_encrypted,date,status,note)
          SELECT ssn_encrypted, date, status, note FROM student_attendance_legacy
           WHERE status IN ('present','absent','late','excused')`);
    } catch (error) { logger.warn('legacy attendance copy skipped', { message: error.message }); }
  }
  if (await tableExists(db, 'weekly_assessments_legacy')) {
    try {
      await exec(db, `INSERT OR IGNORE INTO weekly_assessments(ssn_encrypted,subject_name,week_number,score,max_score)
          SELECT ssn_encrypted, subject_name, week_number, score, COALESCE(max_score,10)
            FROM weekly_assessments_legacy`);
    } catch (error) { logger.warn('legacy weekly copy skipped', { message: error.message }); }
  }
}

/**
 * Explode the legacy v3 JSON columns (grades_json / attendance_json /
 * weekly_json) on each students row into the normalized tables. Idempotent via
 * INSERT OR IGNORE. Uses one batch per student.
 * @param {RawDb} db
 */
async function explodeStudentJson(db) {
  const { rows } = await exec(db, `SELECT ssn_encrypted, grades_json, attendance_json, weekly_json FROM students`);
  let students = rows.length;
  let grades = 0, attendance = 0, weekly = 0;
  const STATUS = new Set(['present', 'absent', 'late', 'excused']);
  for (const r of rows) {
    /** @type {{sql:string,args:any[]}[]} */
    const stmts = [];
    const ssn = String(r.ssn_encrypted);

    const gradesObj = parseJson(r.grades_json, {});
    if (gradesObj && typeof gradesObj === 'object') {
      for (const [subject, value] of Object.entries(gradesObj)) {
        if (subject && value !== null && value !== undefined && value !== '') {
          stmts.push({ sql: `INSERT OR IGNORE INTO student_grades(ssn_encrypted,subject_name,grade_value) VALUES(?,?,?)`, args: [ssn, String(subject), String(value)] });
          grades++;
        }
      }
    }
    const attendanceArr = parseJson(r.attendance_json, []);
    if (Array.isArray(attendanceArr)) {
      for (const a of attendanceArr) {
        const status = String(a && a.status || '').toLowerCase();
        const date = a && a.date ? String(a.date) : null;
        if (date && STATUS.has(status)) {
          stmts.push({ sql: `INSERT OR IGNORE INTO attendance(ssn_encrypted,date,status,note) VALUES(?,?,?,?)`, args: [ssn, date, status, a.note ? String(a.note) : null] });
          attendance++;
        }
      }
    }
    const weeklyObj = parseJson(r.weekly_json, {});
    if (weeklyObj && typeof weeklyObj === 'object') {
      for (const [subject, arr] of Object.entries(weeklyObj)) {
        if (Array.isArray(arr)) {
          for (const w of arr) {
            const week = Number(w && w.week);
            const score = Number(w && w.score);
            if (subject && Number.isInteger(week) && Number.isFinite(score)) {
              stmts.push({ sql: `INSERT OR IGNORE INTO weekly_assessments(ssn_encrypted,subject_name,week_number,score,max_score) VALUES(?,?,?,?,?)`,
                args: [ssn, String(subject), week, score, Number.isFinite(Number(w.max_score)) ? Number(w.max_score) : 10] });
              weekly++;
            }
          }
        }
      }
    }
    if (stmts.length > 0) {
      try { await db.batch(stmts, 'write'); } catch (error) { logger.warn('JSON explode batch failed for student', { ssn, message: error.message }); }
    }
  }
  logger.info('Exploded legacy student JSON into normalized tables', { students, grades, attendance, weekly });
}

/** Seed default schedule/announcements blobs only if absent. @param {RawDb} db */
async function seedPortalMetaDefaults(db) {
  await exec(db, `INSERT OR IGNORE INTO portal_meta(key,value,updated_at) VALUES('announcements','[]',datetime('now'))`);
  for (let g = 1; g <= 12; g++) {
    await exec(db, `INSERT OR IGNORE INTO portal_meta(key,value,updated_at) VALUES(?,'{}',datetime('now'))`, [`schedule:${g}`]);
  }
}

/**
 * Full student-DB migration. Idempotent + safe. Never throws (logs + continues).
 * @param {RawDb} db
 */
async function runMigrations(db) {
  try {
    // 1. Rename any old-shape tables that collide with new names, BEFORE creating.
    await renameLegacyShape(db, 'student_grades', 'grade_level');
    await renameLegacyShape(db, 'attendance', 'id');
    await renameLegacyShape(db, 'weekly_assessments', 'id');

    // 2. Create the new schema (IF NOT EXISTS).
    for (const sql of [...STUDENT_DDL, ...NEW_GRADE_DDL, ...NEW_ATTENDANCE_DDL, ...NEW_WEEKLY_DDL, ...TRIGGER_DDL]) {
      await exec(db, sql);
    }
    await seedGovernorates(db);

    const version = await getMeta(db, 'schema_version');
    const firstRun = version !== SCHEMA_VERSION;

    // Copy aside any legacy normalized tables into the new ones.
    await copyLegacyTables(db);

    if (firstRun) {
      logger.info(`Running v${SCHEMA_VERSION} one-time data migration`, { previous: version });
      await migrateTeachersToStaff(db);
      await backfillSchools(db);
      await explodeStudentJson(db);
      await seedPortalMetaDefaults(db);
      await setMeta(db, 'schema_version', SCHEMA_VERSION);
      logger.info(`Schema v${SCHEMA_VERSION} migration complete`, {});
    }

    // Refresh planner stats so reads pick the optimal index.
    try { await exec(db, 'ANALYZE'); } catch { /* non-fatal */ }
    logger.info('Student database schema ready', { version: SCHEMA_VERSION });
  } catch (error) {
    logger.error('Student migration error', { message: error.message, stack: error.stack });
  }
}

/** Teacher-DB bootstrap. Idempotent. @param {RawDb} db */
async function runTeacherMigrations(db) {
  try {
    for (const sql of TEACHER_DDL) await exec(db, sql);
    logger.info('Teacher database schema ready', {});
  } catch (error) {
    logger.error('Teacher migration error', { message: error.message });
  }
}

module.exports = { runMigrations, runTeacherMigrations, SCHEMA_VERSION };
