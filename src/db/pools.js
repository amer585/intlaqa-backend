const mysql = require('mysql2/promise');

const { config } = require('../config');

const pools = new Map();

function cleanDbUrl(dbUrl) {
  return dbUrl.replace(/[?&]ssl=[^&]*/g, '');
}

function createPool(dbUrl) {
  return mysql.createPool({
    uri: cleanDbUrl(dbUrl),
    ssl: { rejectUnauthorized: true },
    ...config.pool,
  });
}

function getPool(dbUrl) {
  if (!dbUrl) {
    throw new Error('Database URL is undefined.');
  }

  if (!pools.has(dbUrl)) {
    pools.set(dbUrl, createPool(dbUrl));
  }

  return pools.get(dbUrl);
}

async function withConnection(dbUrl, callback) {
  const connection = await getPool(dbUrl).getConnection();

  try {
    return await callback(connection);
  } finally {
    connection.release();
  }
}

async function closeAllPools() {
  for (const pool of pools.values()) {
    try {
      await pool.end();
    } catch (error) {
      console.error('Error closing pool:', error.message);
    }
  }
}

module.exports = {
  getPool,
  withConnection,
  closeAllPools,
};
