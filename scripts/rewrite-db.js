#!/usr/bin/env node
'use strict';

/**
 * One-shot DATABASE WIPE + REBUILD tool (v5 read-optimized schema).
 *
 * ─ DESTroys the targeted Turso/libSQL database ──
 *   Drops EVERY user table + trigger in the target database, then runs the
 *   idempotent app migration (`runMigrations` for student mode,
 *   `runTeacherMigrations` for teacher mode) so the v5 schema and reference
 *   data seeds are installed from scratch. There is NO undo and NO backup. The
 *   user explicitly approved full wipe + rewrite of both Turso databases
 *   ("completely delete all tables in both … rewrite optimized for read").
 *
 * Usage (from the intlaqa-backend folder, after `npm install`):
 *
 *   DB_URL="libsql://men-amer.aws-eu-west-1.turso.io" \
 *   DB_TOKEN="<freshly minted per-DB libSQL access token (NOT a platform token)>" \
 *   node scripts/rewrite-db.js student
 *
 *   DB_URL="libsql://amer-amer321.aws-eu-west-1.turso.io" \
 *   DB_TOKEN="<freshly minted per-DB libSQL access token>" \
 *   node scripts/rewrite-db.js teacher
 *
 * Positional arg: "student" or "teacher". Env: DB_URL, DB_TOKEN (both required,
 * both must be from the SAME Turso database — the platform API tokens you got
 * from the dashboard will NOT work here; mint a per-DB access token first via
 * `turso db tokens create <db>` from the Turso CLI, or via the helper
 * scripts/mint-db-tokens.js).
 *
 * The legacy `scripts/setup-db.js` + `scripts/restructure-db.js` only ADD DDL
 * / rows; this one is the destructive counterpart and the entrypoint used by
 * the local-dev bring-up of v5.
 */

require('dotenv').config();

const { createClient } = require('@libsql/client');
const { runMigrations, runTeacherMigrations } = require('../src/db/migrate');
const logger = require('../src/lib/logger');

const mode = (process.argv[2] || '').toLowerCase();

// Resolution: by mode, read the SAME env vars the backend itself uses (from the
// `.env` dotenv just loaded). Backward-compat: also honor the explicit
// DB_URL/DB_TOKEN (matches scripts/setup-db.js convention) if the caller set
// them; useful for re-wiping a different DB without editing .env.
let url, token;
if (mode === 'student') {
  url = process.env.DB_URL || process.env.DATABASE_URL;
  token = process.env.DB_TOKEN || process.env.TURSO_AUTH_TOKEN;
} else if (mode === 'teacher') {
  url = process.env.DB_URL || process.env.TEACHER_DATABASE_URL;
  token = process.env.DB_TOKEN || process.env.TEACHER_DATABASE_TOKEN;
}

if (mode !== 'teacher' && mode !== 'student') {
  console.error('❌ Specify target: "teacher" or "student" (positional arg).');
  console.error('   Example: node scripts/rewrite-db.js teacher');
  console.error('            node scripts/rewrite-db.js student');
  process.exit(1);
}
if (!url || !token) {
  console.error('❌ Could not resolve Turso URL+token for "' + mode + '" mode.');
  console.error('   Either set DB_URL + DB_TOKEN explicitly (matches scripts/setup-db.js):');
  console.error('     DB_URL="libsql://..." DB_TOKEN="eyJ..." node scripts/rewrite-db.js student');
  console.error('   Or (preferred) put the backend\'s own env names in .env — for student:');
  console.error('     DATABASE_URL + TURSO_AUTH_TOKEN');
  console.error('   for teacher:');
  console.error('     TEACHER_DATABASE_URL + TEACHER_DATABASE_TOKEN');
  console.error('   dotenv already loaded — check your .env.');
  process.exit(1);
}

const client = createClient({ url, authToken: token });
const maskedUrl = url.replace(/:[^:@]+@/, ':***@');

async function listObjects(type) {
  const r = await client.execute(
    `SELECT name FROM sqlite_master WHERE type='${type}' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  return r.rows.map((row) => String(row.name));
}

async function dropEverything() {
  // Drop USER triggers first (they hold schema locks on tables in SQLite).
  const triggers = await listObjects('trigger');
  for (const t of triggers) {
    try { await client.execute(`DROP TRIGGER IF EXISTS "${t}"`); }
    catch (e) { console.error(`   ⚠️  DROP TRIGGER "${t}" failed: ${e.message}`); }
  }
  // Drop indexes — they go away implicitly with their parent table, but we
  // also DROP explicitly so they don't survive any orphaned state.
  const indexes = await listObjects('index');
  for (const i of indexes) {
    try { await client.execute(`DROP INDEX IF EXISTS "${i}"`); }
    catch (e) { console.error(`   ⚠️  DROP INDEX "${i}" failed: ${e.message}`); }
  }
  // Finally DROP every user table. Foreign keys are off by default in libSQL,
  // so order doesn't matter; we still execute in reverse alphabetical order
  // for readability of the audit log.
  const tables = await listObjects('table');
  for (const t of [...tables].sort().reverse()) {
    try { await client.execute(`DROP TABLE IF EXISTS "${t}"`); console.log(`   ✓ dropped table ${t}`); }
    catch (e) { console.error(`   ⚠️  DROP TABLE "${t}" failed: ${e.message}`); }
  }
  return { triggers: triggers.length, indexes: indexes.length, tables: tables.length };
}

async function reportState() {
  const tables = await listObjects('table');
  console.log('\n📊 Tables now present (' + tables.length + '):');
  for (const t of tables) {
    const c = await client.execute(`SELECT COUNT(*) AS n FROM "${t}"`).catch(() => ({ rows: [{ n: '?' }] }));
    console.log(`   • ${t.padEnd(28)} ${c.rows[0].n} rows`);
  }
  const indexes = await listObjects('index');
  console.log('\n   indexes (' + indexes.length + '):', indexes.join(', ') || '(none)');
  const triggers = await listObjects('trigger');
  console.log('   triggers (' + triggers.length + '):', triggers.join(', ') || '(none)');
}

async function run() {
  console.log(`\n📦 Target:   ${maskedUrl}`);
  console.log(`   Mode:     ${mode}`);
  const clientName = mode === 'teacher' ? 'TEACHER DB' : 'STUDENT DB';
  console.log(`\n🔌 Connecting to ${clientName} ...`);

  try {
    await client.execute('SELECT 1 AS ok');
  } catch (e) {
    console.error(`\n❌ Could not connect: ${e.message}`);
    if (/401|unauthorized|invalid JWT|forbidden/i.test(e.message)) {
      console.error('   → The token was rejected. Common causes:');
      console.error('     • the token is a Turso platform/group token (mint a per-DB access token instead)');
      console.error('     • the token/db URL pair are from different databases');
      console.error('     • the token has been rotated/revoked');
      console.error('   Mint a fresh per-DB access token via `turso db tokens create <db>`');
      console.error('   or via scripts/mint-db-tokens.js, then re-run this script.');
    }
    process.exit(1);
  }
  console.log('✅ Connected.');

  // Pre-wipe audit (so the user has a record of what was discarded).
  console.log('\n🧾 Pre-wipe inventory:');
  const beforeTables = await listObjects('table');
  const beforeIndexes = await listObjects('index');
  const beforeTriggers = await listObjects('trigger');
  for (const t of beforeTables) {
    const c = await client.execute(`SELECT COUNT(*) AS n FROM "${t}"`).catch(() => ({ rows: [{ n: '?' }] }));
    console.log(`   • ${t.padEnd(28)} ${c.rows[0].n} rows`);
  }
  console.log(`   (${beforeIndexes.length} indexes, ${beforeTriggers.length} triggers)`);

  // ─── DESTRUCTIVE STEP ─────────────────────────────────────
  console.log(`\n💥 Wiping ALL ${beforeTables.length} user tables + ${beforeIndexes.length} indexes + ${beforeTriggers.length} triggers ...`);
  const dropped = await dropEverything();
  console.log(`✅ Dropped ${dropped.tables} tables, ${dropped.indexes} indexes, ${dropped.triggers} triggers.`);

  // ─── REBUILD via the app's idempotent migrators ────────
  // runMigrations / runTeacherMigrations accept the raw libSQL client (server.js
  // does `await runMigrations(getClient())` — same type).
  console.log(`\n🛠️  Installing ${mode} v5 schema + seeds via migrate.js ...`);
  // Silence the per-line app logger during rebuild to keep the console readable;
  // the migrate functions log 'ready' at the end which is what the user cares about.
  const origInfo = logger.info; logger.info = () => {};
  if (mode === 'student') {
    await runMigrations(client);
  } else {
    await runTeacherMigrations(client);
  }
  logger.info = origInfo;

  // ANALYZE so the planner uses the new covering indexes immediately.
  try { await client.execute('ANALYZE'); console.log('\n✅ ANALYZE complete (query planner optimized).'); }
  catch (e) { console.error(`\n   ⚠️  ANALYZE failed: ${e.message}`); }

  // ─── Final state ─────────────────────────────────────────
  console.log(`\n📊 Final state of ${clientName}:`);
  await reportState();

  console.log('\n✨ Done.\n');
  try { client.close(); } catch {}
  process.exit(0);
}

run().catch((e) => {
  console.error('Fatal:', e.message);
  try { client.close(); } catch {}
  process.exit(1);
});
