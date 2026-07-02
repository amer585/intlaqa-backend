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

  // Seed default portal data (announcements, schedule) if tables are empty.
  await seedDefaults(db);
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

