'use strict';

/** @param {string} role */
function normalizeRole(role) {
  return String(role || '').trim().toLowerCase();
}

/** Directorate / directorate-manager scope. @param {string} role */
function isDirectorateRole(role) {
  const r = normalizeRole(role);
  return r === 'directorate' || r === 'directorate_manager' || r === 'directorate manager';
}

/** District-only scope (single admin zone). @param {string} role */
function isDistrictOnlyRole(role) {
  const r = normalizeRole(role);
  return r === 'district' || r === 'district_manager' || r === 'district manager';
}

/** Any manager that spans multiple schools within a district/directorate. */
function isDistrictManagerRole(role) {
  return isDistrictOnlyRole(role) || isDirectorateRole(role);
}

/** School-scoped roles (principal / teacher) — locked to one school. */
function isSchoolScopedRole(role) {
  return normalizeRole(role) === 'principal' || normalizeRole(role) === 'teacher';
}

module.exports = {
  normalizeRole,
  isDirectorateRole,
  isDistrictOnlyRole,
  isDistrictManagerRole,
  isSchoolScopedRole,
};
