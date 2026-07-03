'use strict';

const { withConnection } = require('../db/client');

/**
 * Keep the `schools` dimension table in sync. Idempotent (INSERT OR IGNORE).
 * Called whenever a student or staff member is created/updated with a real
 * (gov, zone, school) triple, so hierarchy reads are always a tiny indexed
 * lookup instead of a DISTINCT scan over a growing table.
 * @param {{ gov_code?: string|null, admin_zone?: string|null, school_name?: string|null }} s
 */
async function ensureSchool(s = {}) {
  const govCode = s.gov_code || '';
  const adminZone = typeof s.admin_zone === 'string' ? s.admin_zone.trim() : '';
  const schoolName = typeof s.school_name === 'string' ? s.school_name.trim() : '';
  if (!schoolName || schoolName === 'ALL' || !adminZone) return;
  try {
    await withConnection(async (db) => {
      await db.execute(
        `INSERT OR IGNORE INTO schools (gov_code, admin_zone, school_name) VALUES (?, ?, ?)`,
        [govCode, adminZone, schoolName],
      );
    });
  } catch {
    /* dimension table is best-effort; never fail a write on it */
  }
}

module.exports = { ensureSchool };
