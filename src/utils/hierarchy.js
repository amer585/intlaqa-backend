const { resolveGovName } = require('./governorates');
const { normalizeRole, isDistrictManagerRole, isSchoolScopedRole } = require('./roles');

function filterSchoolsForUser(schools, user) {
  const normalizedRole = normalizeRole(user.role);

  if (isDistrictManagerRole(normalizedRole) && user.admin_zone && user.admin_zone !== 'ALL') {
    return schools.filter((school) => school.admin_zone === user.admin_zone);
  }

  if (isSchoolScopedRole(normalizedRole)) {
    return schools.filter((school) => school.school_name === user.school_name);
  }

  return schools;
}

function mapStudentsWithGrades(studentRows, gradeRows, context) {
  const studentsBySsn = new Map();

  for (const row of studentRows) {
    studentsBySsn.set(row.ssn_encrypted, {
      ssn_encrypted: row.ssn_encrypted,
      student_name_ar: row.student_name_ar,
      gender: row.gender,
      gov_code: row.gov_code,
      gov_name: resolveGovName(row.gov_code),
      admin_zone: row.admin_zone,
      school_name: context.school_name,
      grade_level: context.grade_level,
      class_name: context.class_name,
      grades: [],
    });
  }

  for (const row of gradeRows) {
    const student = studentsBySsn.get(row.ssn_encrypted);

    if (!student) {
      continue;
    }

    student.grades.push({
      grade_id: row.grade_id,
      subject_name: row.subject_name,
      grade_value: row.grade_value,
      teacher_id: row.teacher_id,
      updated_at: row.updated_at,
    });
  }

  return Array.from(studentsBySsn.values());
}

module.exports = {
  filterSchoolsForUser,
  mapStudentsWithGrades,
};
