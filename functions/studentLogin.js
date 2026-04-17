const mysql = require('mysql2/promise');
require('dotenv').config();

// ─────────────────────────────────────────────────────────
// CONNECTION POOL CACHE (survives warm Lambda invocations)
// ─────────────────────────────────────────────────────────
const pools = {};

function getPool(dbUrl) {
  if (!dbUrl) throw new Error('Database URL is undefined — check Netlify env vars.');
  if (!pools[dbUrl]) {
    pools[dbUrl] = mysql.createPool({
      uri: dbUrl,
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
  // ── RU SAVER: Cache student profile for 5 minutes ──
  // If the same student opens the app 5 times in 5 min,
  // only the FIRST request hits TiDB. The rest are served
  // from Netlify's edge cache at zero RU cost.
  'Cache-Control': 'public, max-age=300, s-maxage=300',
};

// ─────────────────────────────────────────────────────────
// HANDLER
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

  const { ssn_encrypted, grade_level } = data;

  if (!ssn_encrypted || !grade_level) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'ssn_encrypted and grade_level are required' }),
    };
  }

  // Validate SSN is exactly 14 digits
  if (!/^\d{14}$/.test(String(ssn_encrypted))) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'ssn_encrypted must be exactly 14 digits' }),
    };
  }

  const dbUrl = getDbUrl(grade_level);
  if (!dbUrl) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: `Invalid grade_level: ${grade_level}` }),
    };
  }

  let connection;
  try {
    const pool = getPool(dbUrl);
    connection = await pool.getConnection();

    // ── TTiDB SERVERLESS OPTIMIZATION ──
    // -- POINT GET: PK lookup
    // This query bypasses the optimizer and fetches exactly 1 row instantly.
    const [rows] = await connection.execute(
      `SELECT student_name_ar, school_name, class_name, admin_zone, gov_code, gender
       FROM students
       WHERE ssn_encrypted = ?`,
      [String(ssn_encrypted)]
    );

    if (rows.length === 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          error: 'Student ID not found in this grade.',
          ssn_encrypted,
          grade_level,
        }),
      };
    }

    const student = rows[0];

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: 'Login successful',
        student: {
          ssn_encrypted,
          grade_level: Number(grade_level),
          student_name_ar: student.student_name_ar,
          school_name: student.school_name,
          class_name: student.class_name,
          admin_zone: student.admin_zone,
          gov_code: student.gov_code,
          gender: student.gender,
        },
      }),
    };
  } catch (error) {
    console.error('[studentLogin] DB Error:', error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Database query failed', details: error.message }),
    };
  } finally {
    if (connection) connection.release();
  }
};
