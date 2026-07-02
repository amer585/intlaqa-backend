'use strict';

/**
 * Operational error with an attached HTTP status code.
 * Thrown by services, normalised by the error-handling middleware.
 */
class AppError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(statusCode, message, details) {
    super(message);
    this.name = 'AppError';
    this.statusCode = Number.isFinite(statusCode) ? statusCode : 500;
    this.isOperational = true;
    if (details !== undefined) this.details = details;
    if (Error.captureStackTrace) Error.captureStackTrace(this, AppError);
  }
}

module.exports = AppError;
