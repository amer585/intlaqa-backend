'use strict';

const { getDbUrl } = require('../config/env');
const { getClient } = require('../db/client');
const AppError = require('../lib/AppError');
const { assert14DigitSsn, assertGradeLevel } = require('../utils/validation');
const { isValidActionCode } = require('../constants/actionTypes');

const MAX_BATCH = 500;

/**
 * Persist one or many activity-log rows. Accepts a single action object or
 * `{ actions: [...] }`. Uses libSQL's batch API (single network round-trip,
 * executed as one transaction) — very efficient.
 * @param {Record<string, unknown>} payload
 */
async function logActions(payload = {}) {
  const list = extractActions(payload);
  if (list.length === 0) throw new AppError(400, 'No actions provided.');
  if (list.length > MAX_BATCH) throw new AppError(400, `Too many actions in one batch (max ${MAX_BATCH}).`);

  /** @type {Map<number, Array<{ ssn_encrypted: string, action_type: number, metadata: string|null }>>} */
  const byGrade = new Map();
  for (const raw of list) {
    const gradeLevel = assertGradeLevel(raw.grade_level);
    assert14DigitSsn(raw.ssn_encrypted);
    const actionType = Number(raw.action_type);
    if (!isValidActionCode(actionType)) {
      throw new AppError(400, `Invalid action_type: ${raw.action_type}.`);
    }
    if (!byGrade.has(gradeLevel)) byGrade.set(gradeLevel, []);
    byGrade.get(gradeLevel).push({
      ssn_encrypted: String(raw.ssn_encrypted),
      action_type: actionType,
      metadata: raw.metadata == null ? null : JSON.stringify(raw.metadata),
    });
  }

  const summaries = [];
  for (const [gradeLevel, rows] of byGrade) {
    if (!getDbUrl(gradeLevel)) throw new AppError(400, `Invalid grade_level: ${gradeLevel}.`);

    // libSQL batch: one round-trip, atomic — perfect for bulk inserts.
    const stmts = rows.map((r) => ({
      sql: 'INSERT INTO activity_logs (ssn_encrypted, action_type, metadata) VALUES (?, ?, ?)',
      args: [r.ssn_encrypted, r.action_type, r.metadata],
    }));

    const results = await getClient().batch(stmts, 'write');
    const inserted = results.reduce((sum, rs) => sum + (rs.rowsAffected || 0), 0);
    summaries.push({ grade_level: gradeLevel, inserted });
  }

  return {
    message: 'Actions logged successfully',
    total_inserted: summaries.reduce((sum, s) => sum + s.inserted, 0),
    batches: summaries,
  };
}

/** Normalise the body into a flat list of action objects. */
function extractActions(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.actions)) return payload.actions;
  if (payload.ssn_encrypted !== undefined) return [payload];
  return [];
}

module.exports = { logActions };
