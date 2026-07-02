'use strict';

const fs = require('fs');
const { config } = require('../config/env');

/**
 * Build node-postgres `ssl` options.
 *
 *   disable -> false                      (no encryption)
 *   require -> { rejectUnauthorized:false }(encrypted, no CA check — Aiven-friendly)
 *   verify  -> { ca, rejectUnauthorized:true } (encrypted + pinned to a CA)
 *
 * Aiven and most managed Postgres providers work with `require` here.
 * @returns {false | Record<string, unknown>}
 */
function buildSslOptions() {
  switch (config.sslMode) {
    case 'disable':
      return false;
    case 'verify': {
      if (!config.sslCaPath) {
        throw new Error('FATAL: DB_SSL_MODE=verify requires DB_SSL_CA_PATH pointing at a CA PEM.');
      }
      const ca = fs.readFileSync(config.sslCaPath, 'utf8');
      return { ca, rejectUnauthorized: true };
    }
    case 'require':
    default:
      return { rejectUnauthorized: false };
  }
}

module.exports = { buildSslOptions };
