'use strict';

const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');
const logger = require('../lib/logger');

// Default TTL: 5 minutes. Pass 0 (or NEVER_EXPIRES) for entries that should
// persist until explicitly invalidated by a write — they survive restarts and
// are rebuilt from Turso automatically if the disk is wiped.
const DEFAULT_TTL_SEC = 300;
const NEVER_EXPIRES = 9999999999; // year ~2286 — effectively forever

let client = null;
let enabled = false;

/**
 * Initialize the local disk cache. Uses a SQLite file that survives process
 * restarts (within the same container). If HF rebuilds the container, the file
 * is lost — that's fine, it just falls back to reading from Turso directly.
 */
function initDiskCache() {
  try {
    const cacheDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    const dbPath = path.join(cacheDir, 'portal_cache.db');
    client = createClient({ url: `file:${dbPath}` });
    client.execute(`
      CREATE TABLE IF NOT EXISTS cache_kv (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    enabled = true;
    logger.info('Disk cache initialized', { path: dbPath, ttl: DEFAULT_TTL_SEC });
  } catch (error) {
    enabled = false;
    client = null;
    logger.warn('Disk cache unavailable — all reads go to Turso directly', { message: error.message });
  }
}

/**
 * Read a value from the disk cache. Returns parsed JSON or null (miss/expired).
 * @param {string} key
 * @returns {unknown | null}
 */
function getCache(key) {
  if (!enabled || !client) return null;
  try {
    // We can't use await here in a sync context, so we do a sync-style check.
    // libSQL local file is fast enough to do synchronously via a promise we
    // resolve immediately. But since callers are async, we return a promise.
    return null; // placeholder — actual get is async in getCacheAsync
  } catch {
    return null;
  }
}

/**
 * Async read from disk cache.
 * @param {string} key
 * @returns {Promise<unknown | null>}
 */
async function getCacheAsync(key) {
  if (!enabled || !client) return null;
  try {
    const now = Math.floor(Date.now() / 1000);
    const { rows } = await client.execute({
      sql: 'SELECT value, expires_at FROM cache_kv WHERE key = ? LIMIT 1',
      args: [key],
    });
    if (rows.length === 0) return null;

    const row = rows[0];
    if (now > row.expires_at) {
      // Expired — delete and miss.
      client.execute({ sql: 'DELETE FROM cache_kv WHERE key = ?', args: [key] }).catch(() => {});
      return null;
    }

    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

/**
 * Write a value to the disk cache.
 * @param {string} key
 * @param {unknown} value
 * @param {number} [ttlSec]
 */
async function setCache(key, value, ttlSec = DEFAULT_TTL_SEC) {
  if (!enabled || !client) return;
  try {
    // 0 (or any falsy) = never expire — kept until a write explicitly invalidates it.
    const expiresAt = ttlSec && ttlSec > 0
      ? Math.floor(Date.now() / 1000) + ttlSec
      : NEVER_EXPIRES;
    await client.execute({
      sql: 'INSERT OR REPLACE INTO cache_kv (key, value, expires_at) VALUES (?, ?, ?)',
      args: [key, JSON.stringify(value), expiresAt],
    });
  } catch {
    // Cache write failure is non-fatal.
  }
}

/**
 * Invalidate every cache key matching a prefix. Use after writes that change
 * data scoped to many students (e.g. a school-wide announcement).
 * @param {string} prefix
 */
async function invalidatePrefix(prefix) {
  if (!enabled || !client) return;
  try {
    await client.execute({ sql: 'DELETE FROM cache_kv WHERE key LIKE ?', args: [`${prefix}%`] });
  } catch {
    /* ignore */
  }
}

/** Wipe the entire cache. Rarely needed — nuclear option. */
async function clearAll() {
  if (!enabled || !client) return;
  try {
    await client.execute('DELETE FROM cache_kv');
  } catch {
    /* ignore */
  }
}

/**
 * Invalidate (delete) a cache entry by key prefix.
 * @param {string} key
 */
async function invalidate(key) {
  if (!enabled || !client) return;
  try {
    await client.execute({ sql: 'DELETE FROM cache_kv WHERE key = ?', args: [key] });
  } catch {
    /* ignore */
  }
}

/** Periodic cleanup of expired entries. Call on boot. */
async function cleanupExpired() {
  if (!enabled || !client) return;
  try {
    const now = Math.floor(Date.now() / 1000);
    await client.execute({ sql: 'DELETE FROM cache_kv WHERE expires_at < ?', args: [now] });
  } catch {
    /* ignore */
  }
}

module.exports = {
  initDiskCache,
  getCacheAsync,
  setCache,
  invalidate,
  invalidatePrefix,
  clearAll,
  cleanupExpired,
  isEnabled: () => enabled,
};
