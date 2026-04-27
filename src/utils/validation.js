const AppError = require('../lib/AppError');

function requireFields(source, fields, message) {
  const target = source || {};
  const missingFields = fields.filter((field) => {
    const value = target[field];
    return value === undefined || value === null || value === '';
  });

  if (missingFields.length > 0) {
    throw new AppError(400, message);
  }
}

function assert14DigitSsn(ssn) {
  if (!/^\d{14}$/.test(String(ssn))) {
    throw new AppError(400, 'ssn_encrypted must be exactly 14 digits');
  }
}

module.exports = {
  requireFields,
  assert14DigitSsn,
};
