const { config, getDbUrl } = require('../config');
const { withConnection } = require('../db/pools');
const AppError = require('../lib/AppError');
const { filterSchoolsForUser, mapStudentsWithGrades } = require('../utils/hierarchy');
const { isDistrictManagerRole, isSchoolScopedRole, normalizeRole } = require('../utils/roles');
const { requireFields } = require('../utils/validation');

let schoolCache = { data: null, lastFetched: 0 };

async function getSchoolsForUser(user) {
  const now = Date.now();

  if (Array.isArray(schoolCache.data) && (now - schoolCache.lastFetched) < config.schoolCacheTtlMs) {
    return filterSchoolsForUser(schoolCache.data, user);
  }

  try {
    const schools = await withConnection(config.dbUrls.primary, async (connection) => {
      const [rows] = await connection.execute(
        `SELECT DISTINCT school_name, admin_zone
         FROM test.teachers
         WHERE school_name != 'ALL'
         ORDER BY admin_zone ASC, school_name ASC`
      );

      return rows;
    });

    schoolCache = {
      data: schools,
      lastFetched: now,
    };

    return filterSchoolsForUser(schools, user);
  } catch (error) {
    if (Array.isArray(schoolCache.data)) {
      return filterSchoolsForUser(schoolCache.data, user);
    }

    throw new AppError(500, 'Failed to fetch schools', error.message);
  }
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
        SELECT ssn_encrypted, student_name_ar, gender, gov_code, admin_zone
        FROM test.students
        WHERE school_name = ?
          AND grade_level = ?
          AND class_name = ?`;
      const studentParams = [schoolName, numericGradeLevel, className];

      if (isDistrictManagerRole(normalizedRole) && user.admin_zone && user.admin_zone !== 'ALL') {
        studentQuery += ' AND admin_zone = ?';
        studentParams.push(user.admin_zone);
      }

      studentQuery += ' ORDER BY student_name_ar ASC';

      const [studentRows] = await connection.execute(studentQuery, studentParams);

      if (studentRows.length === 0) {
        return [];
      }

      const ssnPlaceholders = studentRows.map(() => '?').join(', ');
      const ssnParams = studentRows.map((row) => row.ssn_encrypted);

      const [gradeRows] = await connection.execute(
        `SELECT ssn_encrypted, grade_id, subject_name, grade_value, teacher_id, updated_at
         FROM test.student_grades
         WHERE ssn_encrypted IN (${ssnPlaceholders})
         ORDER BY ssn_encrypted ASC, subject_name ASC`,
        ssnParams
      );

      return mapStudentsWithGrades(studentRows, gradeRows, {
        school_name: schoolName,
        grade_level: numericGradeLevel,
        class_name: className,
      });
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(500, 'Failed to fetch students', error.message);
  }
}

module.exports = {
  getSchoolsForUser,
  getStudentsForHierarchy,
};
