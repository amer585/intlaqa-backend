'use strict';

/**
 * Wrap an async route handler so rejected promises flow into next()
 * (and therefore the central error handler) instead of crashing the process.
 * @template {import('express').RequestHandler} H
 * @param {H} handler
 * @returns {H}
 */
function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
