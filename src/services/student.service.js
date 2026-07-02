'use strict';

const { config, getDbUrl } = require('../config/env');
const { withConnection } = require('../db/client');
const { redisGet, redisSetEx, redisDel } = require('../db/redis');
const AppError = require('../lib/AppError');
const { resolveGovCode, resolveGovName } = require('../utils/governorates');
const { isDistrictManagerRole, normalizeRole } = require('../utils/roles');
const { requireFields, assert14DigitSsn, assertGradeLevel, normalizeGender } = require('../utils/validation');

/**
 * Student "login" = profile lookup by 14-digit token + grade level.
 * Implements cache-aside: Redis first, libSQL second.
 */
async function loginStudent(payload = {}) {
  requireFields(payload, ['ssn_encrypted', 'grade_level'], 'ssn_encrypted and grade_level are required');
  assert14DigitSsn(payload.ssn_encrypted);
  const gradeLevel = assertGradeLevel(payload.grade_level);
  const ssn = String(payload.ssn_encrypted);

  const dbUrl = getDbUrl(gradeLevel);
  if (!dbUrl) {
    if (!config.dbAvailable) {
      throw new AppError(503, 'قاعدة البيانات غير متاحة حالياً. حاول الدخول التجريبي. (Database not configured)');
    }
    throw new AppError(400, `Invalid grade_level: ${payload.grade_level}`);
  }

  // ── Cache-aside: try Redis first ──
  const cacheKey = `student:${gradeLevel}:${ssn}`;
  const cached = await redisGet(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {
      /* ignore corrupt cache, fall through to DB */
    }
  }

  try {
    const result = await withConnection(async (db) => {
      const { rows } = await db.execute(
        `SELECT student_name_ar, school_name, class_name, admin_zone, gov_code, gender
           FROM students
          WHERE ssn_encrypted = ?
          LIMIT 1`,
        [ssn],
      );

      if (rows.length === 0) {
        throw new AppError(404, 'Student ID not found in this grade.', { ssn_encrypted: ssn, grade_level: gradeLevel });
      }

      const s = rows[0];
      return {
        message: 'Login successful',
        student: {
          ssn_encrypted: ssn,
          grade_level: gradeLevel,
          student_name_ar: s.student_name_ar,
          school_name: s.school_name,
          class_name: s.class_name,
          admin_zone: s.admin_zone,
          gov_code: resolveGovName(s.gov_code) || 'القاهرة',
          gender: s.gender,
        },
      };
    });

    await redisSetEx(cacheKey, config.redisTtlSec, JSON.stringify(result));
    return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Database query failed', error.message);
  }
}

/**
 * Create or update a student. Principals are locked to their own school.
 * Invalidates the cache entry on write.
 */
async function saveStudent(payload = {}, user = {}) {
  requireFields(payload, ['ssn_encrypted', 'grade_level'], 'ssn_encrypted and grade_level are required');
  assert14DigitSsn(payload.ssn_encrypted);
  const gradeLevel = assertGradeLevel(payload.grade_level);

  const role = normalizeRole(user.role);
  if (role !== 'principal' && !isDistrictManagerRole(role)) {
    throw new AppError(403, 'Forbidden: Only principals and district/directorate managers can add students.');
  }
  if (role === 'principal' && (!user.school_name || user.school_name === 'ALL')) {
    throw new AppError(403, 'Forbidden: Principal school assignment is missing.');
  }

  if (!getDbUrl(gradeLevel)) throw new AppError(400, `Invalid grade_level: ${payload.grade_level}.`);

  const govCode = resolveGovCode(payload.gov_code);
  const gender = normalizeGender(payload.gender);
  const className = payload.class_name ? String(payload.class_name).trim() : null;
  const ssn = String(payload.ssn_encrypted);

  const schoolName = role === 'principal' ? user.school_name : payload.school_name || null;
  const adminZone =
    role === 'principal'
      ? user.admin_zone || payload.admin_zone || null
      : isDistrictManagerRole(role) && user.admin_zone && user.admin_zone !== 'ALL'
        ? user.admin_zone
        : payload.admin_zone || null;

  try {
    const result = await withConnection(async (db) => {
      const rs = await db.execute(
        `INSERT INTO students
            (ssn_encrypted, student_name_ar, gender, gov_code, admin_zone, school_name, grade_level, class_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ssn_encrypted) DO UPDATE SET
            student_name_ar = excluded.student_name_ar,
            gender          = excluded.gender,
            gov_code        = excluded.gov_code,
            admin_zone      = excluded.admin_zone,
            school_name     = excluded.school_name,
            grade_level     = excluded.grade_level,
            class_name      = excluded.class_name`,
        [
          ssn,
          payload.student_name_ar ? String(payload.student_name_ar) : null,
          gender,
          govCode,
          adminZone,
          schoolName,
          gradeLevel,
          className,
        ],
      );
      return { affectedRows: rs.rowsAffected };
    });

    await redisDel(`student:${gradeLevel}:${ssn}`);

    return { message: 'Student saved successfully', affectedRows: result.affectedRows };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Database operation failed', error.message);
  }
}

module.exports = { loginStudent, saveStudent };
