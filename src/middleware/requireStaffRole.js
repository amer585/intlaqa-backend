'use strict';

const AppError = require('../lib/AppError');
const { normalizeRole } = require('../utils/roles');

/**
 * Factory: build a middleware that allows only the given staff roles.
 * Must run AFTER authenticateToken (so req.user.role is populated).
 * @param {...string} allowedRoles
 */
function requireStaffRole(...allowedRoles) {
  const allowed = new Set(allowedRoles.map(normalizeRole).filter(Boolean));

  return function middleware(req, _res, next) {
    const role = normalizeRole(req.user && req.user.role);
    if (!allowed.has(role)) {
      return next(new AppError(403, 'Forbidden: insufficient role.'));
    }
    return next();
  };
}

module.exports = requireStaffRole;
