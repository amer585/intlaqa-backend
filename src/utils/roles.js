function normalizeRole(role) {
  return String(role || '').trim().toLowerCase();
}

function isDirectorateRole(role) {
  const normalizedRole = normalizeRole(role);

  return (
    normalizedRole === 'directorate' ||
    normalizedRole === 'directorate_manager' ||
    normalizedRole === 'directorate manager'
  );
}

function isDistrictOnlyRole(role) {
  const normalizedRole = normalizeRole(role);

  return (
    normalizedRole === 'district' ||
    normalizedRole === 'district_manager' ||
    normalizedRole === 'district manager'
  );
}

function isDistrictManagerRole(role) {
  return isDistrictOnlyRole(role) || isDirectorateRole(role);
}

function isSchoolScopedRole(role) {
  const normalizedRole = normalizeRole(role);
  return normalizedRole === 'principal' || normalizedRole === 'teacher';
}

module.exports = {
  normalizeRole,
  isDirectorateRole,
  isDistrictOnlyRole,
  isDistrictManagerRole,
  isSchoolScopedRole,
};
