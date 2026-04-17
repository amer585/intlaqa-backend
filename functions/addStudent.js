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
      ssl: { rejectUnauthorized: true },
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

  const GOVERNORATES = [
    "القاهرة", "الإسكندرية", "الجيزة", "القليوبية", "الدقهلية", "الشرقية", "الغربية", 
    "المنوفية", "البحيرة", "كفر الشيخ", "دمياط", "بورسعيد", "الإسماعيلية", "السويس", 
    "مطروح", "شمال سيناء", "جنوب سيناء", "بني سويف", "الفيوم", "المنيا", "أسيوط", 
    "سوهاج", "قنا", "الأقصر", "أسوان", "البحر الأحمر", "الوادي الجديد"
  ];
  let numericGovCode = GOVERNORATES.indexOf(gov_code) + 1;
  if (numericGovCode === 0) numericGovCode = 1;

  let connection;
  try {
    const pool = getPool(dbUrl);
    connection = await pool.getConnection();

    // Check if student exists
    const [rows] = await connection.execute(
      'SELECT student_id FROM test.students WHERE ssn_encrypted = ?', 
      [ssn_encrypted]
    );

    let affectedRows = 0;

    if (rows.length > 0) {
      // Update existing
      const [updateResult] = await connection.execute(
        `UPDATE test.students 
         SET student_name_ar = ?, gender = ?, gov_code = ?, admin_zone = ?, school_name = ?, grade_level = ?, class_name = ?
         WHERE ssn_encrypted = ?`,
        [student_name_ar || null, gender || null, numericGovCode, admin_zone || null, school_name || null, grade_level, class_name || null, ssn_encrypted]
      );
      affectedRows = updateResult.affectedRows;
    } else {
      // Insert new
      const [insertResult] = await connection.execute(
        `INSERT INTO test.students 
         (ssn_encrypted, student_name_ar, gender, gov_code, admin_zone, school_name, grade_level, class_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [ssn_encrypted, student_name_ar || null, gender || null, numericGovCode, admin_zone || null, school_name || null, grade_level, class_name || null]
      );
      affectedRows = insertResult.affectedRows;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: 'Student saved successfully',
        affectedRows: affectedRows,
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