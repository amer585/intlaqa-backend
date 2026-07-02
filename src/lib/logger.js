'use strict';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

/**
 * Minimal structured logger (no dependencies). Each call emits a single JSON
 * line so Gigalixir/Logdrains can ingest it cleanly.
 * @param {'error'|'warn'|'info'|'debug'} level
 * @param {string} message
 * @param {Record<string, unknown>} [meta]
 */
function log(level, message, meta) {
  if ((LEVELS[level] ?? LEVELS.info) > currentLevel) return;
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    message,
    ...(meta && Object.keys(meta).length ? { meta } : {}),
  });
  // eslint-disable-next-line no-console
  console[level === 'debug' ? 'log' : level](line);
}

module.exports = {
  error: (m, meta) => log('error', m, meta),
  warn: (m, meta) => log('warn', m, meta),
  info: (m, meta) => log('info', m, meta),
  debug: (m, meta) => log('debug', m, meta),
};
