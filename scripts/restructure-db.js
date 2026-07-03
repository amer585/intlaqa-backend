#!/usr/bin/env node
'use strict';

/**
 * One-time database restructure tool for the STUDENT database.
 *
 *   1. Connects to the DB.
 *   2. Runs the full idempotent migration (creates portal_meta, migrates the
 *      old class_schedule + announcements tables into lean JSON blobs, drops
 *      the old tables, seeds defaults).
 *   3. Cleans up students: keeps ONLY the demo student "محمد" (and any SSN
 *      passed via KEEP_SSN), deletes the rest.
 *   4. Runs ANALYZE + reports final table counts.
 *
 * Usage (from intlaqa-backend, after `npm install`):
 *
 *   DB_URL="libsql://amer-amer321.aws-eu-west-1.turso.io" \
 *   DB_TOKEN="your-student-db-token" \
 *   node scripts/restructure-db.js
 *
 *   # Optionally keep an extra student by SSN:
 *   KEEP_SSN="2960101..." node scripts/restructure-db.js
 *
 * SAFE: if no student matches "محمد", it will NOT delete anything (to avoid
 * wiping real data by accident) — it prints the names it found instead.
 */

const url = process.env.DB_URL;
const token = process.env.DB_TOKEN;

if (!url || !token) {
  console.error('❌ DB_URL and DB_TOKEN are required.');
  console.error('   DB_URL="libsql://...turso.io" DB_TOKEN="..." node scripts/restructure-db.js');
  process.exit(1);
}

// Wire the credentials into the app config BEFORE requiring it.
process.env.DATABASE_URL = url;
process.env.TURSO_AUTH_TOKEN = token;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'restructure-temporary-secret-16';

const { getClient, wrap, closeClient } = require('../src/db/client');
const { runMigrations } = require('../src/db/migrate');
const logger = require('../src/lib/logger');

// Silence the structured logger for a cleaner console here.
const origLog = logger.info;
logger.info = () => {};

(async () => {
  const masked = url.replace(/:[^:@]+@/, ':***@');
  console.log(`\n🔌 Connecting to ${masked} ...`);

  // Connection test.
  try {
    await getClient().execute('SELECT 1 AS ok');
  } catch (e) {
    console.error(`\n❌ Connection failed: ${e.message}`);
    if (/401|unauthorized|invalid JWT/i.test(e.message)) {
      console.error('   → The token does NOT match this DB. Make sure DB_URL + DB_TOKEN are from the SAME Turso database.');
    }
    process.exit(1);
  }
  console.log('✅ Connected.');

  // 1. Full migration + restructure (creates portal_meta, migrates legacy
  //    tables, drops them, seeds defaults, ANALYZE).
  console.log('🛠️  Running migration + portal restructure ...');
  const db = wrap(getClient());
  await runMigrations(db);
  console.log('✅ Schema + portal_meta restructure complete.');

  // 2. Keep only the demo student "محمد".
  console.log('\n🧹 Cleaning students (keeping only "محمد") ...');
  try {
    const { rows: all } = await db.execute('SELECT ssn_encrypted, student_name_ar FROM students ORDER BY student_name_ar');
    const keepNames = all.filter((s) => /محمد|moham/i.test(String(s.student_name_ar || '')));
    const keepSsns = new Set([
      ...keepNames.map((s) => String(s.ssn_encrypted)),
      ...(process.env.KEEP_SSN ? String(process.env.KEEP_SSN).split(',').map((s) => s.trim()).filter(Boolean) : []),
    ]);

    if (all.length === 0) {
      console.log('   (no students present — nothing to clean)');
    } else if (keepSsns.size === 0) {
      console.log(`   ⚠️  No student matches "محمد". NOT deleting to protect data.`);
      console.log('   Students found:');
      all.forEach((s) => console.log(`      • ${s.student_name_ar || '(no name)'} — ${s.ssn_encrypted}`));
      console.log('   Re-run with KEEP_SSN=<ssn> if the demo student has a different name.');
    } else {
      const keepList = [...keepSsns];
      const ph = keepList.map(() => '?').join(',');
      const del = await db.execute(
        `DELETE FROM students WHERE ssn_encrypted NOT IN (${ph})`,
        keepList,
      );
      console.log(`   ✅ Kept ${keepSsns.size} student(s), deleted ${del.rowsAffected}.`);
    }
  } catch (e) {
    console.error(`   ⚠️  Student cleanup error: ${e.message}`);
  }

  // 3. ANALYZE for optimal read plans.
  try { await db.execute('ANALYZE'); console.log('\n✅ ANALYZE complete.'); } catch (e) {
    console.error(`   ANALYZE failed: ${e.message}`);
  }

  // 4. Final report.
  console.log('\n📊 Final state:');
  const { rows: tables } = await db.execute(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  for (const t of tables) {
    const c = await db.execute(`SELECT COUNT(*) AS n FROM "${t.name}"`).catch(() => ({ rows: [{ n: '?' }] }));
    console.log(`   • ${t.name.padEnd(22)} ${c.rows[0].n} rows`);
  }
  console.log('\n✨ Done.\n');
  await closeClient();
  process.exit(0);
})().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
