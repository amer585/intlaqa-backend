'use strict';

require('dotenv').config();

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
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('FATAL: DATABASE_URL is required (postgres://user:pass@host:port/db).');
}

// ── JWT ───────────────────────────────────────────────────────
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 16 || jwtSecret === 'change-me-to-a-long-random-string') {
  throw new Error('FATAL: JWT_SECRET is missing or too weak. Use `openssl rand -hex 48`.');
}

const config = Object.freeze({
  env: process.env.NODE_ENV || 'development',
  port: parseIntEnv(process.env.PORT, DEFAULT_PORT),
  trustProxy: String(process.env.TRUST_PROXY ?? 'true') === 'true',

  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || DEFAULT_JWT_EXPIRES_IN,
  corsOrigins: parseList(process.env.CORS_ORIGINS),

  // Single PostgreSQL database for everything (grades 1-12 + staff).
  // Sharding across 4 DBs can be reintroduced later by routing getDbUrl().
  databaseUrl,
  schema: process.env.PG_SCHEMA || 'public',
  sslMode: (process.env.DB_SSL_MODE || 'require').toLowerCase(),
  sslCaPath: process.env.DB_SSL_CA_PATH || null,
  pool: Object.freeze({
    max: parseIntEnv(process.env.DB_POOL_MAX, 10),
    idleTimeoutMillis: parseIntEnv(process.env.DB_POOL_IDLE_TIMEOUT_MS, 30000),
    connectionTimeoutMillis: 10000,
  }),

  // Upstash Redis (REST API). Disabled if either value is blank.
  upstashRedisUrl: process.env.UPSTASH_REDIS_REST_URL || null,
  upstashRedisToken: process.env.UPSTASH_REDIS_REST_TOKEN || null,
  redisTtlSec: parseIntEnv(process.env.REDIS_TTL_SEC, 300),

  schoolCacheTtlMs: 30 * 60 * 1000,
  allowTestLogin: String(process.env.ALLOW_TEST_LOGIN ?? 'false') === 'true',
  rateLimitMax: parseIntEnv(process.env.RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX),
});

/**
 * Map a grade level (1-12) to a database URL. With a single DB this always
 * returns the same URL for valid grades — keeping the routing seam so we can
 * split into 4 databases later without touching call sites.
 * @param {number|string} gradeLevel
 * @returns {string|null}
 */
function getDbUrl(gradeLevel) {
  const grade = Number(gradeLevel);
  if (grade >= 1 && grade <= 12) return config.databaseUrl;
  return null;
}

module.exports = { config, getDbUrl, parseIntEnv, parseList };
