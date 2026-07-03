'use strict';

const bcrypt = require('bcryptjs');

const { withConnection } = require('../db/client');
const { ensureSchool } = require('./school.service');
const AppError = require('../lib/AppError');
const { normalizeRole } = require('../utils/roles');
const { requireFields } = require('../utils/validation');

/** Detect a libSQL/SQLite unique-constraint error. @param {unknown} error */
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

  const displayName = payload.teacher_name_ar ? String(payload.teacher_name_ar) : username;
  const role = normalizeRole(payload.role);
  const govCode = payload.gov_code ? String(payload.gov_code) : null;
  const adminZone = payload.admin_zone ? String(payload.admin_zone) : 'ALL';
  const schoolName = payload.school_name ? String(payload.school_name) : 'ALL';

  await ensureSchool({ gov_code: govCode, admin_zone: adminZone, school_name: schoolName });

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    return await withConnection(async (db) => {
      const rs = await db.execute(
        `INSERT INTO staff (username, password_hash, display_name, role, gov_code, admin_zone, school_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING staff_id`,
        [username, passwordHash, displayName, role, govCode, adminZone, schoolName],
      );
      return { message: 'User created securely', userId: rs.rows[0].staff_id };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (isUniqueViolation(error)) throw new AppError(409, 'Username already exists.');
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
  const displayName = payload.teacher_name_ar ? String(payload.teacher_name_ar) : username;

  const govCode = user.gov_code || payload.gov_code || null;
  const adminZone = user.admin_zone || 'ALL';
  const schoolName = user.school_name;
  await ensureSchool({ gov_code: govCode, admin_zone: adminZone, school_name: schoolName });

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    return await withConnection(async (db) => {
      const rs = await db.execute(
        `INSERT INTO staff (username, password_hash, display_name, role, gov_code, admin_zone, school_name)
         VALUES (?, ?, ?, 'teacher', ?, ?, ?)
         RETURNING staff_id`,
        [username, passwordHash, displayName, govCode, adminZone, schoolName],
      );
      return { message: 'Teacher added successfully', teacherId: rs.rows[0].staff_id };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (isUniqueViolation(error)) throw new AppError(409, 'Username already exists.');
    throw new AppError(500, 'Failed to add teacher', error.message);
  }
}

/**
 * Assign a staff teacher to a (grade_level, class_name, subject_name) so they
 * are authorized to record grades for it. Admin/principal/manager only.
 * @param {{ teacher_id?: number|string, grade_level?: number, class_name?: string, subject_name?: string }} payload
 * @param {{ role?: string }} user
 */
async function assignTeacherClass(payload = {}, user = {}) {
  const role = normalizeRole(user.role);
  if (role !== 'admin' && role !== 'principal' && !role.includes('manager') && role !== 'directorate' && role !== 'district') {
    throw new AppError(403, 'Forbidden: admin/principal/manager approval required.');
  }
  requireFields(payload, ['teacher_id', 'grade_level', 'class_name', 'subject_name'],
    'teacher_id, grade_level, class_name, and subject_name are required.');
  const teacherId = Number(payload.teacher_id);
  const gradeLevel = Number(payload.grade_level);
  if (!Number.isInteger(gradeLevel) || gradeLevel < 1 || gradeLevel > 12) {
    throw new AppError(400, 'Invalid grade_level. Must be an integer 1-12.');
  }
  const className = String(payload.class_name).trim();
  const subjectName = String(payload.subject_name).trim();

  try {
    return await withConnection(async (db) => {
      // Confirm the teacher exists in staff.
      const { rows } = await db.execute(
        `SELECT staff_id, school_name FROM staff WHERE staff_id = ? LIMIT 1`, [teacherId],
      );
      if (rows.length === 0) throw new AppError(404, 'Teacher (staff) not found.');

      // A principal may only assign within their own school.
      if (role === 'principal' && user.school_name && user.school_name !== 'ALL' && String(rows[0].school_name) !== String(user.school_name)) {
        throw new AppError(403, 'Forbidden: you can only assign teachers in your own school.');
      }

      await db.execute(
        `INSERT OR IGNORE INTO teacher_classes (teacher_id, grade_level, class_name, subject_name)
         VALUES (?, ?, ?, ?)`,
        [teacherId, gradeLevel, className, subjectName],
      );
      return { message: 'Class assignment saved.', teacher_id: teacherId, grade_level: gradeLevel, class_name: className, subject_name: subjectName };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Failed to assign teacher class', error.message);
  }
}

/**
 * List teacher→(class,subject) assignments. A non-admin teacher sees only
 * their own; admins/managers may pass ?teacher_id to scope or get everything.
 * @param {{ teacher_id?: number, role?: string }} user
 * @param {{ teacher_id?: string }} [query]
 */
async function listTeacherClasses(user = {}, query = {}) {
  const role = normalizeRole(user.role);
  const myId = user.teacher_id != null ? Number(user.teacher_id) : null;
  const isAdminLike = role === 'admin' || role.includes('manager') || role === 'directorate' || role === 'district' || role === 'principal';

  const requested = query.teacher_id != null && query.teacher_id !== '' ? Number(query.teacher_id) : null;
  const teacherId = isAdminLike ? (requested || null) : myId;
  if (!isAdminLike && !myId) throw new AppError(403, 'Forbidden: teacher_id missing from token.');

  try {
    return await withConnection(async (db) => {
      const params = [];
      let sql = `SELECT tc.teacher_id, s.username, s.display_name AS teacher_name,
                        tc.grade_level, tc.class_name, tc.subject_name
                   FROM teacher_classes tc
                   LEFT JOIN staff s ON s.staff_id = tc.teacher_id`;
      if (teacherId) { sql += ' WHERE tc.teacher_id = ?'; params.push(teacherId); }
      sql += ' ORDER BY tc.teacher_id ASC, tc.grade_level ASC, tc.class_name ASC, tc.subject_name ASC LIMIT 1000';
      const { rows } = await db.execute(sql, params);
      return { assignments: rows };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Failed to list teacher classes', error.message);
  }
}

module.exports = { registerStaff, addTeacher, assignTeacherClass, listTeacherClasses };
