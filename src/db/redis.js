'use strict';

const { config } = require('../config/env');
const logger = require('../lib/logger');

const baseUrl = config.upstashRedisUrl;
const token = config.upstashRedisToken;
const enabled = Boolean(baseUrl && token);

/**
 * Run one command against the Upstash Redis REST API.
 * Upstash expects a JSON array of command parts, e.g. ["SET","k","v","EX",300].
 * Returns null when Redis is disabled or any error occurs — caching must never
 * break a request (cache-aside, degrade-to-DB).
 *
 * v5: failures now log a single warn line so a silently-degrading Upstash is
 * observable (previously every error was swallowed and a 503-from-Upstash was
 * indistinguishable from a cache miss).
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
    if (!res.ok) {
      logger.warn('Redis command non-OK', { status: res.status, cmd: args[0] });
      return null;
    }
    const data = await res.json();
    return data?.result ?? null;
  } catch (error) {
    logger.warn('Redis command failed', { cmd: args[0], message: error.message });
    return null;
  }
}

/**
 * v5 NEW — Run a PIPELINE of commands in ONE HTTP POST.
 *
 * Upstash REST accepts a JSON body that is either a single command array
 * (`["GET","k"]`) OR an array-of-arrays (`[["DEL","k1"],["DEL","k2"]]`) which it
 * executes as an atomic pipeline and returns an array of results. This collapses
 * N sequential HTTP round-trips (≈N×Upstash-latency, often 30–60ms each) into
 * ONE — the dominant cache-perf win for the write-path invalidation loops.
 *
 * Returns the array of per-command results (or null on failure / disabled).
 * Failures log a single warn and return null — callers must treat that as
 * "all commands failed" and fall back to per-key ops or just DB.
 * @param {string[][]} cmds
 * @returns {Promise<unknown[] | null>}
 */
async function commandBatch(cmds) {
  if (!enabled || !Array.isArray(cmds) || cmds.length === 0) return null;
  try {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cmds),
    });
    if (!res.ok) {
      logger.warn('Redis pipeline non-OK', { status: res.status, count: cmds.length });
      return null;
    }
    const data = await res.json();
    // Upstash returns either the array directly or `[{result:..},..]` depending
    // on the format; normalize to a flat array of results.
    if (Array.isArray(data)) return data.map((d) => (d && typeof d === 'object' && 'result' in d ? d.result : d));
    return data?.result ?? null;
  } catch (error) {
    logger.warn('Redis pipeline failed', { count: cmds.length, message: error.message });
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

/**
 * v5 NEW — Delete N keys in a single Upstash pipeline.
 * @param {string[]} keys
 * @returns {Promise<number | null>} number deleted, or null if disabled/failed
 */
async function redisDelBatch(keys) {
  if (!enabled || !Array.isArray(keys) || keys.length === 0) return null;
  const cmds = keys.map((k) => ['DEL', k]);
  const results = await commandBatch(cmds);
  if (!results) return null;
  // Each DEL returns the count of keys it removed (1 or 0). Sum.
  return results.reduce((acc, r) => acc + (Number(r) || 0), 0);
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
  redisDelBatch,
  commandBatch,
  redisPing,
};
