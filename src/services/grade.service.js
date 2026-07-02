'use strict';

const { config, getDbUrl } = require('../config/env');
const { withConnection, withTransaction, valuesPlaceholders, inPlaceholders } = require('../db/pools');
const AppError = require('../lib/AppError');
const { requireFields, assert14DigitSsn, assertGradeLevel } = require('../utils/validation');

/**
 * Update one or many grades for a single class+subject — atomically, with bulk
 * queries (no per-student SELECT/INSERT loop). Steps:
 *   1. verify teacher is assigned to (grade,class,subject)
 *   2. bulk-check all target students exist
 *   3. multi-row upsert
 * All inside one transaction.
 *
 * @param {Record<string, unknown> | Array<Record<string, unknown>>} payload
 * @param {{ teacher_id?: number }} user
 */
async function updateGrade(payload, user) {
  if (!user.teacher_id) {
    throw new AppError(403, 'Forbidden: teacher_id is missing from the token.');
  }

  const grades = Array.isArray(payload) ? payload : [payload];
  if (grades.length === 0) return { message: 'No grades to update.' };
  if (grades.length > 1000) throw new AppError(400, 'Too many grades in one request (max 1000).');

  const first = grades[0];
  requireFields(first, ['grade_level', 'class_name', 'subject_name'], 'grade_level, class_name, and subject_name are required.');
  const gradeLevel = assertGradeLevel(first.grade_level);
  const className = String(first.class_name).trim();
  const subjectName = String(first.subject_name).trim();

  const dbUrl = getDbUrl(gradeLevel);
  if (!dbUrl) throw new AppError(400, `Invalid grade_level: ${first.grade_level}`);

  // Normalise + validate every row up front.
  const clean = [];
  for (const g of grades) {
    if (!g.ssn_encrypted || g.grade_value === undefined || g.grade_value === null) continue;
    assert14DigitSsn(g.ssn_encrypted);
    clean.push({ ssn_encrypted: String(g.ssn_encrypted), grade_value: String(g.grade_value) });
  }
  if (clean.length === 0) return { message: 'No valid grades to update.' };

  try {
    // 1. Verify teacher assignment (single query).
    const assigned = await withConnection(async (client) => {
      const { rows } = await client.query(
        `SELECT 1 FROM teacher_classes
          WHERE teacher_id = $1 AND grade_level = $2 AND class_name = $3 AND subject_name = $4
          LIMIT 1`,
        [user.teacher_id, gradeLevel, className, subjectName],
      );
      return rows.length > 0;
    });
    if (!assigned) {
      throw new AppError(403, 'Forbidden: Teacher cannot edit grades for this subject/class.');
    }

    // 2 + 3. Validate students exist, then upsert — one transaction.
    await withTransaction(async (client) => {
      const ssns = clean.map((g) => g.ssn_encrypted);

      const inClause = inPlaceholders(ssns.length, 3); // $3, $4, ... (after $1 grade, $2 class)
      const { rows: found } = await client.query(
        `SELECT ssn_encrypted FROM students
          WHERE grade_level = $1 AND class_name = $2 AND ssn_encrypted IN (${inClause})`,
        [gradeLevel, className, ...ssns],
      );
      const foundSet = new Set(found.map((r) => r.ssn_encrypted));
      const missing = ssns.filter((s) => !foundSet.has(s));
      if (missing.length > 0) {
        throw new AppError(404, `Students not found in grade ${gradeLevel} / class ${className}: ${missing.join(', ')}`);
      }

      const placeholders = valuesPlaceholders(clean.length, 6); // ($1..$6),($7..$12)...
      const values = clean.flatMap((g) => [g.ssn_encrypted, gradeLevel, className, subjectName, g.grade_value, user.teacher_id]);
      await client.query(
        `INSERT INTO student_grades (ssn_encrypted, grade_level, class_name, subject_name, grade_value, teacher_id)
         VALUES ${placeholders}
         ON CONFLICT (ssn_encrypted, grade_level, class_name, subject_name) DO UPDATE SET
            grade_value = EXCLUDED.grade_value,
            teacher_id  = EXCLUDED.teacher_id,
            updated_at  = now()`,
        values,
      );
    });

    return { message: 'Grades updated successfully.', updated: clean.length };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Failed to update grades', error.message);
  }
}

module.exports = { updateGrade };
