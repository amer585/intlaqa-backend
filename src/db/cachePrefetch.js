'use strict';

/**
 * v5 NEW — Portal cache prefetch helper.
 *
 * After a write mutates a student's data (grade, attendance, profile), the
 * cache layer busts the relevant `portal:<ssn>:<grade>` key. Pattern (c)
 * ("invalidate-then-prefetch") then warms the cache by re-running the existing
 * portal reader for that (ssn, grade) — so the user's NEXT read hits warm
 * cache instead of doing a cold 5-statement Turso batch.
 *
 * Lives in its own module (not `diskCache.js`) to dodge a circular import:
 * `diskCache.js` is imported by `studentPortal.service.js`, and the prefetch
 * needs to call `getStudentPortal` — so the chain is
 *   cachePrefetch → diskCache (for invalidateBatch passthrough)
 *   cachePrefetch → studentPortal.service (for getStudentPortal)
 *   studentPortal.service → diskCache
 * No cycle: cachePrefetch is the only module that depends on both at once.
 */

const logger = require('../lib/logger');

// Lazily required to avoid the cycle at module-load time.
let _getStudentPortal = null;
function portalReader() {
  if (_getStudentPortal === null) {
    _getStudentPortal = require('../services/studentPortal.service').getStudentPortal;
  }
  return _getStudentPortal;
}

const PORTAL_KEY = /^portal:([^:]+):(\d+)$/;

/**
 * Warm the portal cache for one or more `portal:<ssn>:<grade>` keys.
 * - Parses each key with the cheap PORTAL_KEY regex.
 * - Calls `getStudentPortal({ssn_encrypted, grade_level})` which re-runs the
 *   5-statement Turso batch and re-caches the result with TTL=0 (persistent
 *   in v5's unified semantic).
 * - All prefetches run concurrently (`Promise.all`) but each failure degrades
 *   silently — a prefetch failure just means the next user read falls through
 *   to Turso (the normal cold-miss path); it must never break the write that
 *   triggered it.
 * @param {string[]} keys full cache keys, e.g. `portal:29601011234567:8`
 */
async function prefetchPortals(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return { warmed: 0, skipped: 0, failed: 0 };

  const tasks = keys.map((k) => String(k)).map((k) => {
    const m = PORTAL_KEY.exec(k);
    if (!m) return { kind: 'skip', k };
    const ssn = m[1];
    const grade = Number(m[2]);
    if (!ssn || !Number.isFinite(grade)) return { kind: 'skip', k };
    return { kind: 'fetch', ssn, grade };
  });

  const fetches = tasks.filter((t) => t.kind === 'fetch');
  const skipped = tasks.length - fetches.length;

  const results = await Promise.allSettled(
    fetches.map((t) => portalReader()({ ssn_encrypted: t.ssn, grade_level: t.grade })),
  );

  let warmed = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') warmed++;
    else failed++;
  }
  if (failed > 0) {
    logger.warn('portal prefetch: some keys failed (non-fatal)', { warmed, failed, skipped });
  }
  return { warmed, skipped, failed };
}

module.exports = { prefetchPortals };
