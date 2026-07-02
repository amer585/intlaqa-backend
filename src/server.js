'use strict';

const { createApp } = require('./app');
const { config } = require('./config/env');
const { getClient, closeClient, wrap } = require('./db/client');
const { runMigrations } = require('./db/migrate');
const { initDiskCache, cleanupExpired } = require('./db/diskCache');
const logger = require('./lib/logger');

// NEVER let an unhandled error kill the process silently.
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { message: error.message, stack: error.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});

function startServer() {
  // Boot warnings (non-fatal)
  if (config.jwtSecretFallback) {
    logger.warn('JWT_SECRET not set — generated a random ephemeral secret. Set JWT_SECRET for persistent sessions.');
  }
  if (!config.dbAvailable) {
    logger.warn('DATABASE_URL not set — database features will be unavailable. Trial login still works if ALLOW_TEST_LOGIN=true.');
  }

  // Start listening IMMEDIATELY — never block the port on DB readiness.
  const app = createApp();
  const server = app.listen(config.port, '0.0.0.0', () => {
    logger.info(`Intlaqa backend listening on 0.0.0.0:${config.port} (${config.env})`);
  });

  // Initialize disk cache (local SQLite file — survives process restarts).
  initDiskCache();
  // Clean up expired cache entries periodically.
  cleanupExpired().catch(() => {});

  // Auto-create tables on boot (idempotent). Runs AFTER the port is open so a
  // slow/failing DB never prevents the server from responding.
  if (config.dbAvailable) {
    runMigrationsAsync();
  }

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down gracefully`);
    server.close(async () => {
      await closeClient();
      logger.info('Closed cleanly');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { app, server };
}

// Background migration — never blocks startup, never crashes the process.
async function runMigrationsAsync() {
  try {
    const db = wrap(getClient());
    await runMigrations(db);
  } catch (error) {
    logger.error('Schema migration failed', { message: error.message });
  }
}

// Only boot when run directly (not when required by tests).
if (require.main === module) {
  startServer();
}

module.exports = { startServer };
