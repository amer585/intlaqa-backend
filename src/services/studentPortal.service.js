'use strict';

const { getClient } = require('../db/client');
const { getCacheAsync, setCache } = require('../db/diskCache');
const AppError = require('../lib/AppError');
const { assert14DigitSsn, assertGradeLevel } = require('../utils/validation');

// Never-expire: cached portal data is served from disk on every subsequent
// read (zero Turso reads) until a write invalidates the key. If the HF disk is
// wiped on restart, the cache is rebuilt automatically from Turso on the first
// read. This is the write-through cache-aside pattern.
const CACHE_TTL_SEC = 0;

/**
 * Fetch the full student portal: profile, grades, attendance, schedule,
 * and announcements. Uses a read-through DISK cache: try local cache first
 * (survives process restarts within the same container), then Turso, then
 * write-through to cache. This reduces reads to Turso significantly.
 *
 * @param {{ ssn_encrypted?: string, grade_level?: number }} query
 */
async function getStudentPortal(query = {}) {
  if (!query.ssn_encrypted) throw new AppError(400, 'ssn_encrypted is required.');
  assert14DigitSsn(query.ssn_encrypted);
  const gradeLevel = assertGradeLevel(query.grade_level);
  const ssn = String(query.ssn_encrypted);

  // ── Read-through: check disk cache first ──
  const cacheKey = `portal:${ssn}:${gradeLevel}`;
  const cached = await getCacheAsync(cacheKey);
  if (cached) {
    return cached;
  }

  // 1. Profile + grades_json (all subjects in ONE column) — single query.
  let profileRes;
  try {
    profileRes = await getClient().execute({
      sql: `SELECT ssn_encrypted, student_name_ar, gender, gov_code, admin_zone, school_name, grade_level, class_name, grades_json
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

  // Parse the single-column grades JSON into the grades array.
  let gradesObj = {};
  try {
    gradesObj = typeof profile.grades_json === 'string' && profile.grades_json
      ? JSON.parse(profile.grades_json)
      : {};
  } catch {
    gradesObj = {};
  }
  const grades = Object.entries(gradesObj).map(([subject_name, grade_value]) => ({
    subject_name,
    grade_value: String(grade_value),
    updated_at: null,
    teacher_id: null,
  }));

  // 2-5. Optional sections (grades now come from the single grades_json column
  // parsed above, so they're no longer queried separately).
  const [attendance, schedule, announcements, weeklyAssessments] = await Promise.all([
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
    safeQuery(() => getClient().execute({
      sql: `SELECT subject_name, week_number, score, max_score FROM weekly_assessments WHERE ssn_encrypted = ? ORDER BY subject_name ASC, week_number ASC`,
      args: [ssn],
    }), []),
  ]);

  // Compute stats.
  const gradeValues = grades.map((g) => parseFloat(g.grade_value)).filter((v) => !isNaN(v));
  const average =
    gradeValues.length > 0
      ? (gradeValues.reduce((a, b) => a + b, 0) / gradeValues.length).toFixed(1)
      : null;

  // Group weekly assessments by subject.
  const weeklyBySubject = {};
  for (const wa of weeklyAssessments) {
    if (!weeklyBySubject[wa.subject_name]) {
      weeklyBySubject[wa.subject_name] = [];
    }
    weeklyBySubject[wa.subject_name].push({
      week: wa.week_number,
      score: wa.score,
      max_score: wa.max_score,
    });
  }

  // Build the full result.
  const result = {
    student: profile,
    grades: grades.sort((a, b) => a.subject_name.localeCompare(b.subject_name, 'ar')),
    average,
    weeklyAssessments: weeklyBySubject,
    attendance: attendance.map((a) => ({ date: a.date, status: a.status, note: a.note })),
    attendanceStats: computeAttendanceStats(attendance),
    absenceLimit: {
      used: attendance.filter((a) => String(a.status).toLowerCase() === 'absent').length,
      limit: 30,
      remaining: Math.max(0, 30 - attendance.filter((a) => String(a.status).toLowerCase() === 'absent').length),
    },
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

  // ── Write-through to disk cache so subsequent reads skip Turso ──
  await setCache(cacheKey, result, CACHE_TTL_SEC);

  return result;
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
