'use strict';

const AppError = require('../lib/AppError');
const { verifyToken } = require('../services/auth.service');

/**
 * Extract + verify the Bearer JWT and attach the decoded payload to req.user.
 */
function authenticateToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return next(new AppError(401, 'Access Denied. No token provided.'));
  }

  try {
    req.user = verifyToken(token);
    return next();
  } catch {
    return next(new AppError(403, 'Invalid or expired token.'));
  }
}

module.exports = authenticateToken;
