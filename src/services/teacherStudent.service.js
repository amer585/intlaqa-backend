'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════
 * TEACHER → STUDENT BRIDGE  (v6)
 * ════════════════════════════════════════════════════════════════════════
 *
 * ARCHITECTURE CONTRACT (the whole point of this file)
 *
 *   TEACHER DB  (TEACHER_DATABASE_URL / TEACHER_DATABASE_TOKEN)
 *     • teacher_accounts            → identity ONLY (name/email/hash/verify)
 *     • teacher_student_relations   → a pointer list: (teacher_id, student_id)
 *     ⇒ It NEVER stores a student's name, school, grade, class, grade values
 *       or attendance. Not one column.
 *
 *   STUDENT DB  (DATABASE_URL / TURSO_AUTH_TOKEN)
 *     • students / student_grades / attendance / weekly_assessments
 *     ⇒ THE single source of truth for every student fact. When a teacher
 *       "adds a student", the row is INSERTed HERE. When a teacher edits a
 *       student, the UPDATE lands HERE. When a teacher reads a student, the
 *       row is IMPORTED from HERE (cross-database) and then CACHED.
 *
 *   THIS BACKEND owns: minting (student ids + JWTs), edit, read, cache and
 *   security. Clients (web + Android) hold nothing but a short-lived JWT —
 *   no database URL, no Turso token, no direct DB access whatsoever.
 *
 * SECURITY MODEL
 *   1. authenticateToken   → a valid signed JWT (JWT_SECRET).
 *   2. requireTeacherAccount → the JWT type must be 'teacher_account'.
 *   3. assertOwnsStudent   → the (teacher_id, student_id) relation MUST exist
 *      in the TEACHER DB before any student read/write is allowed. A teacher
 *      can therefore never touch a student they haven't imported — even by
 *      guessing a 14-digit id.
 *   4. Only verified (is_verified=1) accounts can obtain a token at all
 *      (enforced in teacherAccount.service.loginTeacher).
 *
 * CACHE MODEL (cache-aside, Redis-primary with disk fallback)
 *   teacher:<tid>:students          enriched roster        (300s)
 *   teacher:<tid>:student:<sid>     one full student view  (180s)
 *   teacher:<tid>:search:<hash>     search result page     (60s)
 *   Every write path busts the exact keys it invalidates (plus the student
 *   portal snapshots owned by studentPortal.service) so a teacher never sees
 *   its own stale write.
 */

const crypto = require('crypto');

const { config } = require('../config/env');
const {
  withConnection,
  withTeacherConnection,
  inPlaceholders,
} = require('../db/client');
const {
  getCacheAsync,
  setCache,
  invalidate,
  invalidateBatch,
  invalidatePrefix,
} = require('../db/diskCache');
const { redisDel } = require('../db/redis');
const AppError = require('../lib/AppError');
const logger = require('../lib/logger');
const { ensureSchool } = require('./school.service');
const { resolveGovCode } = require('../utils/governorates');
const {
  requireFields,
  assert14DigitSsn,
  assertGradeLevel,
  normalizeGender,
} = require('../utils/validation');
const { requireTeacherId } = require('./teacherAccount.service');

const ROSTER_TTL_SEC = 300;
const STUDENT_TTL_SEC = 180;
const SEARCH_TTL_SEC = 60;
const MAX_SEARCH_RESULTS = 50;
const ATTENDANCE_STATUSES = new Set(['present', 'absent', 'late', 'excused']);
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/* ── cache keys ───────────────────────────────────────────── */

const rosterKey = (tid) => `teacher:${tid}:students`;
const studentKey = (tid, sid) => `teacher:${tid}:student:${sid}`;
const searchKey = (tid, fingerprint) => `teacher:${tid}:search:${fingerprint}`;

function fingerprint(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

/** Guard: the student DB must be reachable for anything in this module. */
function ensureStudentDb() {
  if (!config.dbAvailable) {
    throw new AppError(503, 'قاعدة بيانات الطلاب غير مُهيّأة. (Student database not configured)');
  }
}

function ensureTeacherDb() {
  if (!config.teacherDbAvailable) {
    throw new AppError(503, 'قاعدة بيانات المعلّمين غير مُهيّأة. (Teacher database not configured)');
  }
}

/* ── security: relation ownership ─────────────────────────── */

/**
 * SECURITY GATE. Throws 403 unless the (teacher_id, student_id) relation
 * exists in the TEACHER DB. Every teacher-scoped student read/write calls it.
 * @param {string} teacherId @param {string} studentId
 */
async function assertOwnsStudent(teacherId, studentId) {
  ensureTeacherDb();
  const owns = await withTeacherConnection(async (db) => {
    const { rows } = await db.execute(
      `SELECT 1 AS ok FROM teacher_student_relations
        WHERE teacher_id = ? AND student_id = ? LIMIT 1`,
      [teacherId, studentId],
    );
    return rows.length > 0;
  });
  if (!owns) {
    throw new AppError(403, 'This student is not in your roster. Import the student first.', {
      student_id: studentId,
    });
  }
  return true;
}

/**
 * Bust every cache key affected by a mutation of one student. Includes the
 * rosters of EVERY teacher that imported them (reverse lookup via
 * idx_tsr_student) plus the student-portal + student-login snapshots.
 * @param {string} studentId @param {number|null} gradeLevel
 */
async function bustStudentCaches(studentId, gradeLevel = null) {
  /** @type {string[]} */
  const keys = [];
  if (config.teacherDbAvailable) {
    try {
      const owners = await withTeacherConnection(async (db) => {
        const { rows } = await db.execute(
          `SELECT teacher_id FROM teacher_student_relations WHERE student_id = ? LIMIT 500`,
          [studentId],
        );
        return rows.map((r) => String(r.teacher_id));
      });
      for (const tid of owners) {
        keys.push(rosterKey(tid), studentKey(tid, studentId));
      }
    } catch (error) {
      logger.warn('Could not enumerate relation owners for cache bust', { message: error.message });
    }
  }
  if (keys.length > 0) await invalidateBatch(keys);
  await invalidatePrefix(`portal:${studentId}:`);
  if (gradeLevel) await redisDel(`student:${gradeLevel}:${studentId}`);
}

/* ── shape helpers ────────────────────────────────────────── */

function shapeProfile(row) {
  if (!row) return null;
  return {
    student_id: String(row.ssn_encrypted),
    ssn_encrypted: String(row.ssn_encrypted),
    student_name_ar: row.student_name_ar ?? null,
    gender: row.gender ?? null,
    gov_code: row.gov_code ?? null,
    admin_zone: row.admin_zone ?? null,
    school_name: row.school_name ?? null,
    grade_level: row.grade_level === null || row.grade_level === undefined ? null : Number(row.grade_level),
    class_name: row.class_name ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

const PROFILE_COLUMNS = `ssn_encrypted, student_name_ar, gender, gov_code, admin_zone,
                         school_name, grade_level, class_name, created_at, updated_at`;

/** Read one student profile straight from the STUDENT DB. @param {string} studentId */
async function readStudentRow(studentId) {
  return withConnection(async (db) => {
    const { rows } = await db.execute(
      `SELECT ${PROFILE_COLUMNS} FROM students WHERE ssn_encrypted = ? LIMIT 1`,
      [studentId],
    );
    return rows.length > 0 ? rows[0] : null;
  });
}

/* ══════════════════════════════════════════════════════════ */
/* 1. SEARCH — the STUDENT DB is the only place we look.      */
/* ══════════════════════════════════════════════════════════ */

/**
 * Search the STUDENT database so a teacher can find a student that is NOT in
 * their own database. Matching is by exact 14-digit id, or partial Arabic
 * name, narrowed by optional school / grade / class filters.
 *
 * The result is cached per teacher (short TTL) — the search box is typed into
 * repeatedly and every keystroke would otherwise cost a remote Turso read.
 *
 * @param {{ q?: string, school_name?: string, grade_level?: unknown, class_name?: string, limit?: unknown }} query
 * @param {{ teacher_account_id?: string }} user
 */
async function searchStudents(query = {}, user = {}) {
  const teacherId = requireTeacherId(user);
  ensureStudentDb();

  const q = String(query.q ?? '').trim();
  const school = query.school_name ? String(query.school_name).trim() : null;
  const className = query.class_name ? String(query.class_name).trim() : null;
  const grade = query.grade_level === undefined || query.grade_level === null || query.grade_level === ''
    ? null
    : assertGradeLevel(query.grade_level);
  const limitRaw = Number(query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(Math.trunc(limitRaw), MAX_SEARCH_RESULTS)
    : 25;

  if (!q && !school && !className && grade === null) {
    throw new AppError(400, 'Provide a search term (q) or at least one filter (school_name / grade_level / class_name).');
  }

  const cacheKey = searchKey(teacherId, fingerprint({ q, school, className, grade, limit }));
  const cached = await getCacheAsync(cacheKey);
  if (cached && Array.isArray(cached.results)) return { ...cached, cached: true };

  /** @type {string[]} */
  const where = [];
  /** @type {unknown[]} */
  const args = [];

  if (q) {
    if (/^\d{14}$/.test(q)) {
      where.push('ssn_encrypted = ?');
      args.push(q);
    } else if (/^\d+$/.test(q)) {
      where.push('ssn_encrypted LIKE ?');
      args.push(`${q}%`);
    } else {
      where.push('student_name_ar LIKE ?');
      args.push(`%${q}%`);
    }
  }
  if (school) { where.push('school_name = ?'); args.push(school); }
  if (grade !== null) { where.push('grade_level = ?'); args.push(grade); }
  if (className) { where.push('class_name = ?'); args.push(className); }

  try {
    const rows = await withConnection(async (db) => {
      const result = await db.execute(
        `SELECT ${PROFILE_COLUMNS} FROM students
          WHERE ${where.join(' AND ')}
          ORDER BY student_name_ar ASC
          LIMIT ?`,
        [...args, limit],
      );
      return result.rows;
    });

    // Flag which hits are already in this teacher's roster so the UI can show
    // "imported" vs "import" without a second call.
    /** @type {Set<string>} */
    let linked = new Set();
    if (config.teacherDbAvailable && rows.length > 0) {
      try {
        const ids = rows.map((r) => String(r.ssn_encrypted));
        linked = await withTeacherConnection(async (db) => {
          const { rows: rel } = await db.execute(
            `SELECT student_id FROM teacher_student_relations
              WHERE teacher_id = ? AND student_id IN (${inPlaceholders(ids.length)})`,
            [teacherId, ...ids],
          );
          return new Set(rel.map((r) => String(r.student_id)));
        });
      } catch (error) {
        logger.warn('Search link-flag lookup failed', { message: error.message });
      }
    }

    const results = rows.map((r) => ({
      ...shapeProfile(r),
      imported: linked.has(String(r.ssn_encrypted)),
    }));
    const payload = { query: { q, school_name: school, grade_level: grade, class_name: className }, count: results.length, results };
    await setCache(cacheKey, payload, SEARCH_TTL_SEC);
    return { ...payload, cached: false };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Student search failed', error.message);
  }
}

/* ══════════════════════════════════════════════════════════ */
/* 2. IMPORT — copy the pointer, cache the data.              */
/* ══════════════════════════════════════════════════════════ */

/**
 * Import an EXISTING student (found in the STUDENT DB) into the teacher's
 * roster. Only the pointer (teacher_id, student_id) is written to the TEACHER
 * DB; the student's data is read from the STUDENT DB and warmed into the
 * cache so the next dashboard render is instant.
 *
 * @param {{ student_id?: string, ssn_encrypted?: string }} payload
 * @param {{ teacher_account_id?: string }} user
 */
async function importStudent(payload = {}, user = {}) {
  const teacherId = requireTeacherId(user);
  ensureTeacherDb();
  ensureStudentDb();

  const raw = payload.student_id ?? payload.ssn_encrypted;
  requireFields({ student_id: raw }, ['student_id'], 'student_id is required.');
  const studentId = String(raw).trim();
  assert14DigitSsn(studentId);

  try {
    // 1. The student MUST already exist in the STUDENT DB — we import, never invent.
    const row = await readStudentRow(studentId);
    if (!row) {
      throw new AppError(404, 'No student with that id exists in the student database.', { student_id: studentId });
    }

    // 2. Write ONLY the relation into the TEACHER DB.
    await withTeacherConnection(async (db) => {
      await db.execute(
        `INSERT INTO teacher_student_relations (teacher_id, student_id) VALUES (?, ?)
         ON CONFLICT(teacher_id, student_id) DO NOTHING`,
        [teacherId, studentId],
      );
    });

    // 3. Warm the per-student cache + drop the stale roster/search caches.
    const profile = shapeProfile(row);
    await invalidateBatch([rosterKey(teacherId), studentKey(teacherId, studentId)]);
    await invalidatePrefix(`teacher:${teacherId}:search:`);
    await setCache(studentKey(teacherId, studentId), { student: profile, grades: [], attendance: [], weekly: [] }, STUDENT_TTL_SEC);

    logger.info('Teacher imported student from student DB', { teacherId, studentId });
    return {
      message: 'Student imported from the student database into your roster.',
      imported: true,
      source: 'student_database',
      student: profile,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Failed to import student', error.message);
  }
}

/* ══════════════════════════════════════════════════════════ */
/* 3. ADD — a new student is MINTED INTO THE STUDENT DB.      */
/* ══════════════════════════════════════════════════════════ */

/**
 * A teacher adds a brand-new student. Whether the teacher is adding or
 * importing, THE STUDENT ROW IS SAVED IN THE STUDENT DATABASE — never in the
 * teacher DB. The teacher DB only receives the relation pointer afterwards.
 *
 * The backend mints the identifier when the client doesn't supply one, so the
 * client can never choose a colliding / malicious id.
 *
 * @param {{ ssn_encrypted?: string, student_name_ar?: string, gender?: string,
 *           grade_level?: unknown, class_name?: string, school_name?: string,
 *           admin_zone?: string, gov_code?: string }} payload
 * @param {{ teacher_account_id?: string }} user
 */
async function addStudent(payload = {}, user = {}) {
  const teacherId = requireTeacherId(user);
  ensureTeacherDb();
  ensureStudentDb();
  requireFields(payload, ['student_name_ar', 'grade_level'], 'student_name_ar and grade_level are required.');

  const gradeLevel = assertGradeLevel(payload.grade_level);
  const name = String(payload.student_name_ar).trim();
  const gender = normalizeGender(payload.gender);
  const className = payload.class_name ? String(payload.class_name).trim() : null;
  const schoolName = payload.school_name ? String(payload.school_name).trim() : null;
  const adminZone = payload.admin_zone ? String(payload.admin_zone).trim() : null;
  const govCode = resolveGovCode(payload.gov_code);

  // Backend-minted id when absent (14 digits, matching the student token shape).
  let studentId;
  if (payload.ssn_encrypted) {
    studentId = String(payload.ssn_encrypted).trim();
    assert14DigitSsn(studentId);
  } else {
    studentId = mintStudentId();
  }

  try {
    if (schoolName) {
      await ensureSchool({ gov_code: govCode, admin_zone: adminZone, school_name: schoolName });
    }

    // 1. INSERT into the STUDENT DB (source of truth).
    const created = await withConnection(async (db) => {
      const existing = await db.execute(
        `SELECT ssn_encrypted FROM students WHERE ssn_encrypted = ? LIMIT 1`,
        [studentId],
      );
      const isNew = existing.rows.length === 0;
      await db.execute(
        `INSERT INTO students
            (ssn_encrypted, student_name_ar, gender, gov_code, admin_zone, school_name, grade_level, class_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ssn_encrypted) DO UPDATE SET
            student_name_ar = excluded.student_name_ar,
            gender          = COALESCE(excluded.gender, students.gender),
            gov_code        = COALESCE(excluded.gov_code, students.gov_code),
            admin_zone      = COALESCE(excluded.admin_zone, students.admin_zone),
            school_name     = COALESCE(excluded.school_name, students.school_name),
            grade_level     = excluded.grade_level,
            class_name      = COALESCE(excluded.class_name, students.class_name)`,
        [studentId, name, gender, govCode, adminZone, schoolName, gradeLevel, className],
      );
      return isNew;
    });

    // 2. Link the (new) student to the teacher — pointer only.
    await withTeacherConnection(async (db) => {
      await db.execute(
        `INSERT INTO teacher_student_relations (teacher_id, student_id) VALUES (?, ?)
         ON CONFLICT(teacher_id, student_id) DO NOTHING`,
        [teacherId, studentId],
      );
    });

    await bustStudentCaches(studentId, gradeLevel);
    await invalidatePrefix(`teacher:${teacherId}:search:`);

    const row = await readStudentRow(studentId);
    logger.info('Teacher added student (written to student DB)', { teacherId, studentId, created });
    return {
      message: created
        ? 'Student created in the student database and linked to your roster.'
        : 'Student already existed in the student database — updated and linked to your roster.',
      created,
      stored_in: 'student_database',
      student: shapeProfile(row),
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Failed to add student', error.message);
  }
}

/** Mint a random 14-digit student identifier (backend-owned, never client-chosen). */
function mintStudentId() {
  let out = '';
  while (out.length < 14) {
    out += crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  }
  return out.slice(0, 14);
}

/* ══════════════════════════════════════════════════════════ */
/* 4. READ — full student view, imported + cached.            */
/* ══════════════════════════════════════════════════════════ */

/**
 * Read the full academic view of ONE student the teacher owns: profile +
 * grades + attendance + weekly assessments. Every byte comes from the STUDENT
 * DB, is imported cross-database, and is then cached under the teacher's key.
 *
 * @param {string} studentId
 * @param {{ teacher_account_id?: string }} user
 */
async function getStudentDetail(studentId, user = {}) {
  const teacherId = requireTeacherId(user);
  ensureStudentDb();
  if (!studentId) throw new AppError(400, 'student_id is required.');
  const sid = String(studentId).trim();
  await assertOwnsStudent(teacherId, sid);

  const key = studentKey(teacherId, sid);
  const cached = await getCacheAsync(key);
  if (cached && cached.student && Array.isArray(cached.grades)) {
    return { ...cached, cached: true };
  }

  try {
    const data = await withConnection(async (db) => {
      const profile = await db.execute(
        `SELECT ${PROFILE_COLUMNS} FROM students WHERE ssn_encrypted = ? LIMIT 1`,
        [sid],
      );
      if (profile.rows.length === 0) {
        throw new AppError(404, 'Student no longer exists in the student database.', { student_id: sid });
      }
      const grades = await db.execute(
        `SELECT subject_name, grade_value, updated_at FROM student_grades
          WHERE ssn_encrypted = ? ORDER BY subject_name ASC`,
        [sid],
      );
      const attendance = await db.execute(
        `SELECT date, status, note FROM attendance
          WHERE ssn_encrypted = ? ORDER BY date DESC LIMIT 120`,
        [sid],
      );
      const weekly = await db.execute(
        `SELECT subject_name, week_number, score, max_score FROM weekly_assessments
          WHERE ssn_encrypted = ? ORDER BY subject_name ASC, week_number ASC`,
        [sid],
      );
      return {
        student: shapeProfile(profile.rows[0]),
        grades: grades.rows.map((r) => ({
          subject_name: String(r.subject_name),
          grade_value: String(r.grade_value),
          updated_at: r.updated_at ?? null,
        })),
        attendance: attendance.rows.map((r) => ({
          date: String(r.date),
          status: String(r.status),
          note: r.note ?? null,
        })),
        weekly: weekly.rows.map((r) => ({
          subject_name: String(r.subject_name),
          week_number: Number(r.week_number),
          score: Number(r.score),
          max_score: Number(r.max_score),
        })),
      };
    });

    await setCache(key, data, STUDENT_TTL_SEC);
    return { ...data, cached: false };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Failed to read student', error.message);
  }
}

/* ══════════════════════════════════════════════════════════ */
/* 5. EDIT — the UPDATE lands in the STUDENT DB.              */
/* ══════════════════════════════════════════════════════════ */

/**
 * Edit a student the teacher owns. The write targets the STUDENT DB; the
 * teacher DB is untouched. All affected caches (this teacher's, every OTHER
 * teacher that imported the same student, and the student portal) are busted.
 *
 * @param {string} studentId
 * @param {{ student_name_ar?: string, gender?: string, grade_level?: unknown,
 *           class_name?: string, school_name?: string, admin_zone?: string, gov_code?: string }} payload
 * @param {{ teacher_account_id?: string }} user
 */
async function updateStudent(studentId, payload = {}, user = {}) {
  const teacherId = requireTeacherId(user);
  ensureStudentDb();
  if (!studentId) throw new AppError(400, 'student_id is required.');
  const sid = String(studentId).trim();
  await assertOwnsStudent(teacherId, sid);

  const name = payload.student_name_ar !== undefined ? String(payload.student_name_ar).trim() || null : null;
  const gender = payload.gender !== undefined ? normalizeGender(payload.gender) : null;
  const grade = payload.grade_level !== undefined && payload.grade_level !== null && payload.grade_level !== ''
    ? assertGradeLevel(payload.grade_level)
    : null;
  const className = payload.class_name !== undefined ? String(payload.class_name).trim() || null : null;
  const schoolName = payload.school_name !== undefined ? String(payload.school_name).trim() || null : null;
  const adminZone = payload.admin_zone !== undefined ? String(payload.admin_zone).trim() || null : null;
  const govCode = payload.gov_code !== undefined ? resolveGovCode(payload.gov_code) : null;

  if ([name, gender, grade, className, schoolName, adminZone, govCode].every((v) => v === null)) {
    throw new AppError(400, 'Nothing to update. Provide at least one editable field.');
  }

  try {
    if (schoolName) {
      await ensureSchool({ gov_code: govCode, admin_zone: adminZone, school_name: schoolName });
    }
    const affected = await withConnection(async (db) => {
      const rs = await db.execute(
        `UPDATE students SET
            student_name_ar = COALESCE(?, student_name_ar),
            gender          = COALESCE(?, gender),
            grade_level     = COALESCE(?, grade_level),
            class_name      = COALESCE(?, class_name),
            school_name     = COALESCE(?, school_name),
            admin_zone      = COALESCE(?, admin_zone),
            gov_code        = COALESCE(?, gov_code)
          WHERE ssn_encrypted = ?`,
        [name, gender, grade, className, schoolName, adminZone, govCode, sid],
      );
      return rs.rowsAffected;
    });
    if (affected === 0) {
      throw new AppError(404, 'Student not found in the student database.', { student_id: sid });
    }

    const row = await readStudentRow(sid);
    const profile = shapeProfile(row);
    await bustStudentCaches(sid, profile ? profile.grade_level : null);

    logger.info('Teacher edited student in student DB', { teacherId, studentId: sid });
    return { message: 'Student updated in the student database.', stored_in: 'student_database', student: profile };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Failed to update student', error.message);
  }
}

/* ══════════════════════════════════════════════════════════ */
/* 6. GRADES + ATTENDANCE — also STUDENT DB writes.           */
/* ══════════════════════════════════════════════════════════ */

/**
 * Upsert grades for an owned student. Accepts a single {subject_name,
 * grade_value} or an array of them. Written to student_grades in the STUDENT DB.
 * @param {string} studentId
 * @param {unknown} payload
 * @param {{ teacher_account_id?: string }} user
 */
async function setStudentGrades(studentId, payload, user = {}) {
  const teacherId = requireTeacherId(user);
  ensureStudentDb();
  const sid = String(studentId || '').trim();
  if (!sid) throw new AppError(400, 'student_id is required.');
  await assertOwnsStudent(teacherId, sid);

  const list = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.grades) ? payload.grades : [payload]);
  /** @type {{ subject: string, value: string }[]} */
  const entries = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const subject = String(item.subject_name ?? '').trim();
    const value = item.grade_value === undefined || item.grade_value === null ? '' : String(item.grade_value).trim();
    if (!subject) throw new AppError(400, 'subject_name is required for every grade entry.');
    if (value === '') throw new AppError(400, `grade_value is required for subject "${subject}".`);
    if (value.length > 16) throw new AppError(400, `grade_value for "${subject}" is too long.`);
    entries.push({ subject, value });
  }
  if (entries.length === 0) throw new AppError(400, 'No grade entries supplied.');

  try {
    await withConnection(async (db) => {
      for (const e of entries) {
        await db.execute(
          `INSERT INTO student_grades (ssn_encrypted, subject_name, grade_value, updated_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(ssn_encrypted, subject_name) DO UPDATE SET
              grade_value = excluded.grade_value,
              updated_at  = datetime('now')`,
          [sid, e.subject, e.value],
        );
      }
    });
    await bustStudentCaches(sid);
    logger.info('Teacher wrote grades to student DB', { teacherId, studentId: sid, count: entries.length });
    return { message: 'Grades saved to the student database.', updated: entries.length, stored_in: 'student_database' };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Failed to save grades', error.message);
  }
}

/**
 * Upsert one attendance record for an owned student (STUDENT DB write).
 * @param {string} studentId
 * @param {{ date?: string, status?: string, note?: string }} payload
 * @param {{ teacher_account_id?: string }} user
 */
async function setStudentAttendance(studentId, payload = {}, user = {}) {
  const teacherId = requireTeacherId(user);
  ensureStudentDb();
  const sid = String(studentId || '').trim();
  if (!sid) throw new AppError(400, 'student_id is required.');
  await assertOwnsStudent(teacherId, sid);

  requireFields(payload, ['status'], 'status is required (present|absent|late|excused).');
  const status = String(payload.status).trim().toLowerCase();
  if (!ATTENDANCE_STATUSES.has(status)) {
    throw new AppError(400, `Invalid status "${payload.status}". Use present, absent, late or excused.`);
  }
  const date = payload.date ? String(payload.date).trim() : new Date().toISOString().slice(0, 10);
  if (!DATE_REGEX.test(date)) throw new AppError(400, 'date must be formatted YYYY-MM-DD.');
  const note = payload.note ? String(payload.note).trim().slice(0, 240) : null;

  try {
    await withConnection(async (db) => {
      await db.execute(
        `INSERT INTO attendance (ssn_encrypted, date, status, note) VALUES (?, ?, ?, ?)
         ON CONFLICT(ssn_encrypted, date) DO UPDATE SET
            status = excluded.status, note = excluded.note`,
        [sid, date, status, note],
      );
    });
    await bustStudentCaches(sid);
    return { message: 'Attendance saved to the student database.', date, status, stored_in: 'student_database' };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Failed to save attendance', error.message);
  }
}

/* ══════════════════════════════════════════════════════════ */
/* 7. DASHBOARD SUMMARY — one cheap aggregate read.           */
/* ══════════════════════════════════════════════════════════ */

/**
 * Teacher dashboard header stats, derived from the cached roster (so it costs
 * nothing once the roster is warm).
 * @param {{ teacher_account_id?: string }} user
 */
async function getTeacherDashboard(user = {}) {
  const teacherId = requireTeacherId(user);
  ensureTeacherDb();

  const roster = await getCacheAsync(rosterKey(teacherId));
  /** @type {{ student_id: string, grade_level: number|null, class_name: string|null, school_name: string|null }[]} */
  let students = roster && Array.isArray(roster.students) ? roster.students : [];

  if (!roster) {
    const relations = await withTeacherConnection(async (db) => {
      const { rows } = await db.execute(
        `SELECT student_id FROM teacher_student_relations WHERE teacher_id = ? LIMIT 1000`,
        [teacherId],
      );
      return rows.map((r) => String(r.student_id));
    });
    students = [];
    if (relations.length > 0 && config.dbAvailable) {
      const rows = await withConnection(async (db) => {
        const result = await db.execute(
          `SELECT ssn_encrypted, student_name_ar, school_name, grade_level, class_name
             FROM students WHERE ssn_encrypted IN (${inPlaceholders(relations.length)})`,
          relations,
        );
        return result.rows;
      });
      students = rows.map((r) => ({
        student_id: String(r.ssn_encrypted),
        grade_level: r.grade_level === null ? null : Number(r.grade_level),
        class_name: r.class_name ?? null,
        school_name: r.school_name ?? null,
      }));
    }
  }

  const classes = new Set();
  const schools = new Set();
  const grades = new Set();
  for (const s of students) {
    if (s.class_name) classes.add(`${s.grade_level ?? '?'}/${s.class_name}`);
    if (s.school_name) schools.add(String(s.school_name));
    if (s.grade_level) grades.add(Number(s.grade_level));
  }

  return {
    teacher_id: teacherId,
    totals: {
      students: students.length,
      classes: classes.size,
      schools: schools.size,
      grades: Array.from(grades).sort((a, b) => a - b),
    },
    architecture: {
      identity_source: 'teacher_database',
      student_source: 'student_database',
      cache: 'backend (redis + disk)',
    },
  };
}

module.exports = {
  searchStudents,
  importStudent,
  addStudent,
  getStudentDetail,
  updateStudent,
  setStudentGrades,
  setStudentAttendance,
  getTeacherDashboard,
  assertOwnsStudent,
  bustStudentCaches,
  mintStudentId,
};
