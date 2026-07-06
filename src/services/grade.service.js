'use strict';

const { getDbUrl } = require('../config/env');
const { getClient, inPlaceholders } = require('../db/client');
const { invalidateBatch } = require('../db/diskCache');
const { prefetchPortals } = require('../db/cachePrefetch');
const AppError = require('../lib/AppError');
const { requireFields, assert14DigitSsn, assertGradeLevel } = require('../utils/validation');

// v5 — write-through budget. For a class-sized post this lets us prefetch each
// affected portal in parallel so the user's next read hits warm cache. For a
// pathological 200-student post we skip per-student prefetch (just the DELs)
// to avoid ~200 synchronous Turso batches on the write path — the next reader
// falls through to DB the normal way and warms the cache lazily.
const PREFETCH_BUDGET = 50;

/**
 * Record one or many subject grades for a single class+subject — atomically,
 * with NO lost updates.
 *
 *   OLD (v3): read each student's whole grades_json blob → mutate → write it
 *   back. Two teachers editing different subjects for the same student
 *   clobbered each other (last write wins = lost data) and held a row lock.
 *
 *   NEW (v4): one subject grade = one row. We upsert exactly (ssn, subject)
 *   rows in a single libSQL batch (one round trip, one transaction). Concurrent
 *   teachers on different subjects touch different rows → no contention, no
 *   lost data. We also now persist who/when (updated_by, updated_at).
 *
 * Flow (2 round trips):
 *   1. batch-read: teacher authorization + bulk student existence check.
 *   2. batch-write: one upsert per target student.
 *
 * @param {Record<string, unknown> | Array<Record<string, unknown>>} payload
 * @param {{ teacher_id?: number }} user
 */
async function updateGrade(payload, user) {
  if (!user.teacher_id) {
    throw new AppError(403, 'Forbidden: teacher_id is missing from the token.');
  }
  const teacherId = Number(user.teacher_id);

  const grades = Array.isArray(payload) ? payload : [payload];
  if (grades.length === 0) return { message: 'No grades to update.' };
  if (grades.length > 1000) throw new AppError(400, 'Too many grades in one request (max 1000).');

  const first = grades[0];
  requireFields(first, ['grade_level', 'class_name', 'subject_name'], 'grade_level, class_name, and subject_name are required.');
  const gradeLevel = assertGradeLevel(first.grade_level);
  const className = String(first.class_name).trim();
  const subjectName = String(first.subject_name).trim();

  if (!getDbUrl(gradeLevel)) throw new AppError(400, `Invalid grade_level: ${first.grade_level}`);

  // Normalise + validate every row up front.
  const clean = [];
  for (const g of grades) {
    if (!g.ssn_encrypted || g.grade_value === undefined || g.grade_value === null) continue;
    assert14DigitSsn(g.ssn_encrypted);
    clean.push({ ssn_encrypted: String(g.ssn_encrypted), grade_value: String(g.grade_value) });
  }
  if (clean.length === 0) return { message: 'No valid grades to update.' };

  const ssns = clean.map((g) => g.ssn_encrypted);
  const client = getClient();

  try {
    // 1) Authorization + existence in ONE round trip (batch read).
    const [authRes, existRes] = await client.batch(
      [
        {
          sql: `SELECT 1 FROM teacher_classes
                  WHERE teacher_id = ? AND grade_level = ? AND class_name = ? AND subject_name = ?
                  LIMIT 1`,
          args: [teacherId, gradeLevel, className, subjectName],
        },
        {
          sql: `SELECT ssn_encrypted FROM students
                  WHERE grade_level = ? AND class_name = ? AND ssn_encrypted IN (${inPlaceholders(ssns.length)})`,
          args: [gradeLevel, className, ...ssns],
        },
      ],
      'read',
    );

    if (authRes.rows.length === 0) {
      throw new AppError(403, 'Forbidden: Teacher cannot edit grades for this subject/class.');
    }

    const found = new Set(existRes.rows.map((r) => String(r.ssn_encrypted)));
    const missing = ssns.filter((s) => !found.has(s));
    if (missing.length > 0) {
      throw new AppError(404, `Students not found in grade ${gradeLevel} / class ${className}: ${missing.join(', ')}`);
    }

    // 2) One atomic batch upsert (1 round trip). Each row is independent →
    //    no contention / no clobbering between subjects or teachers.
    const stmts = clean.map((g) => ({
      sql: `INSERT INTO student_grades (ssn_encrypted, subject_name, grade_value, updated_by, updated_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(ssn_encrypted, subject_name) DO UPDATE SET
              grade_value = excluded.grade_value,
              updated_by   = excluded.updated_by,
              updated_at   = datetime('now')`,
      args: [g.ssn_encrypted, subjectName, g.grade_value, teacherId],
    }));
    await client.batch(stmts, 'write');

    // ── v5 write-through (pattern c: invalidate-then-prefetch) ──
    // 1) Bust every affected portal key in 2 round-trips total (was N sequential
    //    awaits: one Redis-DEL + one disk-DELETE per student).
    const portalKeys = clean.map((g) => `portal:${g.ssn_encrypted}:${gradeLevel}`);
    await invalidateBatch(portalKeys);

    // 2) For class-sized posts only: repopulate the cache NOW so the user's next
    //    read is hot. The existing portal reader does this — TTL=0 → Redis 365d.
    if (portalKeys.length > 0 && portalKeys.length <= PREFETCH_BUDGET) {
      await prefetchPortals(portalKeys);
    }

    return { message: 'Grades updated successfully.', updated: clean.length };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Failed to update grades', error.message);
  }
}

module.exports = { updateGrade };
