'use strict';

const { getDbUrl } = require('../config/env');
const { withConnection, withTransaction, inPlaceholders } = require('../db/client');
const { invalidate } = require('../db/diskCache');
const AppError = require('../lib/AppError');
const { requireFields, assert14DigitSsn, assertGradeLevel } = require('../utils/validation');

/**
 * Update one or many grades for a single class+subject — atomically, with bulk
 * queries. Steps inside one transaction:
 *   1. verify teacher is assigned to (grade,class,subject)
 *   2. bulk-check all target students exist
 *   3. multi-row upsert
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
    const assigned = await withConnection(async (db) => {
      const { rows } = await db.execute(
        `SELECT 1 FROM teacher_classes
          WHERE teacher_id = ? AND grade_level = ? AND class_name = ? AND subject_name = ?
          LIMIT 1`,
        [user.teacher_id, gradeLevel, className, subjectName],
      );
      return rows.length > 0;
    });
    if (!assigned) {
      throw new AppError(403, 'Forbidden: Teacher cannot edit grades for this subject/class.');
    }

    // 2 + 3. Validate students exist, then update the single grades_json column
    // for each student (read-modify-write inside one transaction).
    await withTransaction(async (db) => {
      const ssns = clean.map((g) => g.ssn_encrypted);

      const inClause = inPlaceholders(ssns.length);
      const { rows: found } = await db.execute(
        `SELECT ssn_encrypted, grades_json FROM students
          WHERE grade_level = ? AND class_name = ? AND ssn_encrypted IN (${inClause})`,
        [gradeLevel, className, ...ssns],
      );
      const foundMap = new Map(found.map((r) => [r.ssn_encrypted, r.grades_json]));
      const missing = ssns.filter((s) => !foundMap.has(s));
      if (missing.length > 0) {
        throw new AppError(404, `Students not found in grade ${gradeLevel} / class ${className}: ${missing.join(', ')}`);
      }

      // For each target student: merge the new subject grade into grades_json.
      const toUpdate = clean.filter((g) => foundMap.has(g.ssn_encrypted));
      for (const g of toUpdate) {
        let existing = {};
        try {
          existing = foundMap.get(g.ssn_encrypted)
            ? JSON.parse(foundMap.get(g.ssn_encrypted))
            : {};
        } catch {
          existing = {};
        }
        existing[subjectName] = g.grade_value;
        await db.execute(
          `UPDATE students SET grades_json = ?, updated_at = datetime('now') WHERE ssn_encrypted = ?`,
          [JSON.stringify(existing), g.ssn_encrypted],
        );
      }
    });

    // ── Write-through: invalidate each affected student's cached portal so
    // the next read rebuilds it fresh from Turso (cache stays consistent). ──
    for (const g of clean) {
      await invalidate(`portal:${g.ssn_encrypted}:${gradeLevel}`);
    }

    return { message: 'Grades updated successfully.', updated: clean.length };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Failed to update grades', error.message);
  }
}

module.exports = { updateGrade };
