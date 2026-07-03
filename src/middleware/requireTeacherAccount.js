'use strict';

const AppError = require('../lib/AppError');

/**
 * Runs AFTER authenticateToken. Ensures the verified JWT belongs to a
 * registered teacher account (type === 'teacher_account'), not a staff token.
 */
function requireTeacherAccount(req, _res, next) {
  const user = req.user || {};
  if (user.type !== 'teacher_account' || !user.teacher_account_id) {
    return next(new AppError(403, 'A verified teacher account token is required for this action.'));
  }
  return next();
}

module.exports = requireTeacherAccount;
