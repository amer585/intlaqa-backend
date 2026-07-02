'use strict';

const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { config } = require('../config/env');

/**
 * Security headers (HSTS, no-sniff, frameguard, etc.).
 */
const securityHeaders = helmet();

/**
 * CORS restricted to the configured origins. Falls back to reflecting the
 * request origin only when CORS_ORIGINS is empty (dev convenience).
 */
const corsMiddleware = cors({
  origin(origin, cb) {
    // Allow same-server / curl requests with no Origin header.
    if (!origin) return cb(null, true);
    if (config.corsOrigins.length === 0) return cb(null, true);
    if (config.corsOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
});

/**
 * Per-IP rate limiter. Protects login/brute-force and noisy clients.
 */
const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: config.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  // Skip the limiter for trusted in-cluster callers when configured.
  skip: () => false,
  message: { error: 'Too many requests, please try again later.' },
});

/**
 * Stricter limiter for authentication endpoints.
 */
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' },
});

module.exports = {
  securityHeaders,
  corsMiddleware,
  apiRateLimiter,
  authRateLimiter,
};
