'use strict';

// Shared HTTP helpers used by every function in this app (generate, auth, ...).
// Kept in one place so the origin check, CORS, body reading and rate limiter
// cannot drift out of sync between endpoints.

const crypto = require('crypto');

const RATE_TABLE = 'FocusFlowRateLimit';

// Default per-client ceiling used by /api/generate. Individual callers may pass
// tighter limits (e.g. the auth endpoint, or a per-account bucket).
const DEFAULT_HOURLY_LIMIT = 60;
const DEFAULT_DAILY_LIMIT = 300;

function getHeader(request, name) {
  if (!request?.headers) return '';
  if (typeof request.headers.get === 'function') return request.headers.get(name) || '';
  return request.headers[name.toLowerCase()] || request.headers[name] || '';
}

async function readBody(request) {
  if (typeof request.text === 'function') return request.text();
  if (typeof request.body === 'string') return request.body;
  if (request.body && typeof request.body === 'object') return JSON.stringify(request.body);
  return '';
}

function response(status, body, headers = {}) {
  return {
    status,
    headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  };
}

function corsFor(origin) {
  return {
    'Access-Control-Allow-Origin': origin || 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    // Authorization is included because /api/generate accepts a Bearer identity
    // token; browser (content-script) callers need it in the preflight allow-list.
    'Access-Control-Allow-Headers': 'Content-Type, X-Extension-Id, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// Requests from an extension service worker are not CORS requests, so Chrome
// may omit the Origin header entirely. In that case fall back to the extension
// id the worker sends explicitly. Both signals are equally spoofable by a
// non-browser client, so this is a filter against casual misuse, not a wall;
// the rate limiter and size caps are what actually bound abuse.
function checkOrigin(origin, allowedOrigins, extensionId) {
  const allowed = String(allowedOrigins || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (origin) return { origin, allowed: allowed.includes(origin) };
  if (extensionId) {
    return { origin: '', allowed: allowed.includes(`chrome-extension://${extensionId}`) };
  }
  return { origin: '', allowed: false };
}

function clientIp(request) {
  const forwarded = getHeader(request, 'x-forwarded-for').split(',')[0].trim();
  const withoutPort = forwarded.replace(/^\[([^\]]+)\](?::\d+)?$/, '$1').replace(/:\d+$/, '');
  return withoutPort || 'unknown';
}

// Table Storage rate limiting using AzureWebJobsStorage. It fails open with a
// warning if storage is unavailable, keeping local dev simple.
//
// LIMITATION: this limiter is only as durable as its backing store. When
// AzureWebJobsStorage is configured (as in the deployed app) counts persist in
// Table Storage; when it is absent (e.g. local dev) the function fails OPEN and
// does NOT rate-limit at all. Either way this is best-effort and NOT a hard
// spend guarantee — do not treat these limits as a billing ceiling.
async function checkRateLimit(
  key,
  connectionString = process.env.AzureWebJobsStorage,
  context = console,
  now = Date.now(),
  limits = { hourly: DEFAULT_HOURLY_LIMIT, daily: DEFAULT_DAILY_LIMIT }
) {
  if (!connectionString) return { allowed: true, retryAfterSeconds: 0 };
  const hourlyLimit = limits?.hourly ?? DEFAULT_HOURLY_LIMIT;
  const dailyLimit = limits?.daily ?? DEFAULT_DAILY_LIMIT;

  try {
    const { TableClient } = require('@azure/data-tables');
    const tableClient = TableClient.fromConnectionString(connectionString, RATE_TABLE);
    await tableClient.createTable().catch((error) => {
      if (error.statusCode !== 409) throw error;
    });

    const partitionKey = crypto.createHash('sha256').update(key || 'unknown').digest('hex').slice(0, 32);
    const rowKey = 'window';
    let timestamps = [];
    try {
      const entity = await tableClient.getEntity(partitionKey, rowKey);
      timestamps = JSON.parse(entity.timestamps || '[]');
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }

    const dayAgo = now - 24 * 60 * 60 * 1000;
    const hourAgo = now - 60 * 60 * 1000;
    timestamps = timestamps.filter((ts) => Number.isFinite(ts) && ts > dayAgo);
    const hourly = timestamps.filter((ts) => ts > hourAgo);

    if (hourly.length >= hourlyLimit || timestamps.length >= dailyLimit) {
      const hourlyLimited = hourly.length >= hourlyLimit;
      const oldest = Math.min(...(hourlyLimited ? hourly : timestamps));
      const windowMs = hourlyLimited ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
      };
    }

    timestamps.push(now);
    await tableClient.upsertEntity({ partitionKey, rowKey, timestamps: JSON.stringify(timestamps) }, 'Replace');
    return { allowed: true, retryAfterSeconds: 0 };
  } catch (error) {
    context.warn?.('Rate limit unavailable; failing open:', error?.message || error);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

module.exports = {
  RATE_TABLE,
  DEFAULT_HOURLY_LIMIT,
  DEFAULT_DAILY_LIMIT,
  getHeader,
  readBody,
  response,
  corsFor,
  checkOrigin,
  clientIp,
  checkRateLimit,
};
