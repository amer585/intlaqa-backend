const { config, getDbUrl } = require('../config');
const { withConnection } = require('../db/pools');
const AppError = require('../lib/AppError');
const { filterSchoolsForUser, mapJoinedStudentsWithGrades } = require('../utils/hierarchy');
const {
  isDirectorateRole,
  isDistrictOnlyRole,
  isSchoolScopedRole,
  normalizeRole,
} = require('../utils/roles');
const { requireFields } = require('../utils/validation');

let schoolCache = { data: null, lastFetched: 0 };

function getScopedSchoolList(user) {
  const now = Date.now();

  if (Array.isArray(schoolCache.data) && (now - schoolCache.lastFetched) < config.schoolCacheTtlMs) {
    return filterSchoolsForUser(schoolCache.data, user);
  }

  return null;
}

async function loadSchools() {
  const now = Date.now();

  if (Array.isArray(schoolCache.data) && (now - schoolCache.lastFetched) < config.schoolCacheTtlMs) {
    return schoolCache.data;
  }

  try {
    const schools = await withConnection(config.dbUrls.primary, async (connection) => {
      const [rows] = await connection.execute(
        `SELECT DISTINCT school_name, admin_zone, gov_code
         FROM test.teachers
         WHERE school_name != 'ALL'
         ORDER BY gov_code ASC, admin_zone ASC, school_name ASC`
      );

      return rows;
    });

    schoolCache = {
      data: schools,
      lastFetched: now,
    };

    return schools;
  } catch (error) {
    if (Array.isArray(schoolCache.data)) {
      return schoolCache.data;
    }

    throw new AppError(500, 'Failed to fetch schools', error.message);
  }
}

async function getSchoolsForUser(user, query = {}) {
  const cachedSchools = getScopedSchoolList(user);
  const schools = cachedSchools || filterSchoolsForUser(await loadSchools(), user);
  const districtName = String(query.district || '').trim();

  if (!districtName) {
    return schools;
  }

  const normalizedRole = normalizeRole(user.role);

  if (isDistrictOnlyRole(normalizedRole) && user.admin_zone && user.admin_zone !== districtName) {
    throw new AppError(403, 'Forbidden: You can only fetch schools from your assigned district.');
  }

  if (
    isDirectorateRole(normalizedRole) &&
    user.gov_code &&
    !schools.some((school) => school.admin_zone === districtName)
  ) {
    throw new AppError(403, 'Forbidden: The requested district is outside your directorate scope.');
  }

  return schools.filter((school) => school.admin_zone === districtName);
}

async function getDistrictsForUser(user) {
  const schools = filterSchoolsForUser(await loadSchools(), user);
  const normalizedRole = normalizeRole(user.role);

  if (isDistrictOnlyRole(normalizedRole) && user.admin_zone && user.admin_zone !== 'ALL') {
    return [{ district_name: user.admin_zone }];
  }

  const districts = Array.from(
    new Set(
      schools
        .map((school) => school.admin_zone)
        .filter((adminZone) => typeof adminZone === 'string' && adminZone.trim().length > 0)
    )
  ).sort((left, right) => left.localeCompare(right));

  return districts.map((districtName) => ({ district_name: districtName }));
}

function getClassQueryTargets(gradeLevel) {
  if (gradeLevel !== null) {
    const dbUrl = getDbUrl(gradeLevel);

    if (!dbUrl) {
      throw new AppError(400, `Invalid grade_level: ${gradeLevel}`);
    }

    return [dbUrl];
  }

  return Array.from(new Set(Object.values(config.dbUrls).filter(Boolean)));
}

async function getClassesForHierarchy(query, user) {
  requireFields(query, ['school_name'], 'school_name is required.');

  const schoolName = String(query.school_name || '').trim();
  const normalizedRole = normalizeRole(user.role);
  const parsedGradeLevel = query.grade_level === undefined || query.grade_level === null || query.grade_level === ''
    ? null
    : Number(query.grade_level);

  if (parsedGradeLevel !== null && !Number.isInteger(parsedGradeLevel)) {
    throw new AppError(400, `Invalid grade_level: ${query.grade_level}`);
  }

  if (isSchoolScopedRole(normalizedRole) && schoolName !== user.school_name) {
    throw new AppError(403, 'Forbidden: You can only fetch classes from your assigned school.');
  }

  const targets = getClassQueryTargets(parsedGradeLevel);
  const classLists = await Promise.all(
    targets.map((dbUrl) =>
      withConnection(dbUrl, async (connection) => {
        const params = [schoolName];
        let classQuery = `
          SELECT class_name, grade_level, COUNT(*) AS student_count
          FROM test.students
          WHERE school_name = ?
            AND class_name IS NOT NULL
            AND class_name != ''`;

        if (parsedGradeLevel !== null) {
          classQuery += ' AND grade_level = ?';
          params.push(parsedGradeLevel);
        }

        if (isDistrictOnlyRole(normalizedRole) && user.admin_zone && user.admin_zone !== 'ALL') {
          classQuery += ' AND admin_zone = ?';
          params.push(user.admin_zone);
        }

        if (isDirectorateRole(normalizedRole) && user.gov_code) {
          classQuery += ' AND gov_code = ?';
          params.push(user.gov_code);
        }

        classQuery += `
          GROUP BY class_name, grade_level
          ORDER BY grade_level ASC, class_name ASC`;

        const [rows] = await connection.execute(classQuery, params);
        return rows;
      })
    )
  );

  return classLists
    .flat()
    .sort((left, right) => {
      if (left.grade_level !== right.grade_level) {
        return left.grade_level - right.grade_level;
      }

      return String(left.class_name).localeCompare(String(right.class_name));
    });
}

async function getStudentsForHierarchy(query, user) {
  requireFields(
    query,
    ['school_name', 'grade_level', 'class_name'],
    'school_name, grade_level, and class_name are required.'
  );

  const schoolName = query.school_name;
  const gradeLevel = query.grade_level;
  const className = query.class_name;
  const normalizedRole = normalizeRole(user.role);
  const numericGradeLevel = Number(gradeLevel);
  const dbUrl = getDbUrl(numericGradeLevel);

  if (!dbUrl) {
    throw new AppError(400, `Invalid grade_level: ${gradeLevel}`);
  }

  if (isSchoolScopedRole(normalizedRole) && schoolName !== user.school_name) {
    throw new AppError(403, 'Forbidden: You can only fetch students from your assigned school.');
  }

  try {
    return await withConnection(dbUrl, async (connection) => {
      let studentQuery = `
        SELECT
          students.ssn_encrypted,
          students.student_name_ar,
          students.gender,
          students.gov_code,
          students.admin_zone,
          students.school_name,
          students.grade_level,
          students.class_name,
          student_grades.grade_id,
          student_grades.subject_name,
          student_grades.grade_value,
          student_grades.teacher_id,
          student_grades.updated_at
        FROM test.students
        LEFT JOIN test.student_grades
          ON student_grades.ssn_encrypted = students.ssn_encrypted
         AND student_grades.grade_level = students.grade_level
         AND student_grades.class_name = students.class_name
        WHERE students.school_name = ?
          AND students.grade_level = ?
          AND students.class_name = ?`;
      const studentParams = [schoolName, numericGradeLevel, className];

      if (isDistrictOnlyRole(normalizedRole) && user.admin_zone && user.admin_zone !== 'ALL') {
        studentQuery += ' AND students.admin_zone = ?';
        studentParams.push(user.admin_zone);
      }

      if (isDirectorateRole(normalizedRole) && user.gov_code) {
        studentQuery += ' AND students.gov_code = ?';
        studentParams.push(user.gov_code);
      }

      studentQuery += ' ORDER BY students.student_name_ar ASC, student_grades.subject_name ASC';

      const [rows] = await connection.execute(studentQuery, studentParams);

      if (rows.length === 0) {
        return [];
      }

      return mapJoinedStudentsWithGrades(rows);
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(500, 'Failed to fetch students', error.message);
  }
}

module.exports = {
  getDistrictsForUser,
  getSchoolsForUser,
  getClassesForHierarchy,
  getStudentsForHierarchy,
};
