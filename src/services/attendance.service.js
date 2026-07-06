'use strict';

const { getClient } = require('../db/client');
const { invalidateBatch, invalidatePrefix } = require('../db/diskCache');
const { prefetchPortals } = require('../db/cachePrefetch');
const AppError = require('../lib/AppError');
const { assert14DigitSsn } = require('../utils/validation');

const MAX_BATCH = 1000;
const VALID_STATUS = new Set(['present', 'absent', 'late', 'excused']);
const PREFETCH_BUDGET = 50;
// v5 — write-through budget (mirrors grade.service).

/**
 * Bulk record attendance for one class/day — one atomic libSQL batch (single
 * round trip). Each (ssn, date) is upserted independently → concurrent teachers
 * on different students never block or clobber each other.
 *
 * @param {Record<string, unknown> | Array<Record<string, unknown>>} payload
 *   each item: { ssn_encrypted, date('YYYY-MM-DD'), status, note? }
 */
async function updateAttendance(payload) {
  const list = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.entries) ? payload.entries : []);
  if (list.length === 0) throw new AppError(400, 'No attendance entries provided.');
  if (list.length > MAX_BATCH) throw new AppError(400, `Too many entries in one batch (max ${MAX_BATCH}).`);

  /** @type {{ ssn_encrypted: string, date: string, status: string, note: string|null, grade_level: number|null }[]} */
  const clean = [];
  for (const raw of list) {
    if (!raw || !raw.ssn_encrypted || !raw.date || !raw.status) continue;
    assert14DigitSsn(raw.ssn_encrypted);
    const status = String(raw.status).toLowerCase();
    if (!VALID_STATUS.has(status)) {
      throw new AppError(400, `Invalid status: ${raw.status}. Must be present/absent/late/excused.`);
    }
    const date = String(raw.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(400, `Invalid date: ${date}. Use YYYY-MM-DD.`);
    clean.push({
      ssn_encrypted: String(raw.ssn_encrypted),
      date,
      status,
      note: raw.note ? String(raw.note) : null,
      grade_level: raw.grade_level != null && raw.grade_level !== '' ? Number(raw.grade_level) : null,
    });
  }
  if (clean.length === 0) return { message: 'No valid attendance entries.', updated: 0 };

  const stmts = clean.map((e) => ({
    sql: `INSERT INTO attendance (ssn_encrypted, date, status, note)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(ssn_encrypted, date) DO UPDATE SET
            status = excluded.status,
            note   = excluded.note`,
    args: [e.ssn_encrypted, e.date, e.status, e.note],
  }));

  try {
    await getClient().batch(stmts, 'write');

    const portalKeys = [];
    const ssnOnlyKeys = [];
    for (const e of clean) {
      if (e.grade_level) portalKeys.push(`portal:${e.ssn_encrypted}:${e.grade_level}`);
      else ssnOnlyKeys.push(e.ssn_encrypted);
    }
    if (portalKeys.length > 0) {
      await invalidateBatch(portalKeys);
      if (portalKeys.length <= PREFETCH_BUDGET) await prefetchPortals(portalKeys);
    }
    if (ssnOnlyKeys.length > 0) {
      for (const ssn of Array.from(new Set(ssnOnlyKeys))) {
        try { await invalidatePrefix(`portal:${ssn}:`); } catch { /* non-fatal */ }
      }
    }
    return { message: 'Attendance updated successfully.', updated: clean.length };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Failed to update attendance', error.message);
  }
}

module.exports = { updateAttendance };
