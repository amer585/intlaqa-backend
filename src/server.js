'use strict';

const { createApp } = require('./app');
const { config } = require('./config/env');
const { closeAllPools } = require('./db/pools');
const logger = require('./lib/logger');

// Never let an unhandled error kill the process silently.
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { message: error.message, stack: error.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});

function startServer() {
  const app = createApp();
  const server = app.listen(config.port, '0.0.0.0', () => {
    logger.info(`Intlaqa backend listening on 0.0.0.0:${config.port} (${config.env})`);
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down gracefully`);
    server.close(async () => {
      await closeAllPools();
      logger.info('Closed cleanly');
      process.exit(0);
    });
    // Don't hang forever if a connection refuses to drop.
    setTimeout(() => process.exit(1), 10000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { app, server };
}

// Only boot when run directly (not when required by tests).
if (require.main === module) {
  startServer();
}

module.exports = { startServer };
