const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────
// CONNECTION POOL CACHE
// ─────────────────────────────────────────────────────────
const pools = {};

function getPool(dbUrl) {
  if (!dbUrl) throw new Error('Database URL is undefined — check your environment variables.');
  if (!pools[dbUrl]) {
    pools[dbUrl] = mysql.createPool({
      uri: dbUrl,
      ssl: { rejectUnauthorized: true },
      waitForConnections: true,
      connectionLimit: 1, // Optimal for Serverless/Gigalixir free tier
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
  if (grade >= 1 && grade <= 6) return process.env.DB_PRIMARY;
  if (grade >= 7 && grade <= 9) return process.env.DB_PREP;
  if (grade >= 10 && grade <= 12) return process.env.DB_SECONDARY;
  return null;
}

const GOVERNORATES = [
  "القاهرة", "الإسكندرية", "الجيزة", "القليوبية", "الدقهلية", "الشرقية", "الغربية", 
  "المنوفية", "البحيرة", "كفر الشيخ", "دمياط", "بورسعيد", "الإسماعيلية", "السويس", 
  "مطروح", "شمال سيناء", "جنوب سيناء", "بني سويف", "الفيوم", "المنيا", "أسيوط", 
  "سوهاج", "قنا", "الأقصر", "أسوان", "البحر الأحمر", "الوادي الجديد"
];

// ─────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────

app.post('/api/studentLogin', async (req, res) => {
  const { ssn_encrypted, grade_level } = req.body;

  if (!ssn_encrypted || !grade_level) {
    return res.status(400).json({ error: 'ssn_encrypted and grade_level are required' });
  }

  if (!/^\d{14}$/.test(String(ssn_encrypted))) {
    return res.status(400).json({ error: 'ssn_encrypted must be exactly 14 digits' });
  }

  const dbUrl = getDbUrl(grade_level);
  if (!dbUrl) {
    return res.status(400).json({ error: `Invalid grade_level: ${grade_level}` });
  }

  let connection;
  try {
    const pool = getPool(dbUrl);
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      `SELECT student_name_ar, school_name, class_name, admin_zone, gov_code, gender
       FROM test.students
       WHERE ssn_encrypted = ?`,
      [String(ssn_encrypted)]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Student ID not found in this grade.', ssn_encrypted, grade_level });
    }

    const student = rows[0];

    return res.status(200).json({
      message: 'Login successful',
      student: {
        ssn_encrypted,
        grade_level: Number(grade_level),
        student_name_ar: student.student_name_ar,
        school_name: student.school_name,
        class_name: student.class_name,
        admin_zone: student.admin_zone,
        gov_code: GOVERNORATES[student.gov_code - 1] || "القاهرة",
        gender: student.gender,
      },
    });
  } catch (error) {
    console.error('[studentLogin] DB Error:', error.message);
    return res.status(500).json({ error: 'Database query failed', details: error.message });
  } finally {
    if (connection) connection.release();
  }
});

app.post('/api/addStudent', async (req, res) => {
  const { ssn_encrypted, student_name_ar, gender, gov_code, admin_zone, school_name, grade_level, class_name } = req.body;

  if (!ssn_encrypted || !grade_level) {
    return res.status(400).json({ error: 'ssn_encrypted and grade_level are required' });
  }

  const dbUrl = getDbUrl(grade_level);
  if (!dbUrl) {
    return res.status(400).json({ error: `Invalid grade_level: ${grade_level}. Must be 1–12.` });
  }

  let numericGovCode = GOVERNORATES.indexOf(gov_code) + 1;
  if (numericGovCode === 0) numericGovCode = 1;

  let connection;
  try {
    const pool = getPool(dbUrl);
    connection = await pool.getConnection();

    const [rows] = await connection.execute('SELECT student_id FROM test.students WHERE ssn_encrypted = ?', [ssn_encrypted]);
    let affectedRows = 0;

    if (rows.length > 0) {
      const [updateResult] = await connection.execute(
        `UPDATE test.students 
         SET student_name_ar = ?, gender = ?, gov_code = ?, admin_zone = ?, school_name = ?, grade_level = ?, class_name = ?
         WHERE ssn_encrypted = ?`,
        [student_name_ar || null, gender || null, numericGovCode, admin_zone || null, school_name || null, grade_level, class_name || null, ssn_encrypted]
      );
      affectedRows = updateResult.affectedRows;
    } else {
      const [insertResult] = await connection.execute(
        `INSERT INTO test.students 
         (ssn_encrypted, student_name_ar, gender, gov_code, admin_zone, school_name, grade_level, class_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [ssn_encrypted, student_name_ar || null, gender || null, numericGovCode, admin_zone || null, school_name || null, grade_level, class_name || null]
      );
      affectedRows = insertResult.affectedRows;
    }

    return res.status(200).json({ message: 'Student saved successfully', affectedRows });
  } catch (error) {
    console.error('[addStudent] DB Error:', error.message);
    return res.status(500).json({ error: 'Database operation failed', details: error.message });
  } finally {
    if (connection) connection.release();
  }
});

app.post('/api/logAction', async (req, res) => {
  const data = req.body;
  const actions = Array.isArray(data.actions) ? data.actions : [data];

  for (const action of actions) {
    if (!action.ssn_encrypted || !action.grade_level || !action.action_type) {
      return res.status(400).json({ error: 'Each action requires: ssn_encrypted, grade_level, action_type' });
    }
  }

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

  return res.status(200).json({ message: 'Actions logged', results });
});

app.get('/', (req, res) => {
  res.send('Madrastna Backend API is running!');
});

// ─────────────────────────────────────────────────────────
// SERVER INITIALIZATION
// ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
