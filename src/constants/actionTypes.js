'use strict';

/**
 * Action type enum (stored as SMALLINT, not VARCHAR/ENUM). Mirrors the values
 * the frontend `apiService.ts` uses.
 */
const ACTION_TYPES = {
  LOGIN: 1,
  LOGOUT: 2,
  VIEW_PROFILE: 3,
  VIEW_GRADES: 4,
  VIEW_ATTENDANCE: 5,
  VIEW_SCHEDULE: 6,
  TEACHER_LOGIN: 10,
  TEACHER_GRADE_ENTRY: 11,
  TEACHER_ATTENDANCE_ENTRY: 12,
};

/** Reverse map for validation/logging: number -> name. */
const ACTION_NAMES = Object.fromEntries(
  Object.entries(ACTION_TYPES).map(([name, code]) => [code, name]),
);

/** @param {number} code */
function isValidActionCode(code) {
  return Object.prototype.hasOwnProperty.call(ACTION_NAMES, Number(code));
}

module.exports = Object.freeze({
  ...ACTION_TYPES,
  ACTION_NAMES,
  isValidActionCode,
});
