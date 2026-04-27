require('dotenv').config();

const DEFAULT_PORT = 3000;
const DEFAULT_JWT_SECRET = 'madrastna-super-secret-key-2026';

const config = Object.freeze({
  port: Number.parseInt(process.env.PORT || DEFAULT_PORT, 10),
  jwtSecret: process.env.JWT_SECRET || DEFAULT_JWT_SECRET,
  jwtExpiresIn: '7d',
  schoolCacheTtlMs: 30 * 60 * 1000,
  dbUrls: Object.freeze({
    primary: process.env.DB_PRIMARY || null,
    prep: process.env.DB_PREP || null,
    secondary: process.env.DB_SECONDARY || null,
    teachers: process.env.DB_TEACHER || null,
  }),
  pool: Object.freeze({
    waitForConnections: true,
    connectionLimit: 5,
    maxIdle: 2,
    idleTimeout: 60000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
  }),
});

function getDbUrl(gradeLevel) {
  const grade = Number(gradeLevel);

  if (grade >= 1 && grade <= 6) return config.dbUrls.primary;
  if (grade >= 7 && grade <= 9) return config.dbUrls.prep;
  if (grade >= 10 && grade <= 12) return config.dbUrls.secondary;

  return null;
}

module.exports = {
  config,
  getDbUrl,
};
