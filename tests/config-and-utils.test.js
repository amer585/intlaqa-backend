const test = require('node:test');
const assert = require('node:assert/strict');

const { getDbUrl } = require('../src/config');
const { resolveGovCode, resolveGovName } = require('../src/utils/governorates');
const { isDistrictManagerRole, isSchoolScopedRole, normalizeRole } = require('../src/utils/roles');

test('getDbUrl routes grades to the expected cluster buckets', () => {
  assert.equal(getDbUrl(1), process.env.DB_PRIMARY || null);
  assert.equal(getDbUrl(7), process.env.DB_PREP || null);
  assert.equal(getDbUrl(10), process.env.DB_SECONDARY || null);
  assert.equal(getDbUrl(0), null);
});

test('role helpers normalize and classify roles consistently', () => {
  assert.equal(normalizeRole(' District Manager '), 'district manager');
  assert.equal(isDistrictManagerRole('directorate_manager'), true);
  assert.equal(isDistrictManagerRole('teacher'), false);
  assert.equal(isSchoolScopedRole('principal'), true);
  assert.equal(isSchoolScopedRole('district'), false);
});

test('governorate helpers support names and numeric codes', () => {
  assert.equal(resolveGovCode('القاهرة'), 1);
  assert.equal(resolveGovCode('3'), 3);
  assert.equal(resolveGovName(2), 'الإسكندرية');
});
