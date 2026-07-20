'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { config } = require('../config/env');
const { withConnection, withTeacherConnection, inPlaceholders } = require('../db/client');
const { getCacheAsync, setCache, invalidate } = require('../db/diskCache');
const AppError = require('../lib/AppError');
const logger = require('../lib/logger');
const { normalizeRole } = require('../utils/roles');
const {
  requireFields,
  normalizeEmail,
  assertValidEmail,
  assertStrongPassword,
  isBcryptHash,
} = require('../utils/validation');

/** Detect a libSQL/SQLite unique-constraint (duplicate email). */
function isUniqueViolation(error) {
  if (!error || typeof error !== 'object') return false;
  const code = /** @type {any} */ (error).code;
  const msg = String(/** @type {any} */ (error).message || '');
  return (
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    code === 'SQLITE_CONSTRAINT' ||
    msg.includes('UNIQUE constraint failed')
  );
}

/** Throw a clean 503 when the separate teacher DB isn't configured. */
function ensureTeacherDb() {
  if (!config.teacherDbAvailable) {
    throw new AppError(503, 'قاعدة بيانات المعلّمين غير مُهيّأة. (Teacher database not configured)');
  }
}

/** Strip secrets so they never leave the service layer. */
function sanitize(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone ?? null,
    subject: row.subject ?? null,
    is_verified: Number(row.is_verified) === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Issue a teacher-account JWT (distinct type so it can't be confused with staff). */
function issueToken(account) {
  return jwt.sign(
    {
      type: 'teacher_account',
      teacher_account_id: account.id,
      email: account.email,
      name: account.name,
    },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn },
  );
}

/**
 * Public teacher self-registration. Creates a pending (is_verified=0) account
 * in the TEACHER database. An admin must approve it before login is allowed.
 * @param {{ name?: string, email?: string, password?: string, phone?: string, subject?: string }} payload
 */
async function registerTeacher(payload = {}) {
  ensureTeacherDb();
  requireFields(payload, ['name', 'email', 'password'], 'name, email, and password are required.');
  const name = String(payload.name).trim();
  const email = assertValidEmail(payload.email);
  const password = assertStrongPassword(payload.password);
  const phone = payload.phone ? String(payload.phone).trim() : null;
  const subject = payload.subject ? String(payload.subject).trim() : null;

  const id = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, 12);

  try {
    return await withTeacherConnection(async (db) => {
      await db.execute(
        `INSERT INTO teacher_accounts (id, name, email, password_hash, phone, subject, is_verified)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
        [id, name, email, passwordHash, phone, subject],
      );

      const { rows } = await db.execute(
        `SELECT id, name, email, phone, subject, is_verified, created_at, updated_at
           FROM teacher_accounts WHERE id = ?`,
        [id],
      );
      logger.info('Teacher account registered (pending approval)', { id, email });
      return {
        message: 'Registration received. Your account is pending admin approval.',
        account: sanitize(rows[0]),
      };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (isUniqueViolation(error)) {
      throw new AppError(409, 'A teacher account with this email already exists.');
    }
    throw new AppError(500, 'Failed to register teacher', error.message);
  }
}

/**
 * Authenticate a verified teacher account and issue a JWT (TEACHER DB).
 * Blocked with 403 while is_verified = 0 (pending admin approval).
 * @param {{ email?: string, password?: string }} payload
 */
async function loginTeacher(payload = {}) {
  ensureTeacherDb();
  requireFields(payload, ['email', 'password'], 'email and password are required.');
  const email = assertValidEmail(payload.email);
  const password = String(payload.password);

  try {
    return await withTeacherConnection(async (db) => {
      const { rows } = await db.execute(
        `SELECT id, name, email, phone, subject, password_hash, is_verified, created_at, updated_at
           FROM teacher_accounts
          WHERE email = ?
          LIMIT 1`,
        [email],
      );

      // Same message for "not found" and "bad password" to avoid account enumeration.
      if (rows.length === 0) {
        throw new AppError(401, 'Invalid email or password.');
      }

      const account = rows[0];
      if (!isBcryptHash(account.password_hash)) {
        logger.warn('Teacher login blocked: non-bcrypt password hash', { id: account.id });
        throw new AppError(401, 'Invalid email or password.');
      }

      const valid = await bcrypt.compare(password, account.password_hash);
      if (!valid) {
        throw new AppError(401, 'Invalid email or password.');
      }

      if (Number(account.is_verified) !== 1) {
        throw new AppError(403, 'Your account is pending admin approval. Please try again later.');
      }

      const token = issueToken(account);
      return {
        success: true,
        token,
        account: sanitize(account),
      };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Database query failed', error.message);
  }
}

/** Return the public profile for the authenticated teacher (TEACHER DB). @param {{ teacher_account_id?: string }} user */
async function getTeacherProfile(user = {}) {
  const id = requireTeacherId(user);
  ensureTeacherDb();
  try {
    return await withTeacherConnection(async (db) => {
      const { rows } = await db.execute(
        `SELECT id, name, email, phone, subject, is_verified, created_at, updated_at
           FROM teacher_accounts WHERE id = ?`,
        [id],
      );
      if (rows.length === 0) throw new AppError(404, 'Teacher account not found.');
      return sanitize(rows[0]);
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Database query failed', error.message);
  }
}

/**
 * Update mutable profile fields (TEACHER DB). Email/password are intentionally
 * not editable through this endpoint.
 * @param {{ name?: string, phone?: string, subject?: string }} payload
 * @param {{ teacher_account_id?: string }} user
 */
async function updateTeacherProfile(payload = {}, user = {}) {
  const id = requireTeacherId(user);
  ensureTeacherDb();
  const name = payload.name !== undefined ? String(payload.name).trim() : null;
  const phone = payload.phone !== undefined ? String(payload.phone).trim() || null : null;
  const subject = payload.subject !== undefined ? String(payload.subject).trim() || null : null;

  try {
    return await withTeacherConnection(async (db) => {
      const result = await db.execute(
        `UPDATE teacher_accounts
            SET name   = COALESCE(?, name),
                phone  = COALESCE(?, phone),
                subject = COALESCE(?, subject)
          WHERE id = ?`,
        [name, phone, subject, id],
      );
      if (result.rowsAffected === 0) throw new AppError(404, 'Teacher account not found.');

      const { rows } = await db.execute(
        `SELECT id, name, email, phone, subject, is_verified, created_at, updated_at
           FROM teacher_accounts WHERE id = ?`,
        [id],
      );
      return { message: 'Profile updated.', account: sanitize(rows[0]) };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Failed to update profile', error.message);
  }
}

/** Throw 401 unless the caller is an authenticated teacher account. */
function requireTeacherId(user) {
  const id = user && user.type === 'teacher_account' ? user.teacher_account_id : null;
  if (!id) throw new AppError(401, 'Teacher account authentication required.');
  return String(id);
}

// ── Teacher roster cache (cache-aside, Redis-primary + disk fallback) ──────
// The roster is a CROSS-DATABASE read: relations come from the TEACHER DB and
// the student profiles are imported from the STUDENT DB. That is two remote
// round-trips per dashboard load. The backend owns caching (the web/Android
// clients only hold a JWT), so we cache the fully-enriched roster under
// `teacher:<id>:students` and bust it on every link/unlink write — the same
// read-through pattern the student portal uses (`portal:<ssn>:<grade>`).
const ROSTER_CACHE_TTL_SEC = 300; // matches REDIS_TTL_SEC default

/** @param {string} teacherId */
function rosterCacheKey(teacherId) {
  return `teacher:${teacherId}:students`;
}

/**
 * Link a student (by ssn_encrypted) to the authenticated teacher.
 * Validates the student exists in the STUDENT DB, stores the relation in the
 * TEACHER DB — bridging the two isolated databases.
 * @param {{ student_id?: string }} payload
 * @param {{ teacher_account_id?: string }} user
 */
async function linkStudent(payload = {}, user = {}) {
  const teacherId = requireTeacherId(user);
  ensureTeacherDb();
  requireFields(payload, ['student_id'], 'student_id is required.');
  const studentId = String(payload.student_id).trim();

  try {
    // 1. Confirm the student exists in the STUDENT database.
    if (config.dbAvailable) {
      const exists = await withConnection(async (db) => {
        const { rows } = await db.execute(
          `SELECT ssn_encrypted FROM students WHERE ssn_encrypted = ? LIMIT 1`,
          [studentId],
        );
        return rows.length > 0;
      });
      if (!exists) {
        throw new AppError(404, 'Student not found.', { student_id: studentId });
      }
    } else {
      logger.warn('Student DB unavailable while linking — storing relation without validation', { studentId });
    }

    // 2. Store the relation in the TEACHER database.
    await withTeacherConnection(async (db) => {
      await db.execute(
        `INSERT INTO teacher_student_relations (teacher_id, student_id)
         VALUES (?, ?)
         ON CONFLICT(teacher_id, student_id) DO NOTHING`,
        [teacherId, studentId],
      );
    });

    // 3. Bust the roster cache so the next read re-imports from the STUDENT DB.
    await invalidate(rosterCacheKey(teacherId));

    return { message: 'Student linked.', teacher_id: teacherId, student_id: studentId };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Failed to link student', error.message);
  }
}

/**
 * List all students linked to the authenticated teacher.
 * Reads relations from the TEACHER DB, then enriches them with live student
 * details imported from the STUDENT DB (cross-database, best-effort).
 *
 * The enriched roster is cached (`teacher:<id>:students`, Redis-primary +
 * disk fallback) so a teacher dashboard reload is one cache GET instead of
 * two remote DB round-trips. linkStudent/unlinkStudent bust the key.
 * @param {{ teacher_account_id?: string }} user
 */
async function listTeacherStudents(user = {}) {
  const teacherId = requireTeacherId(user);
  ensureTeacherDb();

  // ── Read-through: serve the enriched roster from cache when fresh ──
  const cacheKey = rosterCacheKey(teacherId);
  const cached = await getCacheAsync(cacheKey);
  if (cached && Array.isArray(cached.students)) {
    return { ...cached, cached: true };
  }

  try {
    // 1. Relations live in the TEACHER DB. LIMIT caps payload size.
    const relations = await withTeacherConnection(async (db) => {
      const { rows } = await db.execute(
        `SELECT student_id, created_at AS linked_at
           FROM teacher_student_relations
          WHERE teacher_id = ?
          ORDER BY created_at DESC
          LIMIT 1000`,
        [teacherId],
      );
      return rows;
    });

    if (relations.length === 0) {
      const empty = { teacher_id: teacherId, students: [] };
      await setCache(cacheKey, empty, ROSTER_CACHE_TTL_SEC);
      return { ...empty, cached: false };
    }

    const studentIds = relations.map((r) => String(r.student_id));

    // 2. Enrich from the STUDENT DB (best-effort if that DB is down).
    /** @type {Map<string, Record<string, unknown>>} */
    const studentDetails = new Map();
    if (config.dbAvailable) {
      try {
        const result = await withConnection(async (db) => {
          const ph = inPlaceholders(studentIds.length);
          return db.execute(
            `SELECT ssn_encrypted, student_name_ar, school_name, grade_level, class_name
               FROM students WHERE ssn_encrypted IN (${ph})`,
            studentIds,
          );
        });
        for (const s of result.rows) studentDetails.set(String(s.ssn_encrypted), s);
      } catch (e) {
        logger.warn('Could not enrich teacher roster from student DB', { message: e.message });
      }
    }

    const students = relations.map((r) => {
      const s = studentDetails.get(String(r.student_id));
      return {
        student_id: r.student_id,
        student_name_ar: s ? (s.student_name_ar ?? null) : null,
        school_name: s ? (s.school_name ?? null) : null,
        grade_level: s ? Number(s.grade_level) : null,
        class_name: s ? (s.class_name ?? null) : null,
        linked_at: r.linked_at,
      };
    });

    // ── Write-through: cache the enriched roster (imported from student DB) ──
    const payload = { teacher_id: teacherId, students };
    await setCache(cacheKey, payload, ROSTER_CACHE_TTL_SEC);
    return { ...payload, cached: false };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Database query failed', error.message);
  }
}

/**
 * Unlink a student from the authenticated teacher (TEACHER DB write), then
 * bust the cached roster so the next read re-imports from the STUDENT DB.
 * The student record itself is NEVER deleted — it lives in the student DB;
 * only the cross-database relation is removed.
 * @param {string} studentId
 * @param {{ teacher_account_id?: string }} user
 */
async function unlinkStudent(studentId, user = {}) {
  const teacherId = requireTeacherId(user);
  ensureTeacherDb();
  if (!studentId) throw new AppError(400, 'student_id is required.');
  const sid = String(studentId).trim();

  try {
    await withTeacherConnection(async (db) => {
      const result = await db.execute(
        `DELETE FROM teacher_student_relations
          WHERE teacher_id = ? AND student_id = ?`,
        [teacherId, sid],
      );
      if (result.rowsAffected === 0) {
        throw new AppError(404, 'That student is not linked to your account.');
      }
    });

    // Bust the roster cache — the next GET re-reads relations + re-imports.
    await invalidate(rosterCacheKey(teacherId));
    logger.info('Teacher unlinked student', { teacherId, studentId: sid });
    return { message: 'Student unlinked.', teacher_id: teacherId, student_id: sid };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Failed to unlink student', error.message);
  }
}

/* ── Admin / approval helpers (staff-only, role-gated) ─────── */

const APPROVAL_ROLES = new Set([
  'admin',
  'principal',
  'directorate',
  'directorate_manager',
  'directorate manager',
  'district',
  'district_manager',
  'district manager',
]);

/** Staff-only: list teacher accounts pending admin approval (TEACHER DB). @param {{ role?: string }} user */
async function listPendingTeachers(user = {}) {
  assertCanApprove(user);
  ensureTeacherDb();
  try {
    return await withTeacherConnection(async (db) => {
      const { rows } = await db.execute(
        `SELECT id, name, email, phone, subject, is_verified, created_at, updated_at
           FROM teacher_accounts
          WHERE is_verified = 0
          ORDER BY created_at ASC
          LIMIT 500`,
      );
      return { pending: rows.map(sanitize) };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Database query failed', error.message);
  }
}

/** Staff-only: approve a teacher account (TEACHER DB). @param {string} id @param {{ role?: string }} user */
async function setTeacherVerification(id, user = {}) {
  assertCanApprove(user);
  ensureTeacherDb();
  if (!id) throw new AppError(400, 'Teacher id is required.');
  try {
    return await withTeacherConnection(async (db) => {
      const result = await db.execute(
        `UPDATE teacher_accounts SET is_verified = 1 WHERE id = ? AND is_verified = 0`,
        [String(id)],
      );
      if (result.rowsAffected === 0) {
        throw new AppError(404, 'No pending teacher found with that id.');
      }
      logger.info('Teacher account approved', { id, approver: user.teacher_id ?? 'unknown' });
      return { message: 'Teacher account approved.', id };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Failed to verify teacher', error.message);
  }
}

function assertCanApprove(user = {}) {
  if (!APPROVAL_ROLES.has(normalizeRole(user.role))) {
    throw new AppError(403, 'Forbidden: admin/principal/manager approval required.');
  }
}

module.exports = {
  registerTeacher,
  loginTeacher,
  getTeacherProfile,
  updateTeacherProfile,
  linkStudent,
  unlinkStudent,
  listTeacherStudents,
  listPendingTeachers,
  setTeacherVerification,
  requireTeacherId,
};
