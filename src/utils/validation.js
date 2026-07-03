'use strict';

const AppError = require('../lib/AppError');

const SSN_REGEX = /^\d{14}$/;
// A bcrypt hash is exactly 60 chars: "$2a$10$" (7) + 53 chars of base64.
const BCRYPT_PREFIX_REGEX = /^\$2[abxy]\$\d{2}\$/;
const BCRYPT_TOTAL_LENGTH = 60;
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
  return (
    typeof hash === 'string' &&
    hash.length === BCRYPT_TOTAL_LENGTH &&
    BCRYPT_PREFIX_REGEX.test(hash)
  );
}

// ── Teacher account validation ──────────────────────────────
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

/** Lowercase + trim an email for consistent uniqueness. @param {unknown} raw */
function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

/** Throw 400 when the value isn't a well-formed email. @param {unknown} raw */
function assertValidEmail(raw) {
  const email = normalizeEmail(raw);
  if (!EMAIL_REGEX.test(email)) {
    throw new AppError(400, 'A valid email address is required.');
  }
  return email;
}

/** Throw 400 when the password is too short. @param {unknown} raw */
function assertStrongPassword(raw) {
  const password = String(raw ?? '');
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AppError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  return password;
}

module.exports = {
  requireFields,
  assert14DigitSsn,
  assertGradeLevel,
  normalizeGender,
  isBcryptHash,
  normalizeEmail,
  assertValidEmail,
  assertStrongPassword,
};
