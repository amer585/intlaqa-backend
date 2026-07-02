'use strict';

const express = require('express');
const compression = require('compression');

const createApiRouter = require('./routes');
const { pingDatabase } = require('./db/pools');
const { redisEnabled, redisPing } = require('./db/redis');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { securityHeaders, corsMiddleware, apiRateLimiter } = require('./middleware/security');
const { config } = require('./config/env');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(securityHeaders);
  app.use(compression());
  app.use(corsMiddleware);
  app.use(express.json({ limit: '1mb' }));
  app.use(apiRateLimiter);

  // ALWAYS responds — proves the server is alive regardless of DB state.
  app.get('/', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'Intlaqa / Madrastna API v3',
      db: config.dbAvailable ? 'configured' : 'NOT CONFIGURED',
      cache: redisEnabled ? 'redis' : 'disabled',
      trial_login: config.allowTestLogin,
      jwt_secret: config.jwtSecretFallback ? 'fallback (ephemeral)' : 'configured',
      time: new Date().toISOString(),
    });
  });

  app.get('/health', async (_req, res) => {
    let db = { ok: false, error: 'DATABASE_URL not configured' };
    if (config.dbAvailable) {
      db = await pingDatabase();
    }
    const cache = await redisPing();
    const cacheOk = !cache.enabled || cache.ok;
    // The server is "ok" if it's listening. DB-down is "degraded" not "down".
    const allOk = db.ok && cacheOk;
    res.status(200).json({
      status: allOk ? 'ok' : 'degraded',
      uptime: process.uptime(),
      database: db,
      cache,
      warnings: {
        noDb: !config.dbAvailable,
        jwtFallback: config.jwtSecretFallback,
      },
    });
  });

  app.use('/api', createApiRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
