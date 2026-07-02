'use strict';

const AppError = require('../lib/AppError');
const logger = require('../lib/logger');

/**
 * Normalise any thrown error into a consistent JSON envelope:
 *   { error: string, details?: unknown, code?: string }
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(error, req, res, next) {
  const isOperational = error instanceof AppError;
  const statusCode = isOperational ? error.statusCode : 500;

  if (!isOperational) {
    logger.error('Unhandled error', {
      path: req.path,
      method: req.method,
      message: error.message,
      stack: error.stack,
    });
  }

  res.status(statusCode).json({
    error: statusCode === 500 ? 'Internal Server Error' : error.message,
    ...(error.details ? { details: error.details } : {}),
  });
}

/** 404 handler for unmatched routes. */
function notFoundHandler(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
}

module.exports = { errorHandler, notFoundHandler };
