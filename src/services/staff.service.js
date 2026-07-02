'use strict';

const bcrypt = require('bcryptjs');

const { withConnection } = require('../db/client');
const AppError = require('../lib/AppError');
const { normalizeRole } = require('../utils/roles');
const { requireFields } = require('../utils/validation');

/**
 * Detect a libSQL/SQLite unique-constraint error.
 * @param {unknown} error
 */
function isUniqueViolation(error) {
  if (!error || typeof error !== 'object') return false;
  const code = /** @type {any} */ (error).code;
  const msg = String(/** @type {any} */ (error).message || '');
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT' || msg.includes('UNIQUE constraint failed');
}

/**
 * Public bootstrap endpoint: create the first staff/admin account (bcrypt 12).
 */
async function registerStaff(payload = {}) {
  requireFields(payload, ['username', 'password', 'role'], 'Username, password, and role are required.');

  const username = String(payload.username).trim();
  const password = String(payload.password);
  if (password.length < 8) throw new AppError(400, 'Password must be at least 8 characters.');

  const teacherNameAr = payload.teacher_name_ar ? String(payload.teacher_name_ar) : username;
  const role = normalizeRole(payload.role);
  const govCode = payload.gov_code ? String(payload.gov_code) : null;
  const adminZone = payload.admin_zone ? String(payload.admin_zone) : 'ALL';
  const schoolName = payload.school_name ? String(payload.school_name) : 'ALL';

  try {
    const passwordHash = await bcrypt.hash(password, 12);

    return await withConnection(async (db) => {
      const rs = await db.execute(
        `INSERT INTO teachers (username, password_hash, teacher_name_ar, role, gov_code, admin_zone, school_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING teacher_id`,
        [username, passwordHash, teacherNameAr, role, govCode, adminZone, schoolName],
      );
      return { message: 'User created securely', userId: rs.rows[0].teacher_id };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (isUniqueViolation(error)) {
      throw new AppError(409, 'Username already exists.');
    }
    throw new AppError(500, 'Failed to create user', error.message);
  }
}

/**
 * Principal-only: add a teacher scoped to the principal's own school.
 */
async function addTeacher(payload = {}, user = {}) {
  if (normalizeRole(user.role) !== 'principal') {
    throw new AppError(403, 'Forbidden: Only principals can add teachers.');
  }
  if (!user.school_name || user.school_name === 'ALL') {
    throw new AppError(403, 'Forbidden: Principal school assignment is missing.');
  }

  requireFields(payload, ['username', 'password'], 'username and password are required.');
  const username = String(payload.username).trim();
  const password = String(payload.password);
  if (password.length < 8) throw new AppError(400, 'Password must be at least 8 characters.');

  const teacherNameAr = payload.teacher_name_ar ? String(payload.teacher_name_ar) : username;

  try {
    const passwordHash = await bcrypt.hash(password, 12);

    return await withConnection(async (db) => {
      const rs = await db.execute(
        `INSERT INTO teachers (username, password_hash, teacher_name_ar, role, gov_code, admin_zone, school_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING teacher_id`,
        [
          username,
          passwordHash,
          teacherNameAr,
          'teacher',
          user.gov_code || payload.gov_code || null,
          user.admin_zone || 'ALL',
          user.school_name,
        ],
      );
      return { message: 'Teacher added successfully', teacherId: rs.rows[0].teacher_id };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (isUniqueViolation(error)) {
      throw new AppError(409, 'Username already exists.');
    }
    throw new AppError(500, 'Failed to add teacher', error.message);
  }
}

module.exports = { registerStaff, addTeacher };
