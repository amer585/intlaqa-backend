const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────
// 1. GLOBAL CONFIGURATION & DATABASE POOLS
// ─────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'madrastna-super-secret-key-2026';

process.on('uncaughtException', (err) => console.error('⚠️ Uncaught Exception:', err.message));
process.on('unhandledRejection', (err) => console.error('⚠️ Unhandled Rejection:', err));

const pools = {};

function getPool(dbUrl) {
  if (!dbUrl) throw new Error('Database URL is undefined.');
  if (!pools[dbUrl]) {
    const cleanUrl = dbUrl.replace(/[?&]ssl=[^&]*/g, '');
    pools[dbUrl] = mysql.createPool({
      uri: cleanUrl,
      ssl: { rejectUnauthorized: true },
      waitForConnections: true,
      connectionLimit: 5, // Increased for better performance
      maxIdle: 5,
      idleTimeout: 60000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });
  }
  return pools[dbUrl];
}

// Router for Student Databases
function getDbUrl(gradeLevel) {
  const grade = Number(gradeLevel);
  if (grade >= 1 && grade <= 6) return process.env.DB_PRIMARY;
  if (grade >= 7 && grade <= 9) return process.env.DB_PREP;
  if (grade >= 10 && grade <= 12) return process.env.DB_SECONDARY;
  return null;
}

// ─────────────────────────────────────────────────────────
// 2. SECURITY MIDDLEWARE (JWT Protection)
// ─────────────────────────────────────────────────────────
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Format: "Bearer TOKEN"

  if (!token) return res.status(401).json({ error: 'Access Denied. No token provided.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.user = user; 
    next();
  });
}

// ─────────────────────────────────────────────────────────
// 3. ENTERPRISE RBAC & STAFF ROUTES (For your new Flutter App)
// Note: We use DB_PRIMARY as the master database for Staff logins.
// ─────────────────────────────────────────────────────────

// 🔒 SECURE REGISTRATION (Run this once via Postman/App to create users)
app.post('/api/admin/register', async (req, res) => {
  const { username, password, teacher_name_ar, role, gov_code, admin_zone, school_name } = req.body;

  if (!username || !password || !role) {
    return res.status(400).json({ error: 'Username, password, and role are required.' });
  }

  let connection;
  try {
    const pool = getPool(process.env.DB_PRIMARY);
    connection = await pool.getConnection();

    // 🚀 Hash the password before saving to DB
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const [result] = await connection.execute(
      `INSERT INTO test.teachers 
       (username, password_hash, teacher_name_ar, role, gov_code, admin_zone, school_name) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [username, passwordHash, teacher_name_ar || username, role, gov_code || null, admin_zone || 'ALL', school_name || 'ALL']
    );

    res.status(201).json({ message: 'User created securely', userId: result.insertId });
  } catch (error) {
    console.error('[Register Error]:', error.message);
    res.status(500).json({ error: 'Failed to create user', details: error.message });
  } finally {
    if (connection) connection.release();
  }
});

// 🔓 STAFF LOGIN (Verifies Bcrypt Hash and issues JWT)
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  let connection;
  try {
    const pool = getPool(process.env.DB_PRIMARY);
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      `SELECT * FROM test.teachers WHERE username = ? AND is_active = TRUE`, 
      [username]
    );

    if (rows.length === 0) return res.status(401).json({ error: 'Invalid username or password' });

    const user = rows[0];

    // 🚀 Compare the provided password with the secure DB hash
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(401).json({ error: 'Invalid username or password' });

    // Generate Secure JWT
    const token = jwt.sign(
      { 
        teacher_id: user.teacher_id, 
        role: user.role, 
        admin_zone: user.admin_zone,
        school_name: user.school_name 
      },
      JWT_SECRET,
      { expiresIn: '12h' } // Token expires in 12 hours
    );

    return res.status(200).json({
      success: true,
      token: token,
      user: {
        teacher_name_ar: user.teacher_name_ar,
        role: user.role,
        admin_zone: user.admin_zone,
        school_name: user.school_name
      }
    });
  } catch (error) {
    console.error('[Login Error]:', error.message);
    return res.status(500).json({ error: 'Database query failed' });
  } finally {
    if (connection) connection.release();
  }
});

// 📁 GET DATA HIERARCHY (Requires JWT Token)
app.get('/api/hierarchy/schools', authenticateToken, async (req, res) => {
  const { role, admin_zone, school_name } = req.user;
  let connection;

  try {
    const pool = getPool(process.env.DB_PRIMARY);
    connection = await pool.getConnection();

    let query = `SELECT DISTINCT school_name, admin_zone FROM test.teachers WHERE school_name != 'ALL'`;
    let params = [];

    // Filter based on RBAC rules!
    if (role === 'district') {
      query += ` AND admin_zone = ?`;
      params.push(admin_zone);
    } else if (role === 'principal' || role === 'teacher') {
      query += ` AND school_name = ?`;
      params.push(school_name);
    }

    const [schools] = await connection.execute(query, params);
    res.status(200).json({ schools });

  } catch (error) {
    console.error('[Hierarchy Error]:', error.message);
    res.status(500).json({ error: 'Failed to fetch schools' });
  } finally {
    if (connection) connection.release();
  }
});


// ─────────────────────────────────────────────────────────
// 4. LEGACY STUDENT ROUTES (Kept exactly as you had them)
// ─────────────────────────────────────────────────────────
const GOVERNORATES = [
  "القاهرة", "الإسكندرية", "الجيزة", "القليوبية", "الدقهلية", "الشرقية", "الغربية",
  "المنوفية", "البحيرة", "كفر الشيخ", "دمياط", "بورسعيد", "الإسماعيلية", "السويس",
  "مطروح", "شمال سيناء", "جنوب سيناء", "بني سويف", "الفيوم", "المنيا", "أسيوط",
  "سوهاج", "قنا", "الأقصر", "أسوان", "البحر الأحمر", "الوادي الجديد"
];

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Madrastna Enterprise API v2',
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/studentLogin', async (req, res) => {
  const { ssn_encrypted, grade_level } = req.body;
  if (!ssn_encrypted || !grade_level) return res.status(400).json({ error: 'ssn_encrypted and grade_level are required' });
  if (!/^\d{14}$/.test(String(ssn_encrypted))) return res.status(400).json({ error: 'ssn_encrypted must be exactly 14 digits' });

  const dbUrl = getDbUrl(grade_level);
  if (!dbUrl) return res.status(400).json({ error: `Invalid grade_level: ${grade_level}` });

  let connection;
  try {
    const pool = getPool(dbUrl);
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      `SELECT student_name_ar, school_name, class_name, admin_zone, gov_code, gender FROM test.students WHERE ssn_encrypted = ?`,
      [String(ssn_encrypted)]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Student ID not found in this grade.', ssn_encrypted, grade_level });

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
    return res.status(500).json({ error: 'Database query failed', details: error.message });
  } finally {
    if (connection) connection.release();
  }
});

app.post('/api/addStudent', async (req, res) => {
  const { ssn_encrypted, student_name_ar, gender, gov_code, admin_zone, school_name, grade_level, class_name } = req.body;
  if (!ssn_encrypted || !grade_level) return res.status(400).json({ error: 'ssn_encrypted and grade_level are required' });

  const dbUrl = getDbUrl(grade_level);
  if (!dbUrl) return res.status(400).json({ error: `Invalid grade_level: ${grade_level}.` });

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
        `UPDATE test.students SET student_name_ar = ?, gender = ?, gov_code = ?, admin_zone = ?, school_name = ?, grade_level = ?, class_name = ? WHERE ssn_encrypted = ?`,
        [student_name_ar || null, gender || null, numericGovCode, admin_zone || null, school_name || null, grade_level, class_name || null, ssn_encrypted]
      );
      affectedRows = updateResult.affectedRows;
    } else {
      const [insertResult] = await connection.execute(
        `INSERT INTO test.students (ssn_encrypted, student_name_ar, gender, gov_code, admin_zone, school_name, grade_level, class_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [ssn_encrypted, student_name_ar || null, gender || null, numericGovCode, admin_zone || null, school_name || null, grade_level, class_name || null]
      );
      affectedRows = insertResult.affectedRows;
    }
    return res.status(200).json({ message: 'Student saved successfully', affectedRows });
  } catch (error) {
    return res.status(500).json({ error: 'Database operation failed', details: error.message });
  } finally {
    if (connection) connection.release();
  }
});

app.post('/api/logAction', async (req, res) => {
  const data = req.body;
  const actions = Array.isArray(data.actions) ? data.actions : [data];

  for (const action of actions) {
    if (!action.ssn_encrypted || !action.grade_level || !action.action_type) return res.status(400).json({ error: 'Invalid action format' });
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
    if (!dbUrl) continue;

    let connection;
    try {
      const pool = getPool(dbUrl);
      connection = await pool.getConnection();
      const placeholders = gradeActions.map(() => '(?, ?, ?)').join(', ');
      const values = gradeActions.flatMap(a => [String(a.ssn_encrypted), Number(a.action_type), a.metadata ? JSON.stringify(a.metadata) : null]);
      await connection.execute(`INSERT INTO test.activity_logs (ssn_encrypted, action_type, metadata) VALUES ${placeholders}`, values);
      results.push({ grade_level: gradeLevel, logged: gradeActions.length });
    } catch (error) {
      results.push({ grade_level: gradeLevel, error: error.message });
    } finally {
      if (connection) connection.release();
    }
  }
  return res.status(200).json({ message: 'Actions logged', results });
});

// ─────────────────────────────────────────────────────────
// SERVER STARTUP & SHUTDOWN
// ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Madrastna Enterprise Backend v2.0 running on port ${PORT}`);
});

async function shutdown(signal) {
  console.log(`\n⏳ ${signal} received — shutting down gracefully...`);
  server.close(async () => {
    for (const [url, pool] of Object.entries(pools)) {
      try { await pool.end(); } catch (err) { console.error(`Error closing pool: ${err.message}`); }
    }
    console.log('👋 Server shut down cleanly.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
