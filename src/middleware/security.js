'use strict';

const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { config } = require('../config/env');

/**
 * Security headers. Hugging Face Spaces embeds the app in an iframe on
 * huggingface.co, so we MUST allow HF to frame us — otherwise the Space
 * viewer shows "refused to connect" even though the app is healthy.
 */
const securityHeaders = helmet({
  // Let HF (and *.hf.space) embed the app in its Space iframe.
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'frame-ancestors': ["'self'", 'https://huggingface.co', 'https://*.hf.space'],
    },
  },
  // X-Frame-Options is superseded by frame-ancestors; disable to avoid conflict.
  frameguard: false,
  // Avoid breaking resource loading from HF's own infra.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});

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
