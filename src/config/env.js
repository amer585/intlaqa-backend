'use strict';

require('dotenv').config();

const crypto = require('crypto');

const DEFAULT_PORT = 7860; // Hugging Face Spaces requirement
const DEFAULT_JWT_EXPIRES_IN = '7d';
const DEFAULT_RATE_LIMIT_MAX = 300;

/** @param {string|undefined} raw @param {number} fallback @returns {number} */
function parseIntEnv(raw, fallback) {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** @param {string|undefined} raw @returns {string[]} */
function parseList(raw) {
  if (!raw) return [];
  return Array.from(new Set(raw.split(',').map((s) => s.trim()).filter(Boolean)));
}

// ── Database (Turso / libSQL) — STUDENT DB ───────────────────
// The primary/legacy database: students, grades, staff logins.
// NEVER throw — if DATABASE_URL is missing, mark db unavailable and keep booting.
const databaseUrl = process.env.DATABASE_URL || null;
const tursoAuthToken = process.env.TURSO_AUTH_TOKEN || null;
const dbAvailable = Boolean(databaseUrl);

// ── Database (Turso / libSQL) — TEACHER DB (separate account) ─
// Independent Turso account/DB to isolate teacher data and double the free
// limits. Holds teacher_accounts + teacher_student_relations. Independent of
// the student DB so the two apps have isolated capacity + secrets.
const teacherDatabaseUrl = process.env.TEACHER_DATABASE_URL || null;
const teacherDatabaseToken = process.env.TEACHER_DATABASE_TOKEN || null;
const teacherDbAvailable = Boolean(teacherDatabaseUrl);

// ── JWT ───────────────────────────────────────────────────────
// NEVER throw — generate a random fallback if missing/weak so the server boots.
let jwtSecret = process.env.JWT_SECRET;
let jwtSecretFallback = false;
if (!jwtSecret || jwtSecret.length < 16 || jwtSecret === 'change-me-to-a-long-random-string') {
  jwtSecret = crypto.randomBytes(48).toString('hex');
  jwtSecretFallback = true;
}

const config = Object.freeze({
  env: process.env.NODE_ENV || 'development',
  port: parseIntEnv(process.env.PORT, DEFAULT_PORT),
  trustProxy: String(process.env.TRUST_PROXY ?? 'true') === 'true',

  jwtSecret,
  jwtSecretFallback,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || DEFAULT_JWT_EXPIRES_IN,
  corsOrigins: parseList(process.env.CORS_ORIGINS),

  databaseUrl,
  tursoAuthToken,
  dbAvailable,
  teacherDatabaseUrl,
  teacherDatabaseToken,
  teacherDbAvailable,
  schoolCacheTtlMs: 30 * 60 * 1000,

  upstashRedisUrl: process.env.UPSTASH_REDIS_REST_URL || null,
  upstashRedisToken: process.env.UPSTASH_REDIS_REST_TOKEN || null,
  redisTtlSec: parseIntEnv(process.env.REDIS_TTL_SEC, 300),

  allowTestLogin: String(process.env.ALLOW_TEST_LOGIN ?? 'false') === 'true',
  rateLimitMax: parseIntEnv(process.env.RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX),
});

/**
 * Map a grade level (1-12) to the database URL (seam kept for future sharding).
 * With a single Turso DB this always returns the same URL for valid grades.
 */
function getDbUrl(gradeLevel) {
  if (!config.dbAvailable) return null;
  const grade = Number(gradeLevel);
  if (grade >= 1 && grade <= 12) return config.databaseUrl;
  return null;
}

module.exports = { config, getDbUrl, parseIntEnv, parseList };
