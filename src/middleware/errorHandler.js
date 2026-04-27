const AppError = require('../lib/AppError');

function notFoundHandler(req, res, next) {
  next(new AppError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

function errorHandler(error, req, res, next) {
  void next;

  const isAppError = error instanceof AppError;
  const statusCode = isAppError ? error.statusCode : 500;

  console.error(`[${req.method} ${req.originalUrl}]`, error.stack || error.message);

  const response = {
    error: isAppError ? error.message : 'Internal server error',
  };

  if (isAppError && error.details !== undefined) {
    if (error.details && typeof error.details === 'object' && !Array.isArray(error.details)) {
      Object.assign(response, error.details);
    } else {
      response.details = error.details;
    }
  }

  res.status(statusCode).json(response);
}

module.exports = {
  notFoundHandler,
  errorHandler,
};
