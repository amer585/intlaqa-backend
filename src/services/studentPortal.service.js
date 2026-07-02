'use strict';

const { getClient } = require('../db/client');
const { getCacheAsync, setCache } = require('../db/diskCache');
const AppError = require('../lib/AppError');
const { assert14DigitSsn, assertGradeLevel } = require('../utils/validation');

// Never-expire: cached portal data served from disk on every read until a write
// invalidates it. If HF disk is wiped, cache rebuilds from Turso on first read.
const CACHE_TTL_SEC = 0;

/**
 * Fetch the FULL student portal from a SINGLE database row.
 *
 * All per-student data (grades, attendance, weekly assessments) is stored as
 * JSON columns ON the students row, so this reads exactly ONE row from Turso
 * (plus the shared schedule + announcements). That's the minimum possible
 * read cost — no table scans, no joins, no per-subject rows.
 *
 * With the disk cache, repeat reads cost ZERO Turso reads.
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

  // ── SINGLE row read: profile + all JSON columns in one query ──
  let profileRes;
  try {
    profileRes = await getClient().execute({
      sql: `SELECT ssn_encrypted, student_name_ar, gender, gov_code, admin_zone,
                   school_name, grade_level, class_name,
                   grades_json, attendance_json, weekly_json
              FROM students WHERE ssn_encrypted = ? LIMIT 1`,
      args: [ssn],
    });
  } catch (error) {
    throw new AppError(500, 'Failed to fetch student profile', error.message);
  }
  if (profileRes.rows.length === 0) {
    throw new AppError(404, 'Student not found.');
  }
  const row = profileRes.rows[0];

  // Parse all JSON columns from the single row.
  const gradesObj = parseJson(row.grades_json, {});
  const attendanceArr = parseJson(row.attendance_json, []);
  const weeklyObj = parseJson(row.weekly_json, {});

  // Build grades array.
  const grades = Object.entries(gradesObj)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([subject_name, grade_value]) => ({
      subject_name,
      grade_value: String(grade_value),
    }))
    .sort((a, b) => a.subject_name.localeCompare(b.subject_name, 'ar'));

  // Compute average.
  const gradeValues = grades.map((g) => parseFloat(g.grade_value)).filter((v) => !isNaN(v));
  const average =
    gradeValues.length > 0
      ? (gradeValues.reduce((a, b) => a + b, 0) / gradeValues.length).toFixed(1)
      : null;

  // Compute attendance stats.
  const attendanceStats = computeAttendanceStats(attendanceArr);
  const absenceLimit = {
    used: attendanceArr.filter((a) => String(a.status).toLowerCase() === 'absent').length,
    limit: 30,
    remaining: Math.max(0, 30 - attendanceArr.filter((a) => String(a.status).toLowerCase() === 'absent').length),
  };

  // ── Shared data: schedule + announcements (small, cached by the disk cache) ──
  const [schedule, announcements] = await Promise.all([
    safeQuery(() => getClient().execute({
      sql: `SELECT day, period, start_time, end_time, subject_name, teacher_name FROM class_schedule WHERE grade_level = ? ORDER BY day ASC, period ASC`,
      args: [gradeLevel],
    }), []),
    safeQuery(() => getClient().execute({
      sql: `SELECT id, title, content, category, importance, created_at FROM announcements ORDER BY created_at DESC LIMIT 20`,
      args: [],
    }), []),
  ]);

  // Build the result.
  const result = {
    student: {
      ssn_encrypted: row.ssn_encrypted,
      student_name_ar: row.student_name_ar,
      gender: row.gender,
      gov_code: row.gov_code,
      admin_zone: row.admin_zone,
      school_name: row.school_name,
      grade_level: row.grade_level,
      class_name: row.class_name,
    },
    grades,
    average,
    weeklyAssessments: weeklyObj,
    attendance: attendanceArr,
    attendanceStats,
    absenceLimit,
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

  // Write-through to disk cache.
  await setCache(cacheKey, result, CACHE_TTL_SEC);

  return result;
}

/** Safe JSON parse with fallback. */
function parseJson(raw, fallback) {
  try {
    return typeof raw === 'string' && raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

/** Run a query; return [] on any error so a failure never breaks the page. */
async function safeQuery(fn, fallback) {
  try {
    const res = await fn();
    return res.rows || fallback;
  } catch {
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
