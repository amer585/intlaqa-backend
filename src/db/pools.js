'use strict';

const { Pool } = require('pg');

const { config } = require('../config/env');
const { buildSslOptions } = require('./ssl');
const logger = require('../lib/logger');

let pool = null;

/** Lazily create the single PostgreSQL connection pool. */
function getPool() {
  if (!config.dbAvailable) {
    throw new Error('DATABASE_URL is not configured — database features unavailable.');
  }
  if (!pool) {
    const ssl = buildSslOptions();
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: ssl === false ? false : ssl,
      max: config.pool.max,
      idleTimeoutMillis: config.pool.idleTimeoutMillis,
      connectionTimeoutMillis: config.pool.connectionTimeoutMillis,
    });
    pool.on('error', (err) => {
      logger.error('Idle PG client error', { message: err.message });
    });
  }
  return pool;
}

/**
 * Run `callback` against a checked-out client, always releasing it.
 * Single-DB version: no dbUrl argument needed.
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function withConnection(callback) {
  const client = await getPool().connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

/**
 * Run `callback` inside a single transaction. Commits on success, rolls back on
 * error, always releases the client.
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function withTransaction(callback) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** One-shot liveness check used by GET /health. */
async function pingDatabase() {
  try {
    await getPool().query('SELECT 1 AS ok');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function closeAllPools() {
  if (pool) {
    await pool.end().catch((e) => logger.error('Error closing pool', { message: e.message }));
    pool = null;
  }
}

// ── PostgreSQL placeholder helpers ────────────────────────────
// pg uses $1, $2, ... instead of mysql's ?. These helpers build the right
// placeholders for dynamic multi-row inserts and IN (...) clauses.

/** Build "($1,$2),($3,$4),..." for `rowCount` rows of `colCount` columns. */
function valuesPlaceholders(rowCount, colCount, startAt = 1) {
  let idx = startAt;
  const rows = [];
  for (let r = 0; r < rowCount; r++) {
    const cols = [];
    for (let c = 0; c < colCount; c++) cols.push(`$${idx++}`);
    rows.push(`(${cols.join(', ')})`);
  }
  return rows.join(', ');
}

/** Build "$3, $4, ..." for an IN clause starting at param index `startAt`. */
function inPlaceholders(count, startAt = 1) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(`$${startAt + i}`);
  return out.join(', ');
}

module.exports = {
  getPool,
  withConnection,
  withTransaction,
  pingDatabase,
  closeAllPools,
  valuesPlaceholders,
  inPlaceholders,
};
