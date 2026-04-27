const { createApp } = require('./app');
const { config } = require('./config');
const { closeAllPools } = require('./db/pools');

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error.message);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});

function startServer() {
  const app = createApp();
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`Madrastna Enterprise Backend running on port ${config.port}`);
  });

  const shutdown = createShutdown(server);
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { app, server, shutdown };
}

function createShutdown(server) {
  let shuttingDown = false;

  return async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`\n${signal} received. Shutting down gracefully...`);

    server.close(async () => {
      await closeAllPools();
      console.log('Server shut down cleanly.');
      process.exit(0);
    });
  };
}

module.exports = {
  startServer,
};
