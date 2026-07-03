'use strict';

const { getClient } = require('../db/client');
const { getCacheAsync, setCache } = require('../db/diskCache');
const AppError = require('../lib/AppError');
const { assert14DigitSsn, assertGradeLevel } = require('../utils/validation');

// Portal data is cached to disk and served until a write invalidates it.
// If the disk is wiped, it rebuilds from Turso on first read.
const CACHE_TTL_SEC = 0;

/**
 * Fetch the FULL student portal in ONE database round trip.
 *
 * Six index-only / PK lookups are sent as a single libSQL batch (one HTTP
 * call): profile, grades, attendance, weekly, and the two shared portal_meta
 * rows (schedule + announcements). With the disk cache, repeat reads cost
 * ZERO Turso reads.
 *
 * Grades now carry teacher_id + updated_at (impossible in the old JSON model).
 * @param {{ ssn_encrypted?: string, grade_level?: number|string }} query
 */
async function getStudentPortal(query = {}) {
  if (!query.ssn_encrypted) throw new AppError(400, 'ssn_encrypted is required.');
  assert14DigitSsn(query.ssn_encrypted);
  const gradeLevel = assertGradeLevel(query.grade_level);
  const ssn = String(query.ssn_encrypted);

  // ── Read-through: check disk cache first ──
  const cacheKey = `portal:${ssn}:${gradeLevel}`;
  const cached = await getCacheAsync(cacheKey);
  if (cached) return cached;

  /** @type {{ sql: string; args: unknown[] }[]} */
  const batchStmts = [
    {
      sql: `SELECT ssn_encrypted, student_name_ar, gender, gov_code, admin_zone,
                   school_name, grade_level, class_name
              FROM students WHERE ssn_encrypted = ? LIMIT 1`,
      args: [ssn],
    },
    {
      sql: `SELECT subject_name, grade_value, updated_by AS teacher_id, updated_at
              FROM student_grades WHERE ssn_encrypted = ? ORDER BY subject_name ASC`,
      args: [ssn],
    },
    {
      sql: `SELECT date, status, note
              FROM attendance WHERE ssn_encrypted = ? ORDER BY date DESC`,
      args: [ssn],
    },
    {
      sql: `SELECT subject_name, week_number AS week, score, max_score
              FROM weekly_assessments WHERE ssn_encrypted = ?
              ORDER BY subject_name ASC, week_number ASC`,
      args: [ssn],
    },
    {
      sql: `SELECT key, value FROM portal_meta WHERE key IN (?, ?)`,
      args: [`schedule:${gradeLevel}`, 'announcements'],
    },
  ];

  const results = await getClient().batch(batchStmts, 'read');

  const profile = results[0].rows[0];
  if (!profile) throw new AppError(404, 'Student not found.');

  // Grades (already typed rows; values are stored as TEXT).
  const grades = results[1].rows.map((r) => ({
    subject_name: r.subject_name,
    grade_value: String(r.grade_value),
    teacher_id: r.teacher_id == null ? null : Number(r.teacher_id),
    updated_at: r.updated_at == null ? null : String(r.updated_at),
  }));

  const gradeValues = grades.map((g) => parseFloat(g.grade_value)).filter((v) => !isNaN(v));
  const average =
    gradeValues.length > 0 ? (gradeValues.reduce((a, b) => a + b, 0) / gradeValues.length).toFixed(1) : null;

  // Attendance.
  const attendance = results[2].rows.map((r) => ({
    date: String(r.date),
    status: String(r.status),
    note: r.note == null ? null : String(r.note),
  }));
  const attendanceStats = computeAttendanceStats(attendance);
  const absentCount = attendance.filter((a) => a.status === 'absent').length;
  const absenceLimit = { used: absentCount, limit: 30, remaining: Math.max(0, 30 - absentCount) };

  // Weekly assessments grouped by subject.
  /** @type {Record<string, Array<{ week: number, score: number, max_score: number }>>} */
  const weeklyAssessments = {};
  for (const r of results[3].rows) {
    const subj = String(r.subject_name);
    if (!weeklyAssessments[subj]) weeklyAssessments[subj] = [];
    weeklyAssessments[subj].push({ week: Number(r.week), score: Number(r.score), max_score: Number(r.max_score) });
  }

  // Shared schedule + announcements.
  /** @type {Record<string, any>} */
  const meta = {};
  for (const r of results[4].rows) meta[String(r.key)] = r.value;
  const schedule = parseJson(meta[`schedule:${gradeLevel}`], {});
  const announcements = parseJson(meta['announcements'], []);

  const result = {
    student: {
      ssn_encrypted: profile.ssn_encrypted,
      student_name_ar: profile.student_name_ar,
      gender: profile.gender,
      gov_code: profile.gov_code,
      admin_zone: profile.admin_zone,
      school_name: profile.school_name,
      grade_level: profile.grade_level,
      class_name: profile.class_name,
    },
    grades,
    average,
    weeklyAssessments,
    attendance,
    attendanceStats,
    absenceLimit,
    schedule,
    announcements,
  };

  await setCache(cacheKey, result, CACHE_TTL_SEC);
  return result;
}

function parseJson(raw, fallback) {
  try { return typeof raw === 'string' && raw ? JSON.parse(raw) : fallback; }
  catch { return fallback; }
}

function computeAttendanceStats(attendance) {
  const stats = { present: 0, absent: 0, late: 0, excused: 0, total: attendance.length };
  for (const a of attendance) {
    if (a.status === 'present') stats.present++;
    else if (a.status === 'absent') stats.absent++;
    else if (a.status === 'late') stats.late++;
    else if (a.status === 'excused') stats.excused++;
  }
  stats.percentage = stats.total > 0 ? Math.round((stats.present / stats.total) * 100) : 100;
  return stats;
}

module.exports = { getStudentPortal };
