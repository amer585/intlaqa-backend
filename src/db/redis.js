'use strict';

const { config } = require('../config/env');

const baseUrl = config.upstashRedisUrl;
const token = config.upstashRedisToken;
const enabled = Boolean(baseUrl && token);

/**
 * Run one command against the Upstash Redis REST API.
 * Upstash expects a JSON array of command parts, e.g. ["SET","k","v","EX",300].
 * Returns null when Redis is disabled or any error occurs — caching must never
 * break a request (cache-aside, degrade-to-DB).
 * @param {string[]} args
 * @returns {Promise<unknown>}
 */
async function command(args) {
  if (!enabled) return null;
  try {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.result ?? null;
  } catch {
    return null;
  }
}

async function redisGet(key) {
  return command(['GET', key]);
}

async function redisSetEx(key, ttlSec, value) {
  return command(['SET', key, value, 'EX', Number(ttlSec)]);
}

async function redisDel(key) {
  return command(['DEL', key]);
}

/** @returns {Promise<{ enabled: boolean, ok?: boolean }>} */
async function redisPing() {
  if (!enabled) return { enabled: false };
  const result = await command(['PING']);
  return { enabled: true, ok: result === 'PONG' };
}

module.exports = {
  redisEnabled: enabled,
  redisGet,
  redisSetEx,
  redisDel,
  redisPing,
};
