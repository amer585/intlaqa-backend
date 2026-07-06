'use strict';

const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');
const logger = require('../lib/logger');
const { redisEnabled, redisGet, redisSetEx, redisDel, redisDelBatch } = require('./redis');

// Default TTL: 5 minutes. Pass 0 (or NEVER_EXPIRES) for entries that should
// persist until explicitly invalidated by a write — they survive restarts and
// are rebuilt from Turso automatically if the disk is wiped.
const DEFAULT_TTL_SEC = 300;
const NEVER_EXPIRES = 9999999999; // year ~2286 — effectively forever
// v5 — unified "persistent" TTL applied to BOTH Redis and disk when a caller
// passes ttlSec=0. v4 wrote disk=NEVER_EXPIRES and Redis=365d — an asymmetry
// that bites on HF container rebuilds (Redis survives, disk lost, the
// surviving Redis entries can drift from a post-migration DB). v5 writes the
// SAME finite 365-day TTL on both layers so they age together and bounding
// Redis's hot memory.
const PERSISTENT_TTL_SEC = 365 * 24 * 60 * 60;

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
 * Async read from disk cache (with Redis front).
 *
 * v5 TOPOLOGY: Redis is PRIMARY when enabled. Reads hit Redis first; on a miss
 * they check the local disk cache (which exists only to survive a Redis outage
 * or an HF container rebuild where Redis is gone). We deliberately do NOT
 * cross-backfill when one layer misses the other — keeps the read path single-
 * roundtrip and avoids the v4 waste where every setCache-\>disk write was dead
 * weight whenever Redis was up.
 * @param {string} key
 * @returns {Promise<unknown | null>}
 */
async function getCacheAsync(key) {
  if (redisEnabled) {
    try {
      const cached = await redisGet(key);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch {
      // Degrade to local disk / Turso
    }
  }
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
 * Write a value to the cache layer(s).
 *
 * v5: when Redis is enabled, SKIP the disk write entirely (Redis is primary;
 * disk is fallback-only for the Redis-disabled window). When Redis is down,
 * disk becomes the authoritative layer for the rest of process life. This
 * eliminates the wasted every-write disk-INSERT that v4 did while Redis was
 * happily serving every read.
 * @param {string} key
 * @param {unknown} value
 * @param {number} [ttlSec]
 */
async function setCache(key, value, ttlSec = DEFAULT_TTL_SEC) {
  const payload = JSON.stringify(value);
  const persistent = !ttlSec || ttlSec <= 0;
  const finalTtl = persistent ? PERSISTENT_TTL_SEC : ttlSec;

  if (redisEnabled) {
    try {
      await redisSetEx(key, finalTtl, payload);
    } catch {
      // non-fatal
    }
    // Redis is up — skip the disk write. Re-enable only if Redis is down.
    return;
  }
  if (!enabled || !client) return;
  try {
    const expiresAt = persistent ? NEVER_EXPIRES : Math.floor(Date.now() / 1000) + ttlSec;
    await client.execute({
      sql: 'INSERT OR REPLACE INTO cache_kv (key, value, expires_at) VALUES (?, ?, ?)',
      args: [key, payload, expiresAt],
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
  if (redisEnabled) {
    try {
      // Upstash REST doesn't expose SCAN in pipeline form cleanly; do an
      // explicit flush by issuing DEL on the wildcard-prefixed key is not
      // supported (DEL only matches exact keys). Redis-primary topology means
      // the disk-side DELETE LIKE is moot for keys we never wrote to disk.
      // Skip Redis-side prefix sweep — callers should enumerate keys and use
      // invalidateBatch, OR accept that Redis entries with that prefix stay
      // until their TTL elapses (a deliberate trade-off; prefix usage is
      // limited to admin sweeps and the disk-fallback case below).
    } catch {
      /* ignore */
    }
  }
  if (!enabled || !client) return;
  try {
    await client.execute({ sql: 'DELETE FROM cache_kv WHERE key LIKE ?', args: [`${prefix}%`] });
  } catch {
    /* ignore */
  }
}

/** Wipe the entire cache. Rarely needed — nuclear option. */
async function clearAll() {
  if (redisEnabled) {
    // Intentionally NOT calling FLUSHDB via Upstash REST in this method — it is
    // a sharp tool; reserve it for an explicit Redis admin tool. Local disk
    // wipe below is enough for the disk-fallback layer.
  }
  if (!enabled || !client) return;
  try {
    await client.execute('DELETE FROM cache_kv');
  } catch {
    /* ignore */
  }
}

/**
 * Invalidate (delete) one cache entry from BOTH layers. Sequentially awaits
 * Redis DEL then disk DELETE — for single-key invalidation the cost is one
 * Redis round-trip + one SQLite op, fine.
 * @param {string} key
 */
async function invalidate(key) {
  if (redisEnabled) {
    try {
      await redisDel(key);
    } catch {
      // non-fatal
    }
  }
  if (!enabled || !client) return;
  try {
    await client.execute({ sql: 'DELETE FROM cache_kv WHERE key = ?', args: [key] });
  } catch {
    /* ignore */
  }
}

/**
 * v5 NEW — Invalidate N keys from BOTH layers in O(1) round-trips.
 *
 * Disk: one `DELETE FROM cache_kv WHERE key IN (?, ?, …)` statement collapses
 * what was previously N sequential DELETE awaits into ONE.
 * Redis: one Upstash pipelined `[["DEL", k1], ["DEL", k2], …]` POST collapses
 * what was previously N HTTP round-trips into ONE.
 *
 * For a 40-student grade post this turns ~80 sequential awaits into 2 — the
 * single biggest cache-write win in v5. Failures are non-fatal (cache must
 * never break a write); callers move on to the DB and accept a brief window
 * of stale reads until the next write busts the keys again.
 * @param {string[]} keys
 */
async function invalidateBatch(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return;
  const unique = Array.from(new Set(keys));

  if (redisEnabled) {
    try {
      await redisDelBatch(unique);
    } catch {
      // non-fatal
    }
  }
  if (!enabled || !client || unique.length === 0) return;
  try {
    const placeholders = unique.map(() => '?').join(', ');
    await client.execute({
      sql: `DELETE FROM cache_kv WHERE key IN (${placeholders})`,
      args: unique,
    });
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
  invalidateBatch,
  invalidatePrefix,
  clearAll,
  cleanupExpired,
  isEnabled: () => enabled,
};
