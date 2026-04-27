const test = require('node:test');
const assert = require('node:assert/strict');

const { filterSchoolsForUser, mapStudentsWithGrades } = require('../src/utils/hierarchy');

test('school filtering keeps only the relevant schools for district and school-scoped users', () => {
  const schools = [
    { school_name: 'A', admin_zone: 'Z1' },
    { school_name: 'B', admin_zone: 'Z2' },
  ];

  assert.deepEqual(
    filterSchoolsForUser(schools, { role: 'district', admin_zone: 'Z1' }),
    [{ school_name: 'A', admin_zone: 'Z1' }]
  );

  assert.deepEqual(
    filterSchoolsForUser(schools, { role: 'teacher', school_name: 'B' }),
    [{ school_name: 'B', admin_zone: 'Z2' }]
  );
});

test('student-grade mapper avoids duplicated student payloads while preserving grades', () => {
  const students = [
    {
      ssn_encrypted: '11111111111111',
      student_name_ar: 'Student One',
      gender: 'F',
      gov_code: '1',
      admin_zone: 'Zone A',
    },
  ];

  const grades = [
    {
      ssn_encrypted: '11111111111111',
      grade_id: 1,
      subject_name: 'Math',
      grade_value: 95,
      teacher_id: 10,
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    {
      ssn_encrypted: '11111111111111',
      grade_id: 2,
      subject_name: 'Science',
      grade_value: 98,
      teacher_id: 11,
      updated_at: '2026-01-02T00:00:00.000Z',
    },
  ];

  const result = mapStudentsWithGrades(students, grades, {
    school_name: 'School A',
    grade_level: 5,
    class_name: '5A',
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].school_name, 'School A');
  assert.equal(result[0].grades.length, 2);
  assert.equal(result[0].grades[1].subject_name, 'Science');
});
