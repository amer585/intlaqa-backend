const { getDbUrl } = require('../config');
const { withConnection } = require('../db/pools');
const AppError = require('../lib/AppError');

function normalizeActions(payload) {
  const envelope = payload || {};
  const actions = Array.isArray(envelope.actions) ? envelope.actions : [envelope];

  for (const action of actions) {
    if (!action.ssn_encrypted || !action.grade_level || !action.action_type) {
      throw new AppError(400, 'Invalid action format');
    }
  }

  return actions;
}

function groupActionsByGrade(actions) {
  return actions.reduce((grouped, action) => {
    const key = String(action.grade_level);

    if (!grouped[key]) {
      grouped[key] = [];
    }

    grouped[key].push(action);
    return grouped;
  }, {});
}

async function writeActionGroup(gradeLevel, actions) {
  const dbUrl = getDbUrl(gradeLevel);

  if (!dbUrl) {
    return { grade_level: gradeLevel, skipped: true };
  }

  return withConnection(dbUrl, async (connection) => {
    const placeholders = actions.map(() => '(?, ?, ?)').join(', ');
    const values = actions.flatMap((action) => [
      String(action.ssn_encrypted),
      Number(action.action_type),
      action.metadata ? JSON.stringify(action.metadata) : null,
    ]);

    await connection.execute(
      `INSERT INTO test.activity_logs (ssn_encrypted, action_type, metadata)
       VALUES ${placeholders}`,
      values
    );

    return { grade_level: gradeLevel, logged: actions.length };
  });
}

async function logActions(payload) {
  const actions = normalizeActions(payload);
  const grouped = groupActionsByGrade(actions);

  const results = await Promise.all(
    Object.entries(grouped).map(async ([gradeLevel, gradeActions]) => {
      try {
        return await writeActionGroup(gradeLevel, gradeActions);
      } catch (error) {
        return { grade_level: gradeLevel, error: error.message };
      }
    })
  );

  return {
    message: 'Actions logged',
    results,
  };
}

module.exports = {
  logActions,
};
