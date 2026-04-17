const mysql = require('mysql2/promise');
require('dotenv').config();

// ─────────────────────────────────────────────────────────
// CONNECTION POOL CACHE
// ─────────────────────────────────────────────────────────
const pools = {};

function getPool(dbUrl) {
  if (!dbUrl) throw new Error('Database URL is undefined — check Netlify env vars.');
  if (!pools[dbUrl]) {
    pools[dbUrl] = mysql.createPool({
      uri: dbUrl,
      ssl: { rejectUnauthorized: true },
      waitForConnections: true,
      connectionLimit: 1,
      maxIdle: 1,
      idleTimeout: 60000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });
  }
  return pools[dbUrl];
}

function getDbUrl(gradeLevel) {
  const grade = Number(gradeLevel);
  if (grade >= 1 && grade <= 6)  return process.env.DB_PRIMARY;
  if (grade >= 7 && grade <= 9)  return process.env.DB_PREP;
  if (grade >= 10 && grade <= 12) return process.env.DB_SECONDARY;
  return null;
}

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// ─────────────────────────────────────────────────────────
// ACTION TYPE MAP (TINYINT = 1 byte, not VARCHAR = 20+ bytes)
// Every log row saves ~19 bytes vs using a string.
// At 26M students × 5 actions/day = 130M rows/day.
// That's 2.47 GB saved PER DAY just from this one column.
// ─────────────────────────────────────────────────────────
// 1 = LOGIN
// 2 = LOGOUT
// 3 = VIEW_PROFILE
// 4 = VIEW_GRADES
// 5 = VIEW_ATTENDANCE
// 6 = VIEW_SCHEDULE
// 10 = TEACHER_LOGIN
// 11 = TEACHER_GRADE_ENTRY
// 12 = TEACHER_ATTENDANCE_ENTRY
// ─────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let data;
  try {
    data = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  // ── BATCH INSERT SUPPORT ──
  // Accept either a single action or an array of actions.
  // Batching 10 logs into 1 INSERT uses ~10x fewer RUs than
  // 10 separate INSERT statements because of reduced
  // TCP roundtrips, parse overhead, and transaction commits.
  const actions = Array.isArray(data.actions) ? data.actions : [data];

  // Validate all actions
  for (const action of actions) {
    if (!action.ssn_encrypted || !action.grade_level || !action.action_type) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Each action requires: ssn_encrypted, grade_level, action_type' }),
      };
    }
  }

  // Group by grade_level for batch routing
  const grouped = {};
  for (const action of actions) {
    const key = String(action.grade_level);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(action);
  }

  const results = [];

  for (const [gradeLevel, gradeActions] of Object.entries(grouped)) {
    const dbUrl = getDbUrl(gradeLevel);
    if (!dbUrl) {
      results.push({ grade_level: gradeLevel, error: 'Invalid grade_level' });
      continue;
    }

    let connection;
    try {
      const pool = getPool(dbUrl);
      connection = await pool.getConnection();

      // ── BATCH INSERT (single statement, multiple rows) ──
      // This is dramatically cheaper in RUs than individual INSERTs.
      const placeholders = gradeActions.map(() => '(?, ?, ?)').join(', ');
      const values = gradeActions.flatMap(a => [
        String(a.ssn_encrypted),
        Number(a.action_type),
        a.metadata ? JSON.stringify(a.metadata) : null,
      ]);

      await connection.execute(
        `INSERT INTO test.activity_logs (ssn_encrypted, action_type, metadata) VALUES ${placeholders}`,
        values
      );

      results.push({ grade_level: gradeLevel, logged: gradeActions.length });
    } catch (error) {
      console.error('[logAction] DB Error:', error.message);
      results.push({ grade_level: gradeLevel, error: error.message });
    } finally {
      if (connection) connection.release();
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ message: 'Actions logged', results }),
  };
};
