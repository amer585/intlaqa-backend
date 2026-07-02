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

// ── Database (single PostgreSQL) ──────────────────────────────
// NEVER throw — if DATABASE_URL is missing, mark db as unavailable and keep booting.
const databaseUrl = process.env.DATABASE_URL || null;
const dbAvailable = Boolean(databaseUrl);

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
  dbAvailable,
  schema: process.env.PG_SCHEMA || 'public',
  sslMode: (process.env.DB_SSL_MODE || 'require').toLowerCase(),
  sslCaPath: process.env.DB_SSL_CA_PATH || null,
  pool: Object.freeze({
    max: parseIntEnv(process.env.DB_POOL_MAX, 10),
    idleTimeoutMillis: parseIntEnv(process.env.DB_POOL_IDLE_TIMEOUT_MS, 30000),
    connectionTimeoutMillis: 10000,
  }),

  upstashRedisUrl: process.env.UPSTASH_REDIS_REST_URL || null,
  upstashRedisToken: process.env.UPSTASH_REDIS_REST_TOKEN || null,
  redisTtlSec: parseIntEnv(process.env.REDIS_TTL_SEC, 300),

  schoolCacheTtlMs: 30 * 60 * 1000,
  allowTestLogin: String(process.env.ALLOW_TEST_LOGIN ?? 'false') === 'true',
  rateLimitMax: parseIntEnv(process.env.RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX),
});

/**
 * Map a grade level (1-12) to the database URL. Returns null if DB unavailable.
 */
function getDbUrl(gradeLevel) {
  if (!config.dbAvailable) return null;
  const grade = Number(gradeLevel);
  if (grade >= 1 && grade <= 12) return config.databaseUrl;
  return null;
}

module.exports = { config, getDbUrl, parseIntEnv, parseList };
