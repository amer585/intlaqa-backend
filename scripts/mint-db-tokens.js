#!/usr/bin/env node
'use strict';

/**
 * Re-mint Turso per-DB libSQL access tokens (when the ones in .env expire or
 * are rotated). Two-step flow mirroring what Phase 6 did inline at setup time:
 *
 *   1. POST v1/organizations/<org>/databases/<db>/auth/tokens with the Turso
 *      PLATFORM token (group-scoped, has db:mint-token).
 *   2. Print the freshly minted per-DB access token. With --write, also patch
 *      the matching lines in the local .env so you don't have to copy-paste.
 *
 * Why this exists: the tokens the user originally pasted are Turso platform
 * API tokens (group-scoped, db:mint-token scope), NOT libSQL access tokens —
 * @libsql/client connects with 401 if you feed it a platform token. Minting
 * a per-DB access token (this script) is the bridge. The freshly minted tokens
 * are what the SERVER actually needs in DATABASE_URL+/TURSO_AUTH_TOKEN and
 * TEACHER_DATABASE_URL+/TEACHER_DATABASE_TOKEN.
 *
 * Usage (from the intlaqa-backend folder, after `npm install`):
 *
 *   # Mint both DB tokens and patch .env in place:
 *   MINT_TEACHER_TOKEN="<turso platform token for amer321 group>" \
 *   MINT_STUDENT_TOKEN="<turso platform token for amer group>" \
 *   node scripts/mint-db-tokens.js --write
 *
 *   # Print only (don't touch .env) — for student db only:
 *   MINT_STUDENT_TOKEN="<...>" node scripts/mint-db-tokens.js --student
 *
 *   # Print only — teacher db:
 *   MINT_TEACHER_TOKEN="<...>" node scripts/mint-db-tokens.js --teacher
 *
 * Default with no mode flag: mint both and print. Confirmed working slugs:
 *   teacher DB → org=amer321, db=amer  (libsql URL amer-amer321...turso.io)
 *   student DB → org=amer,     db=men   (libsql URL men-amer...turso.io)
 * (Discovered via GET /v1/organizations/<slug>/databases against the Turso API.)
 */

const fs = require('fs');
const path = require('path');

const TARGETS = [
  {
    mode: 'teacher',
    org: 'amer321',
    db: 'amer',
    platformTokenEnv: 'MINT_TEACHER_TOKEN',
    // Lines in .env this token writes into (regex keeps the comment block).
    envUrlKey: 'TEACHER_DATABASE_URL',
    envTokenKey: 'TEACHER_DATABASE_TOKEN',
    libsqlUrl: 'libsql://amer-amer321.aws-eu-west-1.turso.io',
  },
  {
    mode: 'student',
    org: 'amer',
    db: 'men',
    platformTokenEnv: 'MINT_STUDENT_TOKEN',
    envUrlKey: 'DATABASE_URL',
    envTokenKey: 'TURSO_AUTH_TOKEN',
    libsqlUrl: 'libsql://men-amer.aws-eu-west-1.turso.io',
  },
];

async function mint(org, db, platformToken) {
  const r = await fetch(`https://api.turso.tech/v1/organizations/${org}/databases/${db}/auth/tokens`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + platformToken },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`mint failed for ${org}/${db}: HTTP ${r.status} ${body}`);
  }
  return (await r.json()).jwt;
}

function patchEnv(envPath, envTokenKey, newToken) {
  if (!fs.existsSync(envPath)) return false;
  let txt = fs.readFileSync(envPath, 'utf8');
  const re = new RegExp(`^${envTokenKey}=.*$`, 'm');
  if (!re.test(txt)) return false;
  txt = txt.replace(re, `${envTokenKey}=${newToken}`);
  fs.writeFileSync(envPath, txt, 'utf8');
  return true;
}

async function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const modes = argv.filter((a) => a === '--teacher' || a === '--student');
  const selected = modes.length === 0 ? TARGETS : TARGETS.filter((t) => modes.includes(`--${t.mode}`));

  const envPath = path.join(process.cwd(), '.env');
  const results = [];

  for (const t of selected) {
    const platformToken = process.env[t.platformTokenEnv];
    if (!platformToken) {
      console.error(`❌ ${t.mode}: missing env ${t.platformTokenEnv} — set it to the Turso platform token for the ${t.org} group (must have db:mint-token scope).`);
      results.push({ ...t, ok: false });
      continue;
    }
    try {
      const tok = await mint(t.org, t.db, platformToken);
      console.log(`✅ ${t.mode.padEnd(8)} → minted per-DB libSQL access token (${t.libsqlUrl})`);
      console.log(`   ${tok.slice(0, 40)}…${tok.slice(-12)}`);
      if (write) {
        const ok = patchEnv(envPath, t.envTokenKey, tok);
        console.log(`   .env[${t.envTokenKey}]: ${ok ? 'updated' : 'not present in .env (skipped)'}`);
      }
      results.push({ ...t, ok: true, token: tok });
    } catch (e) {
      console.error(`❌ ${t.mode}: ${e.message}`);
      results.push({ ...t, ok: false });
    }
  }

  if (!write && results.some((r) => r.ok)) {
    console.log('\nCopies for .env (paste into the matching line, or re-run with --write):');
    for (const r of results.filter((r) => r.ok)) {
      console.log(`${r.envTokenKey}=${r.token}`);
    }
  }

  if (results.every((r) => r.ok)) process.exit(0);
  process.exit(1);
}

main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
