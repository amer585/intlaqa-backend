const AppError = require('../lib/AppError');
const { verifyToken } = require('../services/authService');

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return next(new AppError(401, 'Access Denied. No token provided.'));
  }

  try {
    req.user = verifyToken(token);
    return next();
  } catch (error) {
    return next(new AppError(403, 'Invalid or expired token.'));
  }
}

module.exports = authenticateToken;
