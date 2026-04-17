const mysql = require('mysql2/promise');

const sqlStatements = [
  `CREATE TABLE IF NOT EXISTS students (
    ssn_encrypted   VARCHAR(14)   NOT NULL,
    student_name_ar VARCHAR(100)  DEFAULT NULL,
    gender          CHAR(1)       DEFAULT NULL,
    gov_code        VARCHAR(10)   DEFAULT NULL,
    admin_zone      VARCHAR(50)   DEFAULT NULL,
    school_name     VARCHAR(100)  DEFAULT NULL,
    grade_level     TINYINT       NOT NULL,
    class_name      VARCHAR(30)   DEFAULT NULL,
    created_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (ssn_encrypted)
  );`,
  `CREATE TABLE IF NOT EXISTS activity_logs (
    id              BIGINT        NOT NULL AUTO_INCREMENT,
    ssn_encrypted   VARCHAR(14)   NOT NULL,
    action_type     TINYINT       NOT NULL,
    metadata        JSON          DEFAULT NULL,
    logged_at       TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_ssn_time (ssn_encrypted, logged_at DESC)
  );`
];

exports.handler = async () => {
  const dbs = {
    Primary: process.env.DB_PRIMARY,
    Prep: process.env.DB_PREP,
    Secondary: process.env.DB_SECONDARY
  };

  const results = [];

  for (const [name, uri] of Object.entries(dbs)) {
    if (!uri) {
      results.push(`⚠️ Skipped ${name} Cluster (Environment variable not set in Netlify)`);
      continue;
    }

    let connection;
    try {
      connection = await mysql.createConnection({ uri, ssl: { rejectUnauthorized: true } });
      
      for (const statement of sqlStatements) {
        await connection.query(statement);
      }
      
      results.push(`✅ Success! Tables created on ${name} Cluster.`);
    } catch (err) {
      results.push(`❌ Failed on ${name} Cluster: ${err.message}`);
    } finally {
      if (connection) await connection.end();
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      message: "Migration Execution Complete", 
      details: results 
    }, null, 2)
  };
};
