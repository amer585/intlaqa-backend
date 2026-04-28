const { getDbUrl } = require('../config');
const { withConnection } = require('../db/pools');
const AppError = require('../lib/AppError');
const { resolveGovCode, resolveGovName } = require('../utils/governorates');
const { isDistrictManagerRole, normalizeRole } = require('../utils/roles');
const { requireFields, assert14DigitSsn } = require('../utils/validation');

async function loginStudent(payload) {
  requireFields(payload, ['ssn_encrypted', 'grade_level'], 'ssn_encrypted and grade_level are required');
  assert14DigitSsn(payload.ssn_encrypted);

  const numericGradeLevel = Number(payload.grade_level);

  if (String(payload.ssn_encrypted) === '11111111111111') {
    return {
      message: 'Login successful',
      student: {
        ssn_encrypted: '11111111111111',
        grade_level: numericGradeLevel,
        student_name_ar: 'طالب تجريبي (حساب مؤقت)',
        school_name: 'مدرسة الانطلاقة',
        class_name: 'فصل أ',
        admin_zone: 'إدارة تجريبية',
        gov_code: 'القاهرة',
        gender: 'M',
      },
    };
  }

  const dbUrl = getDbUrl(numericGradeLevel);

  if (!dbUrl) {
    throw new AppError(400, `Invalid grade_level: ${payload.grade_level}`);
  }

  try {
    return await withConnection(dbUrl, async (connection) => {
      const [rows] = await connection.execute(
        `SELECT student_name_ar, school_name, class_name, admin_zone, gov_code, gender
         FROM test.students
         WHERE ssn_encrypted = ?
         LIMIT 1`,
        [String(payload.ssn_encrypted)]
      );

      if (rows.length === 0) {
        throw new AppError(404, 'Student ID not found in this grade.', {
          ssn_encrypted: payload.ssn_encrypted,
          grade_level: payload.grade_level,
        });
      }

      const student = rows[0];

      return {
        message: 'Login successful',
        student: {
          ssn_encrypted: String(payload.ssn_encrypted),
          grade_level: numericGradeLevel,
          student_name_ar: student.student_name_ar,
          school_name: student.school_name,
          class_name: student.class_name,
          admin_zone: student.admin_zone,
          gov_code: resolveGovName(student.gov_code) || 'القاهرة',
          gender: student.gender,
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

async function saveStudent(payload, user) {
  requireFields(payload, ['ssn_encrypted', 'grade_level'], 'ssn_encrypted and grade_level are required');
  assert14DigitSsn(payload.ssn_encrypted);

  const normalizedRole = normalizeRole(user.role);

  if (normalizedRole !== 'principal' && !isDistrictManagerRole(normalizedRole)) {
    throw new AppError(403, 'Forbidden: Only principals and district/directorate managers can add students.');
  }

  if (normalizedRole === 'principal' && (!user.school_name || user.school_name === 'ALL')) {
    throw new AppError(403, 'Forbidden: Principal school assignment is missing.');
  }

  const numericGradeLevel = Number(payload.grade_level);
  const dbUrl = getDbUrl(numericGradeLevel);

  if (!dbUrl) {
    throw new AppError(400, `Invalid grade_level: ${payload.grade_level}.`);
  }

  const numericGovCode = resolveGovCode(payload.gov_code);
  const effectiveSchoolName = normalizedRole === 'principal' ? user.school_name : (payload.school_name || null);
  const effectiveAdminZone = normalizedRole === 'principal'
    ? (user.admin_zone || payload.admin_zone || null)
    : (
      isDistrictManagerRole(normalizedRole) && user.admin_zone && user.admin_zone !== 'ALL'
        ? user.admin_zone
        : (payload.admin_zone || null)
    );

  try {
    return await withConnection(dbUrl, async (connection) => {
      const [result] = await connection.execute(
        `INSERT INTO test.students
         (ssn_encrypted, student_name_ar, gender, gov_code, admin_zone, school_name, grade_level, class_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           student_name_ar = ?,
           gender = ?,
           gov_code = ?,
           admin_zone = ?,
           school_name = ?,
           grade_level = ?,
           class_name = ?`,
        [
          String(payload.ssn_encrypted),
          payload.student_name_ar || null,
          payload.gender || null,
          numericGovCode,
          effectiveAdminZone,
          effectiveSchoolName,
          numericGradeLevel,
          payload.class_name || null,
          payload.student_name_ar || null,
          payload.gender || null,
          numericGovCode,
          effectiveAdminZone,
          effectiveSchoolName,
          numericGradeLevel,
          payload.class_name || null,
        ]
      );

      return {
        message: 'Student saved successfully',
        affectedRows: result.affectedRows,
      };
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(500, 'Database operation failed', error.message);
  }
}

module.exports = {
  loginStudent,
  saveStudent,
};
