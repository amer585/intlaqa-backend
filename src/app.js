'use strict';

const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');

const createApiRouter = require('./routes');
const { pingDatabase, pingTeacherDatabase } = require('./db/client');
const { redisEnabled, redisPing } = require('./db/redis');
const { errorHandler } = require('./middleware/errorHandler');
const { securityHeaders, corsMiddleware, apiRateLimiter } = require('./middleware/security');
const { config } = require('./config/env');

// Absolute path to the built frontend (copied into backend/public at build time).
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const HAS_FRONTEND = fs.existsSync(path.join(PUBLIC_DIR, 'index.html'));

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(securityHeaders);
  app.use(compression());
  app.use(corsMiddleware);
  app.use(express.json({ limit: '1mb' }));
  app.use(apiRateLimiter);

  // ── API status / health (JSON) ─────────────────────────────
  // Kept under /api so the frontend SPA can own the "/" route.
  app.get('/api/status', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'Intlaqa / Madrastna API v3',
      db: config.dbAvailable ? 'configured' : 'NOT CONFIGURED',
      teacher_db: config.teacherDbAvailable ? 'configured' : 'NOT CONFIGURED',
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
    const teacher = await pingTeacherDatabase();
    const cacheOk = !cache.enabled || cache.ok;
    const allOk = db.ok && cacheOk;
    res.status(200).json({
      status: allOk ? 'ok' : 'degraded',
      uptime: process.uptime(),
      database: db,
      teacher_database: teacher,
      cache,
      warnings: {
        noDb: !config.dbAvailable,
        noTeacherDb: !config.teacherDbAvailable,
        jwtFallback: config.jwtSecretFallback,
      },
    });
  });

  // ── API routes ─────────────────────────────────────────────
  app.use('/api', createApiRouter());

  // ── Serve the built frontend (SPA) ─────────────────────────
  if (HAS_FRONTEND) {
    // Static assets with long cache.
    app.use(express.static(PUBLIC_DIR, { maxAge: '1y', index: false }));
    // SPA fallback: any non-/api GET returns index.html (client-side routing).
    app.get(/^(?!\/api|\/health).*/, (_req, res) => {
      res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    });
  } else {
    // Fallback when no frontend build is present (e.g. backend-only deploy).
    app.get('/', (_req, res) => {
      res.json({ status: 'ok', service: 'Intlaqa / Madrastna API v3', frontend: 'not built' });
    });
  }

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
