'use strict';

const { withConnection } = require('../db/client');
const { bustSchoolCache } = require('./hierarchy.service');

/**
 * Keep the `schools` dimension table in sync. Idempotent (INSERT OR IGNORE).
 * Called whenever a student or staff member is created/updated with a real
 * (gov, zone, school) triple, so hierarchy reads are always a tiny indexed
 * lookup instead of a DISTINCT scan over a growing table.
 *
 * v5 — also busts the in-process `schoolCache` (30-min TTL) on a successful
 * INSERT so a new school shows up in /api/hierarchy/schools immediately.
 * @param {{ gov_code?: string|null, admin_zone?: string|null, school_name?: string|null }} s
 */
async function ensureSchool(s = {}) {
  const govCode = s.gov_code || '';
  const adminZone = typeof s.admin_zone === 'string' ? s.admin_zone.trim() : '';
  const schoolName = typeof s.school_name === 'string' ? s.school_name.trim() : '';
  if (!schoolName || schoolName === 'ALL' || !adminZone) return;
  try {
    const rowsAffected = await withConnection(async (db) => {
      const rs = await db.execute(
        `INSERT OR IGNORE INTO schools (gov_code, admin_zone, school_name) VALUES (?, ?, ?)`,
        [govCode, adminZone, schoolName],
      );
      return rs.rowsAffected;
    });
    // Only invalidate the in-memory cache if the dimension table actually
    // grew (INSERT OR IGNORE returns 0 for an existing row).
    if (rowsAffected > 0) bustSchoolCache();
  } catch {
    /* dimension table is best-effort; never fail a write on it */
  }
}

module.exports = { ensureSchool };
