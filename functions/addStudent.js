const mysql = require('mysql2/promise');
require('dotenv').config();

// ─────────────────────────────────────────────────────────
// CONNECTION POOL CACHE
// Pools are cached at module level so they persist across
// warm Lambda invocations. This prevents creating a new
// TCP + TLS handshake on every single request — the #1
// reason TiDB Serverless tokens get burned through fast.
// ─────────────────────────────────────────────────────────
const pools = {};

function getPool(dbUrl) {
  if (!dbUrl) throw new Error('Database URL is undefined — check your environment variables in Netlify.');

  if (!pools[dbUrl]) {
    pools[dbUrl] = mysql.createPool({
      uri: dbUrl,
      waitForConnections: true,
      connectionLimit: 1,       // Serverless: 1 is optimal
      maxIdle: 1,               // Keep 1 idle connection alive
      idleTimeout: 60000,       // Close idle connections after 60s
      enableKeepAlive: true,    // Prevent TCP timeout on long waits
      keepAliveInitialDelay: 10000,
    });
  }
  return pools[dbUrl];
}

/**
 * Smart Router: picks the correct TiDB cluster based on grade_level.
 *   1–6   → DB_PRIMARY   (Primary / ابتدائي)
 *   7–9   → DB_PREP      (Preparatory / إعدادي)
 *   10–12 → DB_SECONDARY (Secondary / ثانوي)
 */
function getDbUrl(gradeLevel) {
  const grade = Number(gradeLevel);
  if (grade >= 1 && grade <= 6)  return process.env.DB_PRIMARY;
  if (grade >= 7 && grade <= 9)  return process.env.DB_PREP;
  if (grade >= 10 && grade <= 12) return process.env.DB_SECONDARY;
  return null;
}

// ─────────────────────────────────────────────────────────
// CORS HEADERS
// ─────────────────────────────────────────────────────────
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

// ─────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  // Only POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  let data;
  try {
    data = JSON.parse(event.body);
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const {
    ssn_encrypted,
    student_name_ar,
    gender,
    gov_code,
    admin_zone,
    school_name,
    grade_level,
    class_name,
  } = data;

  // Validate required fields
  if (!ssn_encrypted || !grade_level) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'ssn_encrypted and grade_level are required' }),
    };
  }

  // Route to the correct cluster
  const dbUrl = getDbUrl(grade_level);
  if (!dbUrl) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: `Invalid grade_level: ${grade_level}. Must be 1–12.` }),
    };
  }

  let connection;
  try {
    const pool = getPool(dbUrl);
    connection = await pool.getConnection();

    const query = `
      INSERT INTO students
      (ssn_encrypted, student_name_ar, gender, gov_code, admin_zone, school_name, grade_level, class_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        student_name_ar = VALUES(student_name_ar),
        gender          = VALUES(gender),
        gov_code        = VALUES(gov_code),
        admin_zone      = VALUES(admin_zone),
        school_name     = VALUES(school_name),
        grade_level     = VALUES(grade_level),
        class_name      = VALUES(class_name)
    `;

    const values = [
      ssn_encrypted,
      student_name_ar || null,
      gender || null,
      gov_code || null,
      admin_zone || null,
      school_name || null,
      grade_level,
      class_name || null,
    ];

    const [result] = await connection.execute(query, values);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: 'Student saved successfully',
        affectedRows: result.affectedRows,
      }),
    };
  } catch (error) {
    console.error('[addStudent] DB Error:', error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Database operation failed',
        details: error.message,
      }),
    };
  } finally {
    if (connection) connection.release(); // Return to pool, don't destroy
  }
};