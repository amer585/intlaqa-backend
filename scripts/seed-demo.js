'use strict';

/**
 * Phase A3 — demo seed (idempotent, re-runnable).
 *
 * Inserts one demo student + admin staff + verified teacher + the relations
 * between them, into both Turso DBs:
 *   STUDENT DB (DATABASE_URL):
 *     - 1 admin staff            (staff.username=admin, role=admin)
 *     - 1 school row             (مدرسة النيل التجريبية)
 *     - 1 student                (29601011234567 / محمد أحمد إبراهيم / grade 8 / class 1/8)
 *     - 5 subject grades         (subject_name + grade_value TEXT, e.g. "18/20")
 *     - 10 attendance rows       (past ~14 days; mostly present, 1 late, 1 absent)
 *     - 6 weekly assessments     (2 weeks x 3 subjects; score + max_score REAL)
 *     - 3 activity_logs rows     (action_type INTEGER: 1=LOGIN, 3=VIEW_PROFILE, 4=VIEW_GRADES)
 *     - 5 teacher_classes rows   (authorizes the admin staff_id to edit grades for
 *                                  the demo class for each subject — without these
 *                                  grade.service.js's teacher_classes check would
 *                                  reject the admin's /grades/update calls)
 *   TEACHER DB (TEACHER_DATABASE_URL):
 *     - 1 verified teacher       (demo@intlaqa.test, fixed UUID for idempotency)
 *     - 1 teacher_student_relations row (linking the teacher to the demo student)
 *
 * Run:  npm run seed-demo    (or:  node scripts/seed-demo.js)
 * Re-running safely updates the demo data (INSERT ... ON CONFLICT DO UPDATE / DO NOTHING).
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client');

// ── Demo constants ───────────────────────────────────────────────────────────
const DEMO = {
  STUDENT_SSN: '29601011234567',          // 14-digit; assert14DigitSsn-valid
  STUDENT_NAME: 'محمد أحمد إبراهيم',
  STUDENT_GENDER: 'M',
  GOV_CODE: '01',                         // Cairo — matches governorates + directorates seeds
  ADMIN_ZONE: 'شمال القاهرة',            // matches the CAI-N directorate (egyptEducation.js)
  SCHOOL_NAME: 'مدرسة النيل التجريبية',
  GRADE_LEVEL: 8,
  CLASS_NAME: '1/8',

  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'Demo-Admin-123!',
  ADMIN_DISPLAY_NAME: 'حساب المشرف التجريبي',

  // Second admin (per spec): the username the user logs in with from the
  // Android app. Same role='admin', same school_name='ALL' scope, and the
  // same teacher_classes authorizations as ADMIN — so heyadmin21 can both
  // browse AND edit grades for the demo class.
  ADMIN2_USERNAME: 'heyadmin21',
  ADMIN2_PASSWORD: 'dfghfdsfgfdsfgghudbyvtg',
  ADMIN2_DISPLAY_NAME: 'حساب المشرف العام',

  // Fixed UUID so the teacher_student_relations row stays valid across re-runs.
  TEACHER_ID: '00000000-0000-0000-0000-000000000001',
  TEACHER_EMAIL: 'demo@intlaqa.test',
  TEACHER_PASSWORD: 'Demo-Teacher-123!',
  TEACHER_NAME: 'أستاذة سارة',
  TEACHER_SUBJECT: 'اللغة العربية',
};

// student_grades: 5 subjects; grade_value is TEXT (the portal parseFloat()s it
// for averaging, so "18/20" -> 18). Stored as "X/20" to match the plan wording
// and to display sensibly without a separate max column on this table.
const SUBJECT_GRADES = [
  { subject_name: 'اللغة العربية',      grade_value: '18/20' },
  { subject_name: 'اللغة الإنجليزية',     grade_value: '17/20' },
  { subject_name: 'الرياضيات',          grade_value: '19/20' },
  { subject_name: 'العلوم',              grade_value: '16/20' },
  { subject_name: 'الدراسات الاجتماعية', grade_value: '15/20' },
];

// weekly_assessments: 2 weeks x 3 subjects; score + max_score are REAL.
const WEEKLY_ASSESSMENTS = [
  { subject_name: 'اللغة العربية',   week_number: 1, score: 8.5, max_score: 10 },
  { subject_name: 'اللغة العربية',   week_number: 2, score: 9.0, max_score: 10 },
  { subject_name: 'الرياضيات',        week_number: 1, score: 7.5, max_score: 10 },
  { subject_name: 'الرياضيات',        week_number: 2, score: 8.0, max_score: 10 },
  { subject_name: 'اللغة الإنجليزية', week_number: 1, score: 9.0, max_score: 10 },
  { subject_name: 'اللغة الإنجليزية', week_number: 2, score: 8.5, max_score: 10 },
];

// activity_logs: action_type INTEGER (1=LOGIN, 2=LOGOUT, 3=VIEW_PROFILE, 4=VIEW_GRADES).
const ACTIVITY_ACTIONS = [
  { action_type: 1, metadata: JSON.stringify({ source: 'seed-demo', note: 'first login' }) },
  { action_type: 3, metadata: JSON.stringify({ source: 'seed-demo', note: 'viewed profile' }) },
  { action_type: 4, metadata: JSON.stringify({ source: 'seed-demo', note: 'viewed grades' }) },
];

/**
 * Build 10 attendance rows over the past ~14 days, skipping the Egyptian
 * weekend (Fri=5, Sat=6). One late entry and one absent entry; rest present.
 * @returns {Array<{ssn_encrypted: string, date: string, status: string, note: string|null}>}
 */
function buildAttendanceRows() {
  const rows = [];
  const today = new Date();
  const cursor = new Date(today);
  let added = 0;
  while (added < 10) {
    const day = cursor.getDay();                 // 0=Sun, 5=Fri, 6=Sat
    if (day !== 5 && day !== 6) {
      let status = 'present';
      if (added === 2) status = 'late';            // 3rd school day -> late
      if (added === 6) status = 'absent';          // 7th school day -> absent
      const iso = cursor.toISOString().slice(0, 10);
      rows.push({
        ssn_encrypted: DEMO.STUDENT_SSN,
        date: iso,
        status,
        note: status === 'late'
          ? 'تأخير 10 دقائق'
          : (status === 'absent' ? 'غيب بدون عذر' : null),
      });
      added++;
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  return rows;
}

// ── DB helpers ──────────────────────────────────────────────────────────────
function openStudentDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing from .env');
  return createClient({ url: process.env.DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
}

function openTeacherDb() {
  if (!process.env.TEACHER_DATABASE_URL) throw new Error('TEACHER_DATABASE_URL is missing from .env');
  return createClient({ url: process.env.TEACHER_DATABASE_URL, authToken: process.env.TEACHER_DATABASE_TOKEN });
}

const exec = (client, sql, args = []) => client.execute({ sql, args });
const writeBatch = (client, stmts) => client.batch(stmts, 'write');

// ── Student-DB seeder ────────────────────────────────────────────────────────
async function seedStudentDb(client) {
  // 1) Admin staff — INSERT OR IGNORE on username UNIQUE. Existing admin is
  //    left intact (idempotent on every re-run; the password is NOT reseeded).
  const adminHash = bcrypt.hashSync(DEMO.ADMIN_PASSWORD, 12);  // rounds=12, matches registerStaff
  await exec(client,
    `INSERT INTO staff (username, password_hash, display_name, role, gov_code, admin_zone, school_name, is_active)
     VALUES (?, ?, ?, 'admin', ?, ?, 'ALL', 1)
     ON CONFLICT(username) DO NOTHING`,
    [DEMO.ADMIN_USERNAME, adminHash, DEMO.ADMIN_DISPLAY_NAME, DEMO.GOV_CODE, DEMO.ADMIN_ZONE]);
  const adminRow = await exec(
    client, `SELECT staff_id FROM staff WHERE username = ? LIMIT 1`, [DEMO.ADMIN_USERNAME]);
  const adminId = Number(adminRow.rows[0].staff_id);

  // 1b) Second admin (heyadmin21) — INSERT OR IGNORE on username UNIQUE so
  //     re-running seed-demo leaves the existing row (and its password) alone.
  //     Same role=admin, same ALL-school scope as the primary admin.
  const admin2Hash = bcrypt.hashSync(DEMO.ADMIN2_PASSWORD, 12);
  await exec(client,
    `INSERT INTO staff (username, password_hash, display_name, role, gov_code, admin_zone, school_name, is_active)
     VALUES (?, ?, ?, 'admin', ?, ?, 'ALL', 1)
     ON CONFLICT(username) DO NOTHING`,
    [DEMO.ADMIN2_USERNAME, admin2Hash, DEMO.ADMIN2_DISPLAY_NAME, DEMO.GOV_CODE, DEMO.ADMIN_ZONE]);
  const admin2Row = await exec(
    client, `SELECT staff_id FROM staff WHERE username = ? LIMIT 1`, [DEMO.ADMIN2_USERNAME]);
  const admin2Id = Number(admin2Row.rows[0].staff_id);

  // 2) School — INSERT OR IGNORE on UNIQUE(gov_code, admin_zone, school_name).
  await exec(client,
    `INSERT INTO schools (gov_code, admin_zone, school_name)
     VALUES (?, ?, ?)
     ON CONFLICT(gov_code, admin_zone, school_name) DO NOTHING`,
    [DEMO.GOV_CODE, DEMO.ADMIN_ZONE, DEMO.SCHOOL_NAME]);

  // 3) Student — INSERT OR REPLACE keyed by ssn_encrypted PK.
  await exec(client,
    `INSERT INTO students (ssn_encrypted, student_name_ar, gender, gov_code, admin_zone, school_name, grade_level, class_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ssn_encrypted) DO UPDATE SET
       student_name_ar = excluded.student_name_ar,
       gender          = excluded.gender,
       gov_code        = excluded.gov_code,
       admin_zone      = excluded.admin_zone,
       school_name     = excluded.school_name,
       grade_level     = excluded.grade_level,
       class_name      = excluded.class_name`,
    [DEMO.STUDENT_SSN, DEMO.STUDENT_NAME, DEMO.STUDENT_GENDER, DEMO.GOV_CODE, DEMO.ADMIN_ZONE,
     DEMO.SCHOOL_NAME, DEMO.GRADE_LEVEL, DEMO.CLASS_NAME]);

  // 4) Subject grades — idempotent via PK (ssn_encrypted, subject_name).
  await writeBatch(client, SUBJECT_GRADES.map((g) => ({
    sql: `INSERT INTO student_grades (ssn_encrypted, subject_name, grade_value, updated_by, updated_at)
          VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(ssn_encrypted, subject_name) DO UPDATE SET
            grade_value = excluded.grade_value,
            updated_by  = excluded.updated_by,
            updated_at  = datetime('now')`,
    args: [DEMO.STUDENT_SSN, g.subject_name, g.grade_value, adminId],
  })));

  // 5) Attendance — idempotent via PK (ssn_encrypted, date).
  const attendance = buildAttendanceRows();
  await writeBatch(client, attendance.map((a) => ({
    sql: `INSERT INTO attendance (ssn_encrypted, date, status, note)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(ssn_encrypted, date) DO UPDATE SET
            status = excluded.status,
            note   = excluded.note`,
    args: [a.ssn_encrypted, a.date, a.status, a.note],
  })));

  // 6) Weekly assessments — idempotent via PK (ssn_encrypted, subject_name, week_number).
  await writeBatch(client, WEEKLY_ASSESSMENTS.map((w) => ({
    sql: `INSERT INTO weekly_assessments (ssn_encrypted, subject_name, week_number, score, max_score)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(ssn_encrypted, subject_name, week_number) DO UPDATE SET
            score     = excluded.score,
            max_score = excluded.max_score`,
    args: [DEMO.STUDENT_SSN, w.subject_name, w.week_number, w.score, w.max_score],
  })));

  // 7) Activity logs — autoincrement PK, so DELETE-then-INSERT for full idempotency.
  await exec(client, `DELETE FROM activity_logs WHERE ssn_encrypted = ?`, [DEMO.STUDENT_SSN]);
  await writeBatch(client, ACTIVITY_ACTIONS.map((a) => ({
    sql: `INSERT INTO activity_logs (ssn_encrypted, action_type, metadata, logged_at)
          VALUES (?, ?, ?, datetime('now'))`,
    args: [DEMO.STUDENT_SSN, a.action_type, a.metadata],
  })));

  // 8) teacher_classes — authorizes the admin staff_id (and now the second
  //    admin heyadmin21) to edit grades for the demo class (grade 8 / class
  //    1/8) for each demo subject. Without these rows updateGrade's
  //    teacher_classes auth check (grade.service.js L72) rejects the admin's
  //    /grades/update calls. Idempotent via PK
  //    (teacher_id, grade_level, class_name, subject_name).
  const classesBatch = [];
  for (const g of SUBJECT_GRADES) {
    classesBatch.push({
      sql: `INSERT INTO teacher_classes (teacher_id, grade_level, class_name, subject_name)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(teacher_id, grade_level, class_name, subject_name) DO NOTHING`,
      args: [adminId, DEMO.GRADE_LEVEL, DEMO.CLASS_NAME, g.subject_name],
    });
    classesBatch.push({
      sql: `INSERT INTO teacher_classes (teacher_id, grade_level, class_name, subject_name)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(teacher_id, grade_level, class_name, subject_name) DO NOTHING`,
      args: [admin2Id, DEMO.GRADE_LEVEL, DEMO.CLASS_NAME, g.subject_name],
    });
  }
  await writeBatch(client, classesBatch);

  return { adminId, admin2Id, attendanceCount: attendance.length };
}

// ── Teacher-DB seeder ─────────────────────────────────────────────────────────
async function seedTeacherDb(client) {
  // 1) Verified teacher account — UPDATE on email conflict so re-running reseeds
  //    the password cleanly. Fixed UUID keeps the linked relation's teacher_id stable.
  const teacherHash = bcrypt.hashSync(DEMO.TEACHER_PASSWORD, 12);
  await exec(client,
    `INSERT INTO teacher_accounts (id, name, email, password_hash, phone, subject, is_verified)
     VALUES (?, ?, ?, ?, NULL, ?, 1)
     ON CONFLICT(email) DO UPDATE SET
       name          = excluded.name,
       password_hash = excluded.password_hash,
       subject       = excluded.subject,
       is_verified   = excluded.is_verified`,
    [DEMO.TEACHER_ID, DEMO.TEACHER_NAME, DEMO.TEACHER_EMAIL, teacherHash, DEMO.TEACHER_SUBJECT]);

  // 2) Teacher -> student link (idempotent via PK). student_id is the cross-DB
  //    soft FK to students.ssn_encrypted in the STUDENT DB.
  await exec(client,
    `INSERT INTO teacher_student_relations (teacher_id, student_id)
     VALUES (?, ?)
     ON CONFLICT(teacher_id, student_id) DO NOTHING`,
    [DEMO.TEACHER_ID, DEMO.STUDENT_SSN]);
}

// ── Driver ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('seed-demo: starting');

  const studentClient = openStudentDb();
  const teacherClient = openTeacherDb();

  try {
    console.log('  -> student DB');
    const { adminId, admin2Id, attendanceCount } = await seedStudentDb(studentClient);
    console.log('     admin staff_id    = ' + adminId + '   (username=' + DEMO.ADMIN_USERNAME + ')');
    console.log('     admin2 staff_id   = ' + admin2Id + '   (username=' + DEMO.ADMIN2_USERNAME + ')');
    console.log('     attendance rows   = ' + attendanceCount);
    console.log('     subject grades    = ' + SUBJECT_GRADES.length);
    console.log('     weekly assessments = ' + WEEKLY_ASSESSMENTS.length);
    console.log('     teacher_class rows = ' + (SUBJECT_GRADES.length * 2) +
                ' (both admins -> demo class)');

    console.log('  -> teacher DB');
    await seedTeacherDb(teacherClient);
    console.log('     teacher account   = ' + DEMO.TEACHER_EMAIL + ' (is_verified=1)');
    console.log('     linked to student = ' + DEMO.STUDENT_SSN);

    console.log('');
    console.log('------------------------------------------------------------');
    console.log('Demo seed complete.');
    console.log('  Student: ' + DEMO.STUDENT_NAME + ' (SSN ' + DEMO.STUDENT_SSN + ')');
    console.log('           grade ' + DEMO.GRADE_LEVEL + ' / class ' + DEMO.CLASS_NAME +
                ' @ ' + DEMO.SCHOOL_NAME + ' (' + DEMO.ADMIN_ZONE + ' / Cairo)');
    console.log('  Admin:    username=' + DEMO.ADMIN_USERNAME +
                '   password=' + DEMO.ADMIN_PASSWORD);
    console.log('  Admin2:   username=' + DEMO.ADMIN2_USERNAME +
                '   password=' + DEMO.ADMIN2_PASSWORD);
    console.log('  Teacher:  email=' + DEMO.TEACHER_EMAIL +
                '   password=' + DEMO.TEACHER_PASSWORD + '  (verified, linked)');
    console.log('------------------------------------------------------------');
  } finally {
    studentClient.close();
    teacherClient.close();
  }
}

main().catch((err) => {
  console.error('seed-demo FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
