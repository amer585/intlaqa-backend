'use strict';

const logger = require('../lib/logger');

/**
 * Idempotent schema bootstrap for Turso/libSQL (SQLite). Runs on every boot
 * via CREATE TABLE IF NOT EXISTS so a fresh database just works.
 * @param {{ execute: (sql: string, args?: unknown[]) => Promise<unknown> }} db
 */
async function runMigrations(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS teachers (
       teacher_id      INTEGER PRIMARY KEY AUTOINCREMENT,
       username        TEXT NOT NULL UNIQUE,
       password_hash   TEXT NOT NULL,
       teacher_name_ar TEXT,
       role            TEXT NOT NULL DEFAULT 'teacher',
       gov_code        TEXT,
       admin_zone      TEXT DEFAULT 'ALL',
       school_name     TEXT DEFAULT 'ALL',
       is_active       INTEGER NOT NULL DEFAULT 1,
       created_at      TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS students (
       ssn_encrypted   TEXT PRIMARY KEY,
       student_name_ar TEXT,
       gender          TEXT,
       gov_code        TEXT,
       admin_zone      TEXT,
       school_name     TEXT,
       grade_level     INTEGER NOT NULL,
       class_name      TEXT,
       grades_json     TEXT DEFAULT '{}',
       attendance_json TEXT DEFAULT '[]',
       weekly_json     TEXT DEFAULT '{}',
       created_at      TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS idx_class_lookup
       ON students (school_name, grade_level, class_name, admin_zone)`,
    `CREATE TABLE IF NOT EXISTS student_grades (
       grade_id      INTEGER PRIMARY KEY AUTOINCREMENT,
       ssn_encrypted TEXT NOT NULL,
       grade_level   INTEGER NOT NULL,
       class_name    TEXT NOT NULL,
       subject_name  TEXT NOT NULL,
       grade_value   TEXT,
       teacher_id    INTEGER,
       created_at    TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_student_grade_scope
       ON student_grades (ssn_encrypted, grade_level, class_name, subject_name)`,
    `CREATE INDEX IF NOT EXISTS idx_grade_roster_lookup
       ON student_grades (grade_level, class_name, ssn_encrypted)`,
    `CREATE TABLE IF NOT EXISTS activity_logs (
       id            INTEGER PRIMARY KEY AUTOINCREMENT,
       ssn_encrypted TEXT NOT NULL,
       action_type   INTEGER NOT NULL,
       metadata      TEXT,
       logged_at     TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS idx_ssn_time
       ON activity_logs (ssn_encrypted, logged_at DESC)`,
    `CREATE TABLE IF NOT EXISTS teacher_classes (
       id           INTEGER PRIMARY KEY AUTOINCREMENT,
       teacher_id   INTEGER NOT NULL,
       grade_level  INTEGER NOT NULL,
       class_name   TEXT NOT NULL,
       subject_name TEXT NOT NULL
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_assignment
       ON teacher_classes (teacher_id, grade_level, class_name, subject_name)`,
    `CREATE INDEX IF NOT EXISTS idx_class_subject
       ON teacher_classes (grade_level, class_name, subject_name)`,

    // ── Weekly assessments (التقديرات الأسبوعية) ─────────────
    `CREATE TABLE IF NOT EXISTS weekly_assessments (
       id            INTEGER PRIMARY KEY AUTOINCREMENT,
       ssn_encrypted TEXT NOT NULL,
       subject_name  TEXT NOT NULL,
       week_number   INTEGER NOT NULL,
       score         REAL NOT NULL,
       max_score     REAL DEFAULT 10,
       UNIQUE(ssn_encrypted, subject_name, week_number)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_wa_ssn
       ON weekly_assessments (ssn_encrypted, week_number)`,

    // ── School portal tables ─────────────────────────────────
    `CREATE TABLE IF NOT EXISTS announcements (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       title       TEXT NOT NULL,
       content     TEXT NOT NULL,
       category    TEXT DEFAULT 'general',
       importance  TEXT DEFAULT 'normal',
       target_grade INTEGER,
       school_name TEXT,
       created_at  TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS student_attendance (
       id            INTEGER PRIMARY KEY AUTOINCREMENT,
       ssn_encrypted TEXT NOT NULL,
       grade_level   INTEGER NOT NULL,
       date          TEXT NOT NULL,
       status        TEXT NOT NULL,
       note          TEXT,
       UNIQUE(ssn_encrypted, date)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_att_ssn
       ON student_attendance (ssn_encrypted, date DESC)`,
    `CREATE TABLE IF NOT EXISTS class_schedule (
       id           INTEGER PRIMARY KEY AUTOINCREMENT,
       grade_level  INTEGER NOT NULL,
       class_name   TEXT NOT NULL,
       day          TEXT NOT NULL,
       period       INTEGER NOT NULL,
       start_time   TEXT NOT NULL,
       end_time     TEXT NOT NULL,
       subject_name TEXT NOT NULL,
       teacher_name TEXT,
       UNIQUE(grade_level, class_name, day, period)
     )`,

    // updated_at triggers (SQLite pattern: DROP then CREATE).
    `DROP TRIGGER IF EXISTS teachers_updated_at`,
    `CREATE TRIGGER teachers_updated_at AFTER UPDATE ON teachers
       FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
       BEGIN UPDATE teachers SET updated_at = datetime('now') WHERE rowid = NEW.rowid; END`,
    `DROP TRIGGER IF EXISTS students_updated_at`,
    `CREATE TRIGGER students_updated_at AFTER UPDATE ON students
       FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
       BEGIN UPDATE students SET updated_at = datetime('now') WHERE rowid = NEW.rowid; END`,
    `DROP TRIGGER IF EXISTS student_grades_updated_at`,
    `CREATE TRIGGER student_grades_updated_at AFTER UPDATE ON student_grades
       FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
       BEGIN UPDATE student_grades SET updated_at = datetime('now') WHERE rowid = NEW.rowid; END`,
  ];

  for (const sql of statements) {
    await db.execute(sql);
  }
  logger.info('Database schema ready (Turso/libSQL)', { statements: statements.length });

  // Ensure existing students table has the JSON columns (ALTER is a no-op if
  // the column already exists; we guard with try/catch since SQLite lacks
  // ADD COLUMN IF NOT EXISTS).
  for (const [col, def] of [['grades_json', 'TEXT DEFAULT "{}"'], ['attendance_json', 'TEXT DEFAULT "[]"'], ['weekly_json', 'TEXT DEFAULT "{}"']]) {
    try {
      await db.execute(`ALTER TABLE students ADD COLUMN ${col} ${def}`);
      logger.info('Added column to students', { column: col });
    } catch {
      // Column already exists — expected on subsequent boots.
    }
  }

  // Migrate legacy tables into the single-row JSON columns.
  await migrateGradesToJson(db);
  await migrateAttendanceToJson(db);
  await migrateWeeklyToJson(db);

  // Drop legacy tables that are now fully replaced by JSON columns.
  await dropLegacyTables(db);

  // Seed default portal data (announcements, schedule) if tables are empty.
  await seedDefaults(db);
  await seedStudentJsonDefaults(db);
}

/**
 * Drop legacy tables replaced by JSON columns. Safe because all data has been
 * migrated into students.grades_json / attendance_json / weekly_json.
 */
async function dropLegacyTables(db) {
  for (const table of ['student_grades', 'student_attendance', 'weekly_assessments']) {
    try {
      await db.execute(`DROP TABLE IF EXISTS ${table}`);
      logger.info('Dropped legacy table', { table });
    } catch {
      /* ignore — table may not exist */
    }
  }
}

/**
 * Migrate legacy student_attendance rows into students.attendance_json.
 */
async function migrateAttendanceToJson(db) {
  try {
    const { rows } = await db.execute(
      `SELECT s.ssn_encrypted, sa.date, sa.status, sa.note
         FROM students s
         JOIN student_attendance sa ON sa.ssn_encrypted = s.ssn_encrypted
        WHERE COALESCE(s.attendance_json, '') = '' OR s.attendance_json = '[]'
        ORDER BY s.ssn_encrypted, sa.date DESC`,
    );
    if (rows.length === 0) return;

    /** @type {Record<string, Array<{date:string,status:string,note:string|null}>>} */
    const byStudent = {};
    for (const row of rows) {
      if (!byStudent[row.ssn_encrypted]) byStudent[row.ssn_encrypted] = [];
      byStudent[row.ssn_encrypted].push({
        date: row.date,
        status: row.status,
        note: row.note,
      });
    }

    let migrated = 0;
    for (const [ssn, records] of Object.entries(byStudent)) {
      await db.execute({
        sql: 'UPDATE students SET attendance_json = ? WHERE ssn_encrypted = ?',
        args: [JSON.stringify(records), ssn],
      });
      migrated++;
    }
    logger.info('Migrated attendance into attendance_json', { students: migrated, records: rows.length });
  } catch {
    // Table may not exist yet — skip silently.
  }
}

/**
 * Migrate legacy weekly_assessments rows into students.weekly_json.
 */
async function migrateWeeklyToJson(db) {
  try {
    const { rows } = await db.execute(
      `SELECT s.ssn_encrypted, wa.subject_name, wa.week_number, wa.score, wa.max_score
         FROM students s
         JOIN weekly_assessments wa ON wa.ssn_encrypted = s.ssn_encrypted
        WHERE COALESCE(s.weekly_json, '') = '' OR s.weekly_json = '{}'
        ORDER BY s.ssn_encrypted, wa.subject_name, wa.week_number`,
    );
    if (rows.length === 0) return;

    /** @type {Record<string, Record<string, Array<{week:number,score:number,max_score:number}>>>} */
    const byStudent = {};
    for (const row of rows) {
      if (!byStudent[row.ssn_encrypted]) byStudent[row.ssn_encrypted] = {};
      const subj = row.subject_name;
      if (!byStudent[row.ssn_encrypted][subj]) byStudent[row.ssn_encrypted][subj] = [];
      byStudent[row.ssn_encrypted][subj].push({
        week: row.week_number,
        score: row.score,
        max_score: row.max_score,
      });
    }

    let migrated = 0;
    for (const [ssn, weekly] of Object.entries(byStudent)) {
      await db.execute({
        sql: 'UPDATE students SET weekly_json = ? WHERE ssn_encrypted = ?',
        args: [JSON.stringify(weekly), ssn],
      });
      migrated++;
    }
    logger.info('Migrated weekly assessments into weekly_json', { students: migrated });
  } catch {
    // Table may not exist yet — skip silently.
  }
}

/**
 * Seed default JSON data for students that have no grades/attendance/weekly yet.
 * Only runs for students that exist but have empty JSON columns.
 */
async function seedStudentJsonDefaults(db) {
  try {
    // Find the demo student with empty weekly_json
    const { rows } = await db.execute(
      `SELECT ssn_encrypted FROM students WHERE COALESCE(weekly_json,'') = '' OR weekly_json = '{}'`,
    );
    if (rows.length === 0) return;

    const subjects = [
      { name: 'اللغة العربية', base: 7.5 },
      { name: 'اللغة الإنجليزية', base: 7.0 },
      { name: 'الرياضيات', base: 8.5 },
      { name: 'العلوم', base: 8.0 },
      { name: 'الدراسات الاجتماعية', base: 8.2 },
      { name: 'التربية الدينية', base: 9.0 },
      { name: 'الحاسب الآلي', base: 9.2 },
    ];

    // Build weekly assessment JSON: { subject: [{week, score, max_score}] }
    const weekly = {};
    for (const subj of subjects) {
      weekly[subj.name] = [];
      for (let week = 1; week <= 12; week++) {
        const variance = Math.sin(week * 1.3 + subj.base) * 1.2;
        const score = Math.min(10, Math.max(4, subj.base + variance + (week * 0.1)));
        weekly[subj.name].push({ week, score: Math.round(score * 10) / 10, max_score: 10 });
      }
    }

    // Build attendance JSON
    const attendance = [];
    const statuses = ['present','present','present','present','present','present','present','present','present','present','present','present','present','present','present','present','present','late','present','absent'];
    const today = new Date();
    let dayCount = 0;
    for (let i = 0; i < 40 && dayCount < 20; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dow = d.getDay();
      if (dow === 5 || dow === 6) continue;
      attendance.push({
        date: d.toISOString().slice(0, 10),
        status: statuses[dayCount],
        note: statuses[dayCount] === 'late' ? 'تأخير 15 دقيقة' : statuses[dayCount] === 'absent' ? 'غياب بدون عذر' : null,
      });
      dayCount++;
    }

    for (const row of rows) {
      await db.execute({
        sql: 'UPDATE students SET weekly_json = ?, attendance_json = ? WHERE ssn_encrypted = ?',
        args: [JSON.stringify(weekly), JSON.stringify(attendance), row.ssn_encrypted],
      });
    }
    logger.info('Seeded weekly + attendance JSON for students', { count: rows.length });
  } catch {
    /* ignore */
  }
}

/**
 * Migrate legacy student_grades rows (one per subject) into the new
 * students.grades_json column (one column holding all subjects as JSON).
 * Idempotent: only migrates students whose grades_json is empty/missing.
 */
async function migrateGradesToJson(db) {
  try {
    // Find students with empty grades_json that have legacy grade rows.
    const { rows } = await db.execute(
      `SELECT s.ssn_encrypted, sg.subject_name, sg.grade_value
         FROM students s
         JOIN student_grades sg ON sg.ssn_encrypted = s.ssn_encrypted
        WHERE COALESCE(s.grades_json, '') = '' OR s.grades_json = '{}'
        ORDER BY s.ssn_encrypted`,
    );

    if (rows.length === 0) return; // nothing to migrate

    // Group by student SSN.
    /** @type {Record<string, Record<string, string>>} */
    const byStudent = {};
    for (const row of rows) {
      if (!byStudent[row.ssn_encrypted]) byStudent[row.ssn_encrypted] = {};
      byStudent[row.ssn_encrypted][row.subject_name] = String(row.grade_value);
    }

    let migrated = 0;
    for (const [ssn, grades] of Object.entries(byStudent)) {
      await db.execute({
        sql: 'UPDATE students SET grades_json = ? WHERE ssn_encrypted = ?',
        args: [JSON.stringify(grades), ssn],
      });
      migrated++;
    }
    logger.info('Migrated legacy grades into grades_json', { students: migrated, rows: rows.length });
  } catch (error) {
    logger.warn('Grade migration skipped', { message: error.message });
  }
}

/**
 * Seed announcements + a weekly schedule if they don't exist yet. Idempotent —
 * only inserts when the tables are empty, so it's safe on every boot.
 */
async function seedDefaults(db) {
  try {
    // ── Announcements ──
    const { rows: annCount } = await db.execute('SELECT COUNT(*) as c FROM announcements');
    if (Number(annCount[0]?.c) === 0) {
      const announcements = [
        { title: 'بدء امتحانات نهاية الترم', content: 'تبدأ امتحانات نهاية الترم الدراسي الأول يوم الأحد القادم. يرجى من الطلاب الاستعداد والمراجعة الجيدة. نتمنى لكم التوفيق والنجاح.', category: 'exams', importance: 'high' },
        { title: 'اجتماع أولياء الأمور', content: 'يُعقد اجتماع أولياء الأمور يوم الخميس القادم الساعة العاشرة صباحًا بقاعة المدرسة لمناقشة مستوى الطلاب.', category: 'meetings', importance: 'high' },
        { title: 'رحلة مدرسية إلى المتحف المصري', content: 'تنظم المدرسة رحلة تعليمية إلى المتحف المصري الكبير يوم السبت القادم. رسوم الرحلة 50 جنيهًا. التسجيل بالأمانة.', category: 'trips', importance: 'normal' },
        { title: 'مكافأة التفوق', content: 'سيتم تكريم الطلاب المتفوقين الذين حصلوا على التقدير العام في احتفال يوم الأحد. تهانينا للمتفوقين!', category: 'awards', importance: 'normal' },
        { title: 'تغيير مواعيد الحصص', content: 'ابتداءً من الأسبوع القادم سيتم تعديل مواعيد بعض الحصص الدراسية. يرجى الاطلاع على الجدول الجديد.', category: 'schedule', importance: 'normal' },
      ];
      for (const a of announcements) {
        await db.execute(
          'INSERT INTO announcements (title, content, category, importance) VALUES (?, ?, ?, ?)',
          [a.title, a.content, a.category, a.importance],
        );
      }
      logger.info('Seeded announcements', { count: announcements.length });
    }

    // ── Class schedule for grade 7 ──
    const { rows: schedCount } = await db.execute('SELECT COUNT(*) as c FROM class_schedule WHERE grade_level = 7');
    if (Number(schedCount[0]?.c) === 0) {
      const days = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس'];
      const baseSchedule = [
        { period: 1, start: '08:00', end: '08:45', subject: 'اللغة العربية', teacher: 'أ. فاطمة السيد' },
        { period: 2, start: '08:45', end: '09:30', subject: 'الرياضيات', teacher: 'أ. خالد عبد الله' },
        { period: 3, start: '09:30', end: '10:15', subject: 'اللغة الإنجليزية', teacher: 'أ. منى رضا' },
        { period: 4, start: '10:35', end: '11:20', subject: 'العلوم', teacher: 'أ. أحمد سمير' },
        { period: 5, start: '11:20', end: '12:05', subject: 'الدراسات الاجتماعية', teacher: 'أ. سعاد حسن' },
        { period: 6, start: '12:05', end: '12:50', subject: 'التربية الدينية', teacher: 'أ. عبد الرحمن نور' },
        { period: 7, start: '01:05', end: '01:50', subject: 'الحاسب الآلي', teacher: 'أ. هبة كمال' },
      ];
      // Vary the order slightly per day for realism.
      for (let d = 0; d < days.length; d++) {
        const rotated = [...baseSchedule.slice(d % 3), ...baseSchedule.slice(0, d % 3)];
        for (const s of rotated) {
          await db.execute(
            'INSERT INTO class_schedule (grade_level, class_name, day, period, start_time, end_time, subject_name, teacher_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [7, 'فصل 1/أ', days[d], s.period, s.start, s.end, s.subject, s.teacher],
          );
        }
      }
      logger.info('Seeded class schedule', { days: days.length });
    }
  } catch (error) {
    logger.warn('Seed defaults skipped', { message: error.message });
  }
}

module.exports = { runMigrations };

