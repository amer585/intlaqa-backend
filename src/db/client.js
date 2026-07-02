'use strict';

const { createClient } = require('@libsql/client');

const { config } = require('../config/env');
const logger = require('../lib/logger');

let client = null;

/**
 * Lazily create the single libSQL client. libSQL manages its own connection
 * pool internally (HTTP-based for remote Turso), so we don't need a pg-style
 * Pool — one client is correct and optimal.
 */
function getClient() {
  if (!config.dbAvailable) {
    throw new Error('DATABASE_URL is not configured — database features unavailable.');
  }
  if (!client) {
    client = createClient({
      url: config.databaseUrl,
      authToken: config.tursoAuthToken || undefined,
    });
    logger.info('Turso (libSQL) client created', { url: maskUrl(config.databaseUrl) });
  }
  return client;
}

/** Hide the password/token in logs. */
function maskUrl(url) {
  return url ? url.replace(/:[^:@]+@/, ':***@') : 'none';
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
 * Run `callback` against the libSQL client.
 * @template T
 * @param {(db: ReturnType<typeof wrap>) => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function withConnection(callback) {
  return callback(wrap(getClient()));
}

/**
 * Run `callback` inside a single transaction. Commits on success, rolls back on
 * error.
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

/** One-shot liveness check used by GET /health. */
async function pingDatabase() {
  if (!config.dbAvailable) {
    return { ok: false, error: 'DATABASE_URL not configured' };
  }
  try {
    await getClient().execute('SELECT 1 AS ok');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function closeClient() {
  if (client) {
    client.close();
    client = null;
  }
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
  wrap,
  withConnection,
  withTransaction,
  pingDatabase,
  closeClient,
  valuesPlaceholders,
  inPlaceholders,
};
