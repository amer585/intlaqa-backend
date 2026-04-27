const bcrypt = require('bcryptjs');

const { config } = require('../config');
const { withConnection } = require('../db/pools');
const AppError = require('../lib/AppError');
const { normalizeRole } = require('../utils/roles');
const { requireFields } = require('../utils/validation');

async function registerStaff(payload) {
  requireFields(payload, ['username', 'password', 'role'], 'Username, password, and role are required.');

  const {
    username,
    password,
    teacher_name_ar,
    role,
    gov_code,
    admin_zone,
    school_name,
  } = payload;

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    return await withConnection(config.dbUrls.primary, async (connection) => {
      const [result] = await connection.execute(
        `INSERT INTO test.teachers
         (username, password_hash, teacher_name_ar, role, gov_code, admin_zone, school_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          username,
          passwordHash,
          teacher_name_ar || username,
          role,
          gov_code || null,
          admin_zone || 'ALL',
          school_name || 'ALL',
        ]
      );

      return {
        message: 'User created securely',
        userId: result.insertId,
      };
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(500, 'Failed to create user', error.message);
  }
}

async function addTeacher(payload, user) {
  if (normalizeRole(user.role) !== 'principal') {
    throw new AppError(403, 'Forbidden: Only principals can add teachers.');
  }

  if (!user.school_name || user.school_name === 'ALL') {
    throw new AppError(403, 'Forbidden: Principal school assignment is missing.');
  }

  requireFields(payload, ['username', 'password'], 'username and password are required.');

  const { username, password, teacher_name_ar, gov_code, admin_zone } = payload;

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    return await withConnection(config.dbUrls.primary, async (connection) => {
      const [result] = await connection.execute(
        `INSERT INTO test.teachers
         (username, password_hash, teacher_name_ar, role, gov_code, admin_zone, school_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          username,
          passwordHash,
          teacher_name_ar || username,
          'teacher',
          gov_code || null,
          user.admin_zone || admin_zone || 'ALL',
          user.school_name,
        ]
      );

      return {
        message: 'Teacher created successfully.',
        userId: result.insertId,
        school_name: user.school_name,
      };
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(500, 'Failed to create teacher', error.message);
  }
}

module.exports = {
  registerStaff,
  addTeacher,
};
