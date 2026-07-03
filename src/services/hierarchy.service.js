'use strict';

const { config, getDbUrl } = require('../config/env');
const { withConnection } = require('../db/client');
const AppError = require('../lib/AppError');
const {
  isDirectorateRole,
  isDistrictOnlyRole,
  isSchoolScopedRole,
  normalizeRole,
} = require('../utils/roles');
const { requireFields, assertGradeLevel } = require('../utils/validation');

// TTL cache with in-flight dedupe (per-instance; fine for a single HF replica).
let schoolCache = { data: null, lastFetched: 0, inflight: null };

async function loadSchools() {
  const now = Date.now();
  if (Array.isArray(schoolCache.data) && now - schoolCache.lastFetched < config.schoolCacheTtlMs) {
    return schoolCache.data;
  }
  if (schoolCache.inflight) return schoolCache.inflight;

  schoolCache.inflight = (async () => {
    try {
      const schools = await withConnection(async (db) => {
        const { rows } = await db.execute(
          `SELECT DISTINCT school_name, admin_zone, gov_code
             FROM teachers
            WHERE school_name IS NOT NULL AND school_name <> 'ALL'
            ORDER BY gov_code ASC, admin_zone ASC, school_name ASC`,
        );
        return rows;
      });
      schoolCache = { data: schools, lastFetched: Date.now(), inflight: null };
      return schools;
    } catch (error) {
      schoolCache.inflight = null;
      if (Array.isArray(schoolCache.data)) return schoolCache.data; // serve stale
      throw new AppError(500, 'Failed to fetch schools', error.message);
    }
  })();

  return schoolCache.inflight;
}

/** Apply the caller's scope to the full school list. */
function filterSchoolsForUser(schools, user) {
  const role = normalizeRole(user.role);
  if (isSchoolScopedRole(role)) return schools.filter((s) => s.school_name === user.school_name);
  if (isDistrictOnlyRole(role) && user.admin_zone && user.admin_zone !== 'ALL') {
    return schools.filter((s) => s.admin_zone === user.admin_zone);
  }
  if (isDirectorateRole(role) && user.gov_code) {
    return schools.filter((s) => s.gov_code === user.gov_code);
  }
  return schools;
}

async function getSchoolsForUser(user, query = {}) {
  const schools = filterSchoolsForUser(await loadSchools(), user);
  const districtName = String(query.district || '').trim();
  if (!districtName) return schools;

  const role = normalizeRole(user.role);
  if (isDistrictOnlyRole(role) && user.admin_zone && user.admin_zone !== districtName) {
    throw new AppError(403, 'Forbidden: You can only fetch schools from your assigned district.');
  }
  return schools.filter((s) => s.admin_zone === districtName);
}

async function getDistrictsForUser(user) {
  const schools = filterSchoolsForUser(await loadSchools(), user);
  const role = normalizeRole(user.role);
  if (isDistrictOnlyRole(role) && user.admin_zone && user.admin_zone !== 'ALL') {
    return [{ district_name: user.admin_zone }];
  }
  const districts = Array.from(
    new Set(schools.map((s) => s.admin_zone).filter((z) => typeof z === 'string' && z.trim().length > 0)),
  ).sort((a, b) => String(a).localeCompare(String(b)));
  return districts.map((name) => ({ district_name: name }));
}

async function getClassesForHierarchy(query = {}, user = {}) {
  requireFields(query, ['school_name'], 'school_name is required.');
  const schoolName = String(query.school_name).trim();
  const role = normalizeRole(user.role);

  const gradeLevel =
    query.grade_level === undefined || query.grade_level === null || query.grade_level === ''
      ? null
      : assertGradeLevel(query.grade_level);

  if (isSchoolScopedRole(role) && schoolName !== user.school_name) {
    throw new AppError(403, 'Forbidden: You can only fetch classes from your assigned school.');
  }

  return withConnection(async (db) => {
    const params = [schoolName];
    let sql = `SELECT class_name, grade_level, COUNT(*) AS student_count
                 FROM students
                WHERE school_name = ? AND class_name IS NOT NULL AND class_name <> ''`;
    if (gradeLevel !== null) {
      sql += ' AND grade_level = ?';
      params.push(gradeLevel);
    }
    if (isDistrictOnlyRole(role) && user.admin_zone && user.admin_zone !== 'ALL') {
      sql += ' AND admin_zone = ?';
      params.push(user.admin_zone);
    }
    if (isDirectorateRole(role) && user.gov_code) {
      sql += ' AND gov_code = ?';
      params.push(user.gov_code);
    }
    sql += ' GROUP BY class_name, grade_level ORDER BY grade_level ASC, class_name ASC';
    const { rows } = await db.execute(sql, params);
    return rows;
  });
}

async function getStudentsForHierarchy(query = {}, user = {}) {
  requireFields(query, ['school_name', 'grade_level', 'class_name'], 'school_name, grade_level, and class_name are required.');
  const schoolName = String(query.school_name).trim();
  const className = String(query.class_name).trim();
  const gradeLevel = assertGradeLevel(query.grade_level);
  const subjectName = query.subject_name ? String(query.subject_name).trim() : null;
  const role = normalizeRole(user.role);

  if (!getDbUrl(gradeLevel)) throw new AppError(400, `Invalid grade_level: ${query.grade_level}`);
  if (isSchoolScopedRole(role) && schoolName !== user.school_name) {
    throw new AppError(403, 'Forbidden: You can only fetch students from your assigned school.');
  }

  // SINGLE-table read (uses the covering idx_class_lookup index). Grades live
  // in students.grades_json, so there's NO join — one small row-set, no scan.
  try {
    return await withConnection(async (db) => {
      const { rows } = await db.execute(
        `SELECT ssn_encrypted, student_name_ar, gender, grades_json
           FROM students
          WHERE school_name = ? AND grade_level = ? AND class_name = ?
          ORDER BY student_name_ar ASC
          LIMIT 500`,
        [schoolName, gradeLevel, className],
      );
      return { students: mapRosterWithGrades(rows, subjectName) };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Failed to fetch students', error.message);
  }
}

/**
 * Collapse rows into one object per student. Reads grades from the
 * grades_json column (single-table) instead of an expensive JOIN against the
 * legacy student_grades table (which no longer exists after migration).
 * When subjectName is set, only that subject's grade is surfaced — otherwise
 * all subjects are returned.
 */
function mapRosterWithGrades(rows, subjectName = null) {
  return rows.map((row) => {
    const all = parseGradesJson(row.grades_json);
    const grades = subjectName
      ? (all[subjectName] !== undefined && all[subjectName] !== null && all[subjectName] !== ''
          ? [{ subject_name: subjectName, grade_value: String(all[subjectName]) }]
          : [])
      : Object.entries(all)
          .filter(([, v]) => v !== null && v !== undefined && v !== '')
          .map(([subject_name, grade_value]) => ({ subject_name, grade_value: String(grade_value) }));
    return {
      ssn_encrypted: row.ssn_encrypted,
      student_name_ar: row.student_name_ar,
      gender: row.gender,
      grades,
    };
  });
}

/** Parse the grades_json column into a plain object. */
function parseGradesJson(raw) {
  try {
    const parsed = typeof raw === 'string' && raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

module.exports = {
  getSchoolsForUser,
  getDistrictsForUser,
  getClassesForHierarchy,
  getStudentsForHierarchy,
};
