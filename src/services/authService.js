const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { config } = require('../config');
const { withConnection } = require('../db/pools');
const AppError = require('../lib/AppError');

async function loginStaff(payload = {}) {
  const { username, password } = payload;

  if (!username || !password) {
    throw new AppError(400, 'Username and password required');
  }

  try {
    return await withConnection(config.dbUrls.primary, async (connection) => {
      const [rows] = await connection.execute(
        `SELECT teacher_id, teacher_name_ar, role, admin_zone, school_name, password_hash
         FROM test.teachers
         WHERE username = ? AND is_active = TRUE
         LIMIT 1`,
        [username]
      );

      if (rows.length === 0) {
        throw new AppError(401, 'Invalid username or password');
      }

      const user = rows[0];
      const validPassword = await bcrypt.compare(password, user.password_hash);

      if (!validPassword) {
        throw new AppError(401, 'Invalid username or password');
      }

      const token = jwt.sign(
        {
          teacher_id: user.teacher_id,
          role: user.role,
          admin_zone: user.admin_zone,
          school_name: user.school_name,
        },
        config.jwtSecret,
        { expiresIn: config.jwtExpiresIn }
      );

      return {
        success: true,
        token,
        user: {
          teacher_name_ar: user.teacher_name_ar,
          role: user.role,
          admin_zone: user.admin_zone,
          school_name: user.school_name,
        },
      };
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(500, 'Database query failed', error.message);
  }
}

function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

module.exports = {
  loginStaff,
  verifyToken,
};
