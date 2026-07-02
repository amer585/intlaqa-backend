'use strict';

const AppError = require('../lib/AppError');

const SSN_REGEX = /^\d{14}$/;
const BCRYPT_HASH_REGEX = /^\$2[aby]\$\d{2}\$.{53}$/;
const VALID_GENDERS = new Set(['M', 'F']);

/**
 * Throw a 400 if any of `fields` is missing/blank on `source`.
 * @param {Record<string, unknown>} source
 * @param {string[]} fields
 * @param {string} message
 */
function requireFields(source, fields, message) {
  const target = source || {};
  const missing = fields.filter((field) => {
    const value = target[field];
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
  });
  if (missing.length > 0) throw new AppError(400, message);
}

/** A "SSN" is a 14-digit token (the encrypted identifier). @param {unknown} ssn */
function assert14DigitSsn(ssn) {
  if (!SSN_REGEX.test(String(ssn))) {
    throw new AppError(400, 'ssn_encrypted must be exactly 14 digits');
  }
}

/**
 * Coerce + validate a grade level (1-12 integer).
 * @param {unknown} raw
 * @returns {number}
 */
function assertGradeLevel(raw) {
  const grade = Number(raw);
  if (!Number.isInteger(grade) || grade < 1 || grade > 12) {
    throw new AppError(400, `Invalid grade_level: ${raw}. Must be an integer 1-12.`);
  }
  return grade;
}

/** Normalise gender to 'M' / 'F' or null. @param {unknown} raw */
function normalizeGender(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = String(raw).trim().toUpperCase();
  if (!VALID_GENDERS.has(value)) {
    throw new AppError(400, `Invalid gender: ${raw}. Must be 'M' or 'F'.`);
  }
  return value;
}

/** True when the stored hash looks like a bcrypt hash. @param {unknown} hash */
function isBcryptHash(hash) {
  return typeof hash === 'string' && BCRYPT_HASH_REGEX.test(hash);
}

module.exports = {
  requireFields,
  assert14DigitSsn,
  assertGradeLevel,
  normalizeGender,
  isBcryptHash,
};
