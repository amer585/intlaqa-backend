'use strict';

/**
 * scripts/smoke.js — backend integration smoke against the seeded demo data.
 *
 * Assumes the backend is already running on http://localhost:7860
 * (run `node src/server.js` in another terminal, or `npm run dev`).
 *
 * Run:  node scripts/smoke.js
 *
 * Endpoint checklist (mirrors Phase A4 + the backend slice of Phase D):
 *   1. GET  /api/health
 *   2. GET  /api/status
 *   3. POST /api/login              (demo admin)         -> staff JWT
 *   4. GET  /api/staff/teacher-classes (staff JWT)        -> verifies seeded teacher_classes
 *   5. POST /api/studentLogin       (demo student)       -> student JWT
 *   6. POST /api/student/portal      (student JWT)       -> full portal; SSN taken from JWT (body ignored)
 *   7. POST /api/logAction           (student JWT, own SSN)   -> 200
 *   8. POST /api/logAction           (student JWT, OTHER SSN) -> 403 (anti-impersonation gate)
 *      (also exercises the AppError import fix in routes/index.js L101)
 *   9. POST /api/teacher/login       (demo teacher)      -> teacher JWT
 *  10. GET  /api/teacher/students    (teacher JWT)       -> verifies seeded teacher_student_relations
 *  11. POST /api/grades/update       (staff JWT)         -> bumps one grade; verifies teacher_classes auth
 *  12. POST /api/student/portal      (after bump)        -> proves the cache write-through (new value served)
 *
 * Exits 0 on all pass, 1 on any fail.
 */

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:7860';

const ADMIN = { username: 'admin', password: 'Demo-Admin-123!' };
const STUDENT = { ssn_encrypted: '29601011234567', grade_level: 8 };
const TEACHER = { email: 'demo@intlaqa.test', password: 'Demo-Teacher-123!' };

// Distinct, varied pre/post grade values so each run provably toggles the row
// (and proves the cache was actually invalidated rather than stale-served).
const bumpTo = `20/20`;

/** @type {{name: string, ok: boolean, detail: string}[]} */
const CHECKS = [];
function check(name, cond, detail = '') {
  if (cond) { CHECKS.push({ name, ok: true, detail }); console.log(`  PASS  ${name}  ${detail}`); }
  else { CHECKS.push({ name, ok: false, detail }); console.log(`  FAIL  ${name}  ${detail}`); }
}

async function main() {
  console.log(`A4 smoke test against ${BASE}`);

  // 1. GET /health
  let r = await fetch(`${BASE}/health`);
  let body = await r.json();
  check('GET /health',
    r.status === 200 && body.database?.ok === true && body.teacher_database?.ok === true,
    `(db=${body.database?.ok}, tdb=${body.teacher_database?.ok})`);

  // 2. GET /api/status — fields: db/teacher_db/jwt_secret are string ('configured'/'NOT CONFIGURED'/'fallback (ephemeral)')
  r = await fetch(`${BASE}/api/status`);
  body = await r.json();
  check('GET /api/status',
    r.status === 200 && body.db === 'configured' && body.teacher_db === 'configured' && body.jwt_secret === 'configured',
    `(db=${body.db}, tdb=${body.teacher_db}, jwt=${body.jwt_secret}, cache=${body.cache})`);

  // 3. POST /api/login (demo admin) — { success, token, user: { name, teacher_name_ar, role, ... } }
  r = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  body = await r.json();
  const adminToken = body.token;
  check('POST /api/login (admin)',
    r.status === 200 && !!adminToken && body.success === true && body.user?.role === 'admin',
    `(role=${body.user?.role}, name=${body.user?.teacher_name_ar}, hasToken=${!!adminToken})`);

  // 4. GET /api/staff/teacher-classes (admin JWT) — verifies seeded teacher_classes
  r = await fetch(`${BASE}/api/staff/teacher-classes`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  body = await r.json();
  const matched = (body.assignments || []).filter(
    a => Number(a.grade_level) === 8 && String(a.class_name) === '1/8',
  );
  check('GET /api/staff/teacher-classes',
    r.status === 200 && matched.length === 5,
    `(matches for grade 8 / class 1/8 = ${matched.length})`);

  // 5. POST /api/studentLogin (demo student)
  r = await fetch(`${BASE}/api/studentLogin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(STUDENT),
  });
  body = await r.json();
  const studentToken = body.token;
  check('POST /api/studentLogin',
    r.status === 200 && !!studentToken && body.student?.ssn_encrypted === STUDENT.ssn_encrypted,
    `(name=${body.student?.student_name_ar}, hasToken=${!!studentToken})`);

  // 6. POST /api/student/portal (student JWT) — body SSN MUST be ignored (anti-impersonation)
  r = await fetch(`${BASE}/api/student/portal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${studentToken}` },
    body: JSON.stringify({ ssn_encrypted: '11111111111111', grade_level: 1 }), // wrong on purpose
  });
  body = await r.json();
  const weeklySubjectsCount = Object.keys(body.weeklyAssessments || {}).length;
  check('POST /api/student/portal (student JWT, body ignored)',
    r.status === 200 && body.student?.ssn_encrypted === STUDENT.ssn_encrypted &&
      (body.grades?.length === 5) && (body.attendance?.length === 10) && weeklySubjectsCount >= 3,
    `(ssn_from_jwt=${body.student?.ssn_encrypted}, grades=${body.grades?.length}, ` +
    `att=${body.attendance?.length}, weekly_subjects=${weeklySubjectsCount})`);

  // Record the pre-bump value for the write-through assertion.
  const preBump = (body.grades || []).find(g => g.subject_name === 'اللغة العربية');
  const preBumpValue = preBump ? preBump.grade_value : '(missing)';

  // 7. POST /api/logAction (student JWT, OWN SSN) -> 200
  r = await fetch(`${BASE}/api/logAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${studentToken}` },
    body: JSON.stringify([{ ssn_encrypted: STUDENT.ssn_encrypted, grade_level: 8, action_type: 4 }]),
  });
  body = await r.json();
  check('POST /api/logAction (own SSN -> 200)',
    r.status === 200,
    `(status=${r.status})`);

  // 8. POST /api/logAction (student JWT, OTHER SSN) -> 403 (anti-impersonation gate;
  //    also exercises the AppError import fix in routes/index.js L101)
  r = await fetch(`${BASE}/api/logAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${studentToken}` },
    body: JSON.stringify([{ ssn_encrypted: '99999999999999', grade_level: 8, action_type: 4 }]),
  });
  body = await r.json();
  check('POST /api/logAction (impersonation -> 403)',
    r.status === 403,
    `(status=${r.status}, msg=${body.error || body.message || ''})`);

  // 9. POST /api/teacher/login (demo teacher)
  r = await fetch(`${BASE}/api/teacher/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(TEACHER),
  });
  body = await r.json();
  const teacherToken = body.token;
  check('POST /api/teacher/login',
    r.status === 200 && !!teacherToken && body.account?.email === TEACHER.email &&
      body.account?.is_verified === true,
    `(email=${body.account?.email}, verified=${body.account?.is_verified}, ` +
    `hasToken=${!!teacherToken})`);

  // 10. GET /api/teacher/students (teacher JWT) — verifies the seeded teacher_student_relations link
  r = await fetch(`${BASE}/api/teacher/students`, {
    headers: { Authorization: `Bearer ${teacherToken}` },
  });
  body = await r.json();
  const linked = (body.students || []).find(s => s.student_id === STUDENT.ssn_encrypted);
  check('GET /api/teacher/students',
    r.status === 200 && !!linked && linked.student_name_ar === 'محمد أحمد إبراهيم',
    `(name=${linked?.student_name_ar}, grade=${linked?.grade_level}, class=${linked?.class_name})`);

  // 11. POST /api/grades/update (admin JWT) — verifies seeded teacher_classes authorize admin
  r = await fetch(`${BASE}/api/grades/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify([{
      grade_level: 8, class_name: '1/8', subject_name: 'اللغة العربية',
      ssn_encrypted: STUDENT.ssn_encrypted, grade_value: bumpTo,
    }]),
  });
  body = await r.json();
  check('POST /api/grades/update (admin edits demo grade)',
    r.status === 200 && body.updated === 1,
    `(updated=${body.updated}, msg=${body.message || ''})`);

  // 12. POST /api/student/portal (after grade bump) — proves cache write-through:
  //     the bumped value MUST be served (otherwise disk-never-expire cache would
  //     keep serving the pre-bump row).
  r = await fetch(`${BASE}/api/student/portal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${studentToken}` },
    body: JSON.stringify({}),
  });
  body = await r.json();
  const bumpedGrade = (body.grades || []).find(g => g.subject_name === 'اللغة العربية');
  const bumpedValue = bumpedGrade ? bumpedGrade.grade_value : '(missing)';
  check('POST /api/student/portal (cache write-through: bumped value served)',
    bumpedValue === bumpTo,
    `(pre=${preBumpValue}  post=${bumpedValue}  expected=${bumpTo})`);

  // Summary
  const pass = CHECKS.filter(c => c.ok).length;
  const fail = CHECKS.filter(c => !c.ok).length;
  console.log('');
  console.log(`RESULT: ${pass} pass / ${fail} fail / ${CHECKS.length} total`);
  if (fail > 0) {
    console.log('FAILURES:');
    for (const c of CHECKS.filter(c => !c.ok)) console.log('  - ' + c.name + '  ' + c.detail);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('smoke FATAL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
