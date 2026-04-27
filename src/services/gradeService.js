const { config, getDbUrl } = require('../config');
const { withConnection } = require('../db/pools');
const AppError = require('../lib/AppError');
const { requireFields, assert14DigitSsn } = require('../utils/validation');

async function updateGrade(payload, user) {
  requireFields(
    payload,
    ['ssn_encrypted', 'grade_level', 'class_name', 'subject_name'],
    'ssn_encrypted, grade_level, class_name, subject_name, and grade_value are required.'
  );

  if (payload.grade_value === undefined || payload.grade_value === null) {
    throw new AppError(400, 'ssn_encrypted, grade_level, class_name, subject_name, and grade_value are required.');
  }

  if (!user.teacher_id) {
    throw new AppError(403, 'Forbidden: teacher_id is missing from the token.');
  }

  assert14DigitSsn(payload.ssn_encrypted);

  const numericGradeLevel = Number(payload.grade_level);
  const dbUrl = getDbUrl(numericGradeLevel);

  if (!dbUrl) {
    throw new AppError(400, `Invalid grade_level: ${payload.grade_level}`);
  }

  try {
    const hasAssignment = await withConnection(config.dbUrls.primary, async (connection) => {
      const [rows] = await connection.execute(
        `SELECT 1
         FROM test.teacher_classes
         WHERE teacher_id = ?
           AND grade_level = ?
           AND class_name = ?
           AND subject_name = ?
         LIMIT 1`,
        [user.teacher_id, numericGradeLevel, payload.class_name, payload.subject_name]
      );

      return rows.length > 0;
    });

    if (!hasAssignment) {
      throw new AppError(403, 'Forbidden: Teacher cannot edit grades for this subject/class.');
    }

    await withConnection(dbUrl, async (connection) => {
      const [studentRows] = await connection.execute(
        `SELECT 1
         FROM test.students
         WHERE ssn_encrypted = ?
           AND grade_level = ?
           AND class_name = ?
         LIMIT 1`,
        [String(payload.ssn_encrypted), numericGradeLevel, payload.class_name]
      );

      if (studentRows.length === 0) {
        throw new AppError(404, 'Student not found in the provided grade/class.');
      }

      await connection.execute(
        `INSERT INTO test.student_grades (ssn_encrypted, subject_name, grade_value, teacher_id)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           grade_value = ?,
           teacher_id = ?,
           updated_at = CURRENT_TIMESTAMP`,
        [
          String(payload.ssn_encrypted),
          payload.subject_name,
          payload.grade_value,
          user.teacher_id,
          payload.grade_value,
          user.teacher_id,
        ]
      );
    });

    return { message: 'Grade updated successfully.' };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(500, 'Failed to update grade', error.message);
  }
}

module.exports = {
  updateGrade,
};
