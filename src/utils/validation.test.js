'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  requireFields,
  assert14DigitSsn,
  assertGradeLevel,
  normalizeGender,
  isBcryptHash,
} = require('./validation');

test('requireFields throws on missing/blank values', () => {
  assert.throws(() => requireFields({ a: '' }, ['a'], 'missing'), /missing/);
  assert.throws(() => requireFields({ a: '  ' }, ['a'], 'missing'), /missing/);
  assert.doesNotThrow(() => requireFields({ a: 'x' }, ['a'], 'missing'));
});

test('assert14DigitSsn accepts 14 digits and rejects the rest', () => {
  assert.doesNotThrow(() => assert14DigitSsn('12345678901234'));
  assert.throws(() => assert14DigitSsn('123'), /14 digits/);
  assert.throws(() => assert14DigitSsn('abcdefghijklmn'), /14 digits/);
});

test('assertGradeLevel enforces 1..12 integers', () => {
  assert.equal(assertGradeLevel(6), 6);
  assert.equal(assertGradeLevel('12'), 12);
  assert.throws(() => assertGradeLevel(0));
  assert.throws(() => assertGradeLevel(13));
  assert.throws(() => assertGradeLevel('abc'));
});

test('normalizeGender maps M/F and rejects others', () => {
  assert.equal(normalizeGender('m'), 'M');
  assert.equal(normalizeGender('F'), 'F');
  assert.equal(normalizeGender(''), null);
  assert.equal(normalizeGender(null), null);
  assert.throws(() => normalizeGender('X'));
});

test('isBcryptHash detects bcrypt formats only', () => {
  assert.equal(isBcryptHash('$2a$12$abcdefghijklmnopqrstuv1234567890abcdefghijklmnopqrstuv'), true);
  assert.equal(isBcryptHash('$2b$10$abcdefghijklmnopqrstuv'), false);
  assert.equal(isBcryptHash('plaintext'), false);
  assert.equal(isBcryptHash(null), false);
});
