'use strict';

const { createClient } = require('@libsql/client');

const { config } = require('../config/env');
const logger = require('../lib/logger');

/**
 * Registry of raw libSQL clients keyed by their URL. libSQL manages its own
 * connection pool internally (HTTP-based for remote Turso), so one client per
 * database URL is correct and optimal. Separate URLs → separate clients →
 * separate capacity/limits.
 * @type {Map<string, import('@libsql/client').Client>}
 */
const clients = new Map();

/** Hide the password/token in logs. */
function maskUrl(url) {
  return url ? url.replace(/:[^:@]+@/, ':***@') : 'none';
}

/** Lazily create (and cache) a libSQL client for a given URL/token pair. */
function getOrCreateRawClient(url, token) {
  if (!clients.has(url)) {
    clients.set(
      url,
      createClient({ url, authToken: token || undefined }),
    );
    logger.info('Turso (libSQL) client created', { url: maskUrl(url) });
  }
  return clients.get(url);
}

/**
 * Default client → STUDENT database (backward compatible).
 */
function getClient() {
  if (!config.dbAvailable) {
    throw new Error('DATABASE_URL is not configured — student database features unavailable.');
  }
  return getOrCreateRawClient(config.databaseUrl, config.tursoAuthToken);
}

/**
 * Teacher database client. Throws a clear error if the teacher DB isn't
 * configured — callers convert this into an AppError(503).
 */
function getTeacherClient() {
  if (!config.teacherDbAvailable) {
    throw new Error('TEACHER_DATABASE_URL is not configured — teacher database features unavailable.');
  }
  return getOrCreateRawClient(config.teacherDatabaseUrl, config.teacherDatabaseToken);
}

/**
 * Thin wrapper exposing `.execute(sql, args)` so services read the same whether
 * they're inside or outside a transaction.
 */
function wrap(target) {
  return {
    /**
     * @param {string} sql
     * @param {unknown[]} [args]
     * @returns {Promise<{ rows: Record<string, unknown>[]; rowsAffected: number; lastInsertRowid: number | bigint }>}
     */
    execute(sql, args = []) {
      return target.execute({ sql, args });
    },
  };
}

/**
 * Run `callback` against the STUDENT (default) libSQL client.
 * @template T
 * @param {(db: ReturnType<typeof wrap>) => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function withConnection(callback) {
  return callback(wrap(getClient()));
}

/**
 * Run `callback` against the TEACHER libSQL client.
 * @template T
 * @param {(db: ReturnType<typeof wrap>) => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function withTeacherConnection(callback) {
  return callback(wrap(getTeacherClient()));
}

/**
 * Run `callback` inside a single transaction on the STUDENT (default) DB.
 * Commits on success, rolls back on error.
 * @template T
 * @param {(db: ReturnType<typeof wrap>) => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function withTransaction(callback) {
  const tx = await getClient().transaction('write');
  const db = wrap(tx);
  try {
    const result = await callback(db);
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  }
}

/**
 * Run `callback` inside a single transaction on the TEACHER DB.
 * @template T
 * @param {(db: ReturnType<typeof wrap>) => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function withTeacherTransaction(callback) {
  const tx = await getTeacherClient().transaction('write');
  const db = wrap(tx);
  try {
    const result = await callback(db);
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  }
}

/** One-shot liveness check for the STUDENT DB, used by GET /health. */
async function pingDatabase() {
  if (!config.dbAvailable) {
    return { ok: false, error: 'DATABASE_URL not configured' };
  }
  try {
    await getOrCreateRawClient(config.databaseUrl, config.tursoAuthToken).execute('SELECT 1 AS ok');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** One-shot liveness check for the TEACHER DB, used by GET /health. */
async function pingTeacherDatabase() {
  if (!config.teacherDbAvailable) {
    return { ok: false, error: 'TEACHER_DATABASE_URL not configured' };
  }
  try {
    await getOrCreateRawClient(config.teacherDatabaseUrl, config.teacherDatabaseToken).execute('SELECT 1 AS ok');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function closeClient() {
  for (const c of clients.values()) {
    try { c.close(); } catch { /* ignore */ }
  }
  clients.clear();
}

// ── Placeholder helpers (libSQL uses ? like SQLite) ───────────

/** Build "(?,?,?),(?,?,?)" for `rowCount` rows of `colCount` columns. */
function valuesPlaceholders(rowCount, colCount) {
  const row = `(${Array(colCount).fill('?').join(', ')})`;
  return Array(rowCount).fill(row).join(', ');
}

/** Build "?,?,?" for an IN clause. */
function inPlaceholders(count) {
  return Array(count).fill('?').join(', ');
}

module.exports = {
  getClient,
  getTeacherClient,
  wrap,
  withConnection,
  withTeacherConnection,
  withTransaction,
  withTeacherTransaction,
  pingDatabase,
  pingTeacherDatabase,
  closeClient,
  valuesPlaceholders,
  inPlaceholders,
};
