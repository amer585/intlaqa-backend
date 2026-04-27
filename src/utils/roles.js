function normalizeRole(role) {
  return String(role || '').trim().toLowerCase();
}

function isDistrictManagerRole(role) {
  const normalizedRole = normalizeRole(role);

  return (
    normalizedRole === 'district' ||
    normalizedRole === 'district_manager' ||
    normalizedRole === 'district manager' ||
    normalizedRole === 'directorate' ||
    normalizedRole === 'directorate_manager' ||
    normalizedRole === 'directorate manager'
  );
}

function isSchoolScopedRole(role) {
  const normalizedRole = normalizeRole(role);
  return normalizedRole === 'principal' || normalizedRole === 'teacher';
}

module.exports = {
  normalizeRole,
  isDistrictManagerRole,
  isSchoolScopedRole,
};
