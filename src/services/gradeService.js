const { config, getDbUrl } = require('../config');
const { withConnection } = require('../db/pools');
const AppError = require('../lib/AppError');
const { requireFields, assert14DigitSsn } = require('../utils/validation');

async function updateGrade(payload, user) {
  if (!user.teacher_id) {
    throw new AppError(403, 'Forbidden: teacher_id is missing from the token.');
  }

  // Support batch updates or single update
  const grades = Array.isArray(payload) ? payload : [payload];

  if (grades.length === 0) {
    return { message: 'No grades to update.' };
  }

  // We assume all grades in a single request belong to the same class/subject.
  // Validate the first grade for assignment checks.
  const firstGrade = grades[0];
  requireFields(
    firstGrade,
    ['grade_level', 'class_name', 'subject_name'],
    'grade_level, class_name, and subject_name are required.'
  );

  const numericGradeLevel = Number(firstGrade.grade_level);
  const dbUrl = getDbUrl(numericGradeLevel);

  if (!dbUrl) {
    throw new AppError(400, `Invalid grade_level: ${firstGrade.grade_level}`);
  }

  try {
    // 1. Verify Teacher Assignment securely on DB_TEACHER
    const hasAssignment = await withConnection(config.dbUrls.teachers, async (connection) => {
      const [rows] = await connection.execute(
        `SELECT 1
         FROM test.teacher_classes
         WHERE teacher_id = ?
           AND grade_level = ?
           AND class_name = ?
           AND subject_name = ?
         LIMIT 1`,
        [user.teacher_id, numericGradeLevel, firstGrade.class_name, firstGrade.subject_name]
      );
      return rows.length > 0;
    });

    if (!hasAssignment) {
      throw new AppError(403, 'Forbidden: Teacher cannot edit grades for this subject/class.');
    }

    // 2. Batch process grades on the target student DB
    await withConnection(dbUrl, async (connection) => {
      for (const grade of grades) {
        if (!grade.ssn_encrypted || grade.grade_value === undefined || grade.grade_value === null) {
          continue; // Skip invalid entries
        }

        assert14DigitSsn(grade.ssn_encrypted);

        const [studentRows] = await connection.execute(
          `SELECT 1
           FROM test.students
           WHERE ssn_encrypted = ?
             AND grade_level = ?
             AND class_name = ?
           LIMIT 1`,
          [String(grade.ssn_encrypted), numericGradeLevel, firstGrade.class_name]
        );

        if (studentRows.length === 0) {
          throw new AppError(404, \`Student \${grade.ssn_encrypted} not found in the provided grade/class.\`);
        }

        await connection.execute(
          `INSERT INTO test.student_grades
           (ssn_encrypted, grade_level, class_name, subject_name, grade_value, teacher_id)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             grade_level = VALUES(grade_level),
             class_name = VALUES(class_name),
             grade_value = VALUES(grade_value),
             teacher_id = VALUES(teacher_id),
             updated_at = CURRENT_TIMESTAMP`,
          [
            String(grade.ssn_encrypted),
            numericGradeLevel,
            firstGrade.class_name,
            firstGrade.subject_name,
            grade.grade_value,
            user.teacher_id,
          ]
        );
      }
    });

    return { message: 'Grades updated successfully.' };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(500, 'Failed to update grades', error.message);
  }
}

module.exports = {
  updateGrade,
};
