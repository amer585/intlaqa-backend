'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { config } = require('../config/env');
const { withConnection } = require('../db/pools');
const AppError = require('../lib/AppError');
const logger = require('../lib/logger');
const { isBcryptHash } = require('../utils/validation');

/**
 * Authenticate a staff member and issue a JWT. bcrypt-only — non-bcrypt hashes
 * are rejected at login with a generic 401 (no plaintext fallback).
 * @param {{ username?: string, password?: string }} payload
 */
async function loginStaff(payload = {}) {
  const { username, password } = payload;
  if (!username || !password) {
    throw new AppError(400, 'Username and password required');
  }

  try {
    return await withConnection(async (client) => {
      const { rows } = await client.query(
        `SELECT teacher_id, teacher_name_ar, role, gov_code, admin_zone, school_name, password_hash
           FROM teachers
          WHERE username = $1 AND is_active = TRUE
          LIMIT 1`,
        [String(username)],
      );

      if (rows.length === 0) {
        throw new AppError(401, 'Invalid username or password');
      }

      const user = rows[0];
      if (!isBcryptHash(user.password_hash)) {
        logger.warn('Login blocked: non-bcrypt password hash', { username });
        throw new AppError(401, 'Invalid username or password');
      }

      const valid = await bcrypt.compare(String(password), user.password_hash);
      if (!valid) {
        throw new AppError(401, 'Invalid username or password');
      }

      const token = jwt.sign(
        {
          teacher_id: user.teacher_id,
          gov_code: user.gov_code,
          role: user.role,
          admin_zone: user.admin_zone,
          school_name: user.school_name,
        },
        config.jwtSecret,
        { expiresIn: config.jwtExpiresIn },
      );

      return {
        success: true,
        token,
        user: {
          name: user.teacher_name_ar,
          teacher_name_ar: user.teacher_name_ar,
          role: user.role,
          gov_code: user.gov_code,
          admin_zone: user.admin_zone,
          school_name: user.school_name,
        },
      };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Database query failed', error.message);
  }
}

/** Verify a JWT and return its payload. */
function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

module.exports = { loginStaff, verifyToken };
