'use strict';

const bcrypt = require('bcryptjs');

const { withConnection } = require('../db/pools');
const AppError = require('../lib/AppError');
const { normalizeRole } = require('../utils/roles');
const { requireFields } = require('../utils/validation');

/** pg unique-violation error code. */
const UNIQUE_VIOLATION = '23505';

/**
 * Public bootstrap endpoint: create the first staff/admin account (bcrypt 12).
 * @param {Record<string, unknown>} payload
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

    return await withConnection(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO teachers (username, password_hash, teacher_name_ar, role, gov_code, admin_zone, school_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING teacher_id`,
        [username, passwordHash, teacherNameAr, role, govCode, adminZone, schoolName],
      );
      return { message: 'User created securely', userId: rows[0].teacher_id };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error && error.code === UNIQUE_VIOLATION) {
      throw new AppError(409, 'Username already exists.');
    }
    throw new AppError(500, 'Failed to create user', error.message);
  }
}

/**
 * Principal-only: add a teacher scoped to the principal's own school.
 * @param {Record<string, unknown>} payload
 * @param {{ role?: string, school_name?: string, gov_code?: string, admin_zone?: string }} user
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

    return await withConnection(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO teachers (username, password_hash, teacher_name_ar, role, gov_code, admin_zone, school_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
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
      return { message: 'Teacher added successfully', teacherId: rows[0].teacher_id };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error && error.code === UNIQUE_VIOLATION) {
      throw new AppError(409, 'Username already exists.');
    }
    throw new AppError(500, 'Failed to add teacher', error.message);
  }
}

module.exports = { registerStaff, addTeacher };
