#!/usr/bin/env node
'use strict';

/**
 * Standalone database setup + optimization tool.
 *
 * Usage (from the intlaqa-backend folder, after `npm install`):
 *
 *   # Teacher DB (creates teacher_accounts + teacher_student_relations + indexes):
 *   DB_URL="libsql://YOUR-TEACHER-DB.turso.io" \
 *   DB_TOKEN="your-token" \
 *   node scripts/setup-db.js teacher
 *
 *   # Student DB (creates the student schema):
 *   DB_URL="libsql://YOUR-STUDENT-DB.turso.io" \
 *   DB_TOKEN="your-token" \
 *   node scripts/setup-db.js student
 *
 * It is IDEMPOTENT (CREATE ... IF NOT EXISTS) and runs ANALYZE at the end so
 * the SQLite query planner picks the optimal read plan. Safe to re-run anytime.
 */

const { createClient } = require('@libsql/client');

const url = process.env.DB_URL;
const token = process.env.DB_TOKEN;
const mode = (process.argv[2] || '').toLowerCase();

if (!url || !token) {
  console.error('❌ DB_URL and DB_TOKEN environment variables are required.');
  console.error('   Example: DB_URL="libsql://...db.turso.io" DB_TOKEN="..." node scripts/setup-db.js teacher');
  process.exit(1);
}
if (mode !== 'teacher' && mode !== 'student') {
  console.error('❌ Specify target: "teacher" or "student".');
  console.error('   Example: node scripts/setup-db.js teacher');
  process.exit(1);
}

const client = createClient({ url, authToken: token });

// ── TEACHER schema ──────────────────────────────────────────
const TEACHER_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS teacher_accounts (
     id            TEXT PRIMARY KEY,
     name          TEXT NOT NULL,
     email         TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     phone         TEXT,
     subject       TEXT,
     is_verified   INTEGER NOT NULL DEFAULT 0,
     created_at    TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_teacher_accounts_email ON teacher_accounts (email)`,
  `CREATE INDEX IF NOT EXISTS idx_teacher_accounts_pending ON teacher_accounts (is_verified, created_at)`,
  `CREATE TABLE IF NOT EXISTS teacher_student_relations (
     teacher_id  TEXT NOT NULL,
     student_id  TEXT NOT NULL,
     created_at  TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (teacher_id, student_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tsr_student ON teacher_student_relations (student_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tsr_teacher ON teacher_student_relations (teacher_id)`,
  `DROP TRIGGER IF EXISTS teacher_accounts_updated_at`,
  `CREATE TRIGGER teacher_accounts_updated_at AFTER UPDATE ON teacher_accounts
     FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
     BEGIN UPDATE teacher_accounts SET updated_at = datetime('now') WHERE id = NEW.id; END`,
];

// ── STUDENT schema (indexes only — full schema runs via migrate.js on boot) ──
// Re-creating indexes here is harmless (IF NOT EXISTS) and keeps reads fast.
const STUDENT_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS idx_class_lookup
     ON students (school_name, grade_level, class_name, admin_zone)`,
];

async function run() {
  const statements = mode === 'teacher' ? TEACHER_STATEMENTS : STUDENT_STATEMENTS;
  console.log(`\n📦 Connecting to ${url.replace(/:[^:@]+@/, ':***@')} (${mode} mode)...`);

  try {
    await client.execute('SELECT 1 AS ok');
  } catch (e) {
    console.error(`\n❌ Could not connect: ${e.message}`);
    if (/401|unauthorized|invalid JWT/i.test(e.message)) {
      console.error('   → The token does NOT match this database URL. Check that DB_URL + DB_TOKEN are from the SAME Turso database.');
    }
    process.exit(1);
  }
  console.log('✅ Connected. Applying schema...');

  for (const sql of statements) {
    try {
      await client.execute(sql);
    } catch (e) {
      console.error(`   ⚠️  statement failed: ${e.message}`);
    }
  }
  console.log(`✅ Applied ${statements.length} statements.`);

  // Optimize the query planner.
  try {
    await client.execute('ANALYZE');
    console.log('✅ ANALYZE complete (query planner optimized).');
  } catch (e) {
    console.error(`   ⚠️  ANALYZE failed: ${e.message}`);
  }

  // Report final state.
  const { rows } = await client.execute(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  console.log('\n📊 Tables now present:');
  for (const r of rows) {
    const c = await client.execute(`SELECT COUNT(*) AS n FROM "${r.name}"`).catch(() => ({ rows: [{ n: '?' }] }));
    console.log(`   • ${r.name}  (${c.rows[0].n} rows)`);
  }
  console.log('\n✨ Done.\n');
  process.exit(0);
}

run().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
