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

  app.get('/', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'Intlaqa / Madrastna API v3',
      db: 'postgresql (single)',
      cache: redisEnabled ? 'redis' : 'disabled',
      time: new Date().toISOString(),
    });
  });

  app.get('/health', async (_req, res) => {
    const [db, cache] = await Promise.all([pingDatabase(), redisPing()]);
    const dbOk = db.ok;
    const cacheOk = !cache.enabled || cache.ok; // disabled cache is fine
    const allOk = dbOk && cacheOk;
    res.status(allOk ? 200 : 503).json({
      status: allOk ? 'ok' : 'degraded',
      uptime: process.uptime(),
      database: db,
      cache,
    });
  });

  app.use('/api', createApiRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
