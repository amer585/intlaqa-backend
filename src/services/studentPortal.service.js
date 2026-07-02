'use strict';

const { getClient } = require('../db/client');
const AppError = require('../lib/AppError');
const { assert14DigitSsn, assertGradeLevel } = require('../utils/validation');

/**
 * Fetch the full student portal: profile, grades, attendance, schedule,
 * and announcements. Each section is queried independently with try/catch so
 * a single failing query NEVER causes a 500 — it just returns empty for that
 * section. The profile is the only hard requirement.
 *
 * @param {{ ssn_encrypted?: string, grade_level?: number }} query
 */
async function getStudentPortal(query = {}) {
  if (!query.ssn_encrypted) throw new AppError(400, 'ssn_encrypted is required.');
  assert14DigitSsn(query.ssn_encrypted);
  const gradeLevel = assertGradeLevel(query.grade_level);
  const ssn = String(query.ssn_encrypted);

  // 1. Profile — the only hard requirement.
  let profileRes;
  try {
    profileRes = await getClient().execute({
      sql: `SELECT ssn_encrypted, student_name_ar, gender, gov_code, admin_zone, school_name, grade_level, class_name
              FROM students WHERE ssn_encrypted = ? LIMIT 1`,
      args: [ssn],
    });
  } catch (error) {
    throw new AppError(500, 'Failed to fetch student profile', error.message);
  }
  if (profileRes.rows.length === 0) {
    throw new AppError(404, 'Student not found.');
  }
  const profile = profileRes.rows[0];

  // 2-5. Optional sections — each wrapped so a failure degrades gracefully.
  const [grades, attendance, schedule, announcements] = await Promise.all([
    safeQuery(() => getClient().execute({
      sql: `SELECT subject_name, grade_value, updated_at, teacher_id FROM student_grades WHERE ssn_encrypted = ? ORDER BY subject_name ASC`,
      args: [ssn],
    }), []),
    safeQuery(() => getClient().execute({
      sql: `SELECT date, status, note FROM student_attendance WHERE ssn_encrypted = ? ORDER BY date DESC LIMIT 60`,
      args: [ssn],
    }), []),
    safeQuery(() => getClient().execute({
      sql: `SELECT day, period, start_time, end_time, subject_name, teacher_name FROM class_schedule WHERE grade_level = ? ORDER BY day ASC, period ASC`,
      args: [gradeLevel],
    }), []),
    safeQuery(() => getClient().execute({
      sql: `SELECT id, title, content, category, importance, created_at FROM announcements ORDER BY created_at DESC LIMIT 20`,
      args: [],
    }), []),
  ]);

  // Compute stats.
  const gradeValues = grades.map((g) => parseFloat(g.grade_value)).filter((v) => !isNaN(v));
  const average =
    gradeValues.length > 0
      ? (gradeValues.reduce((a, b) => a + b, 0) / gradeValues.length).toFixed(1)
      : null;

  return {
    student: profile,
    grades: grades.map((g) => ({
      subject_name: g.subject_name,
      grade_value: g.grade_value,
      updated_at: g.updated_at,
      teacher_id: g.teacher_id,
    })),
    average,
    attendance: attendance.map((a) => ({ date: a.date, status: a.status, note: a.note })),
    attendanceStats: computeAttendanceStats(attendance),
    schedule: groupSchedule(schedule),
    announcements: announcements.map((a) => ({
      id: a.id,
      title: a.title,
      content: a.content,
      category: a.category,
      importance: a.importance,
      created_at: a.created_at,
    })),
  };
}

/** Run a query; return [] on any error so a failure never breaks the page. */
async function safeQuery(fn, fallback) {
  try {
    const res = await fn();
    return res.rows || fallback;
  } catch (error) {
    return fallback;
  }
}

function computeAttendanceStats(attendance) {
  const stats = { present: 0, absent: 0, late: 0, excused: 0, total: attendance.length };
  for (const a of attendance) {
    const s = String(a.status).toLowerCase();
    if (s === 'present') stats.present++;
    else if (s === 'absent') stats.absent++;
    else if (s === 'late') stats.late++;
    else if (s === 'excused') stats.excused++;
  }
  stats.percentage = stats.total > 0 ? Math.round((stats.present / stats.total) * 100) : 100;
  return stats;
}

function groupSchedule(rows) {
  const byDay = {};
  for (const row of rows) {
    if (!byDay[row.day]) byDay[row.day] = [];
    byDay[row.day].push({
      period: row.period,
      start_time: row.start_time,
      end_time: row.end_time,
      subject_name: row.subject_name,
      teacher_name: row.teacher_name,
    });
  }
  return byDay;
}

module.exports = { getStudentPortal };
