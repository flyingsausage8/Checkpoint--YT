'use strict';

// POST /api/sync — store a signed-in user's settings so they follow the person
// to any device and any Chrome profile. This is the second half of issue #6.
//
// The whole point of this endpoint is that the storage key is derived ONLY from
// the cryptographically verified Google id token (`sub`). The request body can
// never name whose data it wants: a caller cannot read or write another user's
// row no matter what they put in the JSON. Get that wrong and any user could
// read everyone else's settings, so it is the single most important rule here.
//
// Unlike /api/generate, authentication is REQUIRED. No token / bad token /
// expired token is a hard 401 — we never fall back to anonymous and never
// invent a shared row.

const { verifyGoogleIdToken } = require('../auth/googleVerifier');
const {
  getHeader,
  readBody,
  response,
  corsFor,
  checkOrigin,
  clientIp,
  checkRateLimit,
} = require('../http/common');

let azureFunctionsApp = null;
try {
  ({ app: azureFunctionsApp } = require('@azure/functions'));
} catch (_) {
  azureFunctionsApp = null;
}

// The table that holds one row per user. Separate from the rate-limit table so
// the two concerns cannot collide.
const SETTINGS_TABLE = 'FocusFlowSettings';
const SETTINGS_ROW_KEY = 'settings';

// Settings are a handful of small fields; a well-formed body is a few hundred bytes. Cap
// well below that generosity so nobody can push a megabyte of JSON into a single
// table row (Table Storage entities are limited anyway, but we reject early).
const MAX_BODY_BYTES = 4096;

// Sync fires when a user changes a setting and once when a device loads its
// settings — chattier than sign-in (which is once per session) but far cheaper
// than /api/generate (which calls the AI). These per-IP ceilings leave a real
// user (even one switching devices and toggling options) ample headroom while
// still making it pointless to spin the endpoint. Keyed under a `sync:`
// namespace so it is independent of the auth and generate buckets.
const SYNC_HOURLY_LIMIT = 120;
const SYNC_DAILY_LIMIT = 600;

// A Google `sub` is a short numeric string, but we treat it as untrusted until
// proven safe as a Table Storage key. PartitionKey/RowKey may not contain
// `/ \ # ?` or control characters and have a length limit (1KB). Rather than
// sanitising an unexpected value — which could collide with another user's key —
// we reject anything outside this conservative allowlist. Digits, letters,
// `-` and `_` cover every real Google subject id and exclude every illegal
// character.
const SUB_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// updatedAt is a client clock in unix ms. Reject implausible values so a client
// with a broken clock can't pin its row into the far future and refuse every
// later write. We allow up to a day of skew ahead of server time.
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

// The ONLY settings we persist. Everything else in the body is ignored.
//
// proxyUrl and googleClientId are deliberately absent. proxyUrl is the URL the
// extension POSTs video transcripts to; if it were syncable, anyone who could
// write to a user's row could silently redirect that user's transcripts to a
// server they control. Endpoint configuration must never arrive over the
// network — it stays local to the device. googleClientId is likewise local
// identity config, not user preference. Do NOT add either here.
// The parts of YouTube focus mode can hide. Kept in step with FOCUS_PARTS in
// src/shared/settings.js. Listing them explicitly (rather than accepting any
// string) keeps this endpoint from becoming a place to store arbitrary text
// that is then handed back to every device on the account.
const FOCUS_PART_IDS = ['homeFeed', 'related', 'comments', 'shorts', 'endScreen', 'liveChat', 'guide'];

const SETTINGS_SCHEMA = {
  enabled: { type: 'boolean' },
  chunkMinutes: { type: 'number', min: 1, max: 60 },
  minVideoMinutes: { type: 'number', min: 0, max: 600 },
  autoPause: { type: 'boolean' },
  useAI: { type: 'boolean' },
  aiCheckpoints: { type: 'boolean' },
  focusMode: { type: 'enum', values: ['off', 'standard', 'complete', 'custom'] },
  focusParts: { type: 'idList', values: FOCUS_PART_IDS, maxLength: 200 },
};

// Build the real Table Storage client. Kept behind a factory so tests can inject
// a stub client instead — @azure/data-tables is not installed on the CI/dev box
// where registry.npmjs.org is blocked, exactly as checkRateLimit allows a
// connection string to be passed in.
function defaultGetTable(connectionString) {
  if (!connectionString) return null;
  const { TableClient } = require('@azure/data-tables');
  return TableClient.fromConnectionString(connectionString, SETTINGS_TABLE);
}

async function sync(request, context = console, deps = {}) {
  const {
    verify = verifyGoogleIdToken,
    getTable = defaultGetTable,
    connectionString = process.env.AzureWebJobsStorage,
    now = Date.now(),
  } = deps;

  const startedAt = Date.now();
  let status = 500;
  let outcome = 'error';
  const origin = getHeader(request, 'origin') || '';
  const extensionId = getHeader(request, 'x-extension-id') || '';
  const corsHeaders = corsFor(origin);

  try {
    // Same origin protection as /api/auth (shared checkOrigin): Origin OR
    // X-Extension-Id must match the allowlist. Not callable from arbitrary sites.
    const originCheck = checkOrigin(origin, process.env.ALLOWED_ORIGINS || '', extensionId);

    if (request.method === 'OPTIONS') {
      status = originCheck.allowed ? 204 : 403;
      outcome = 'preflight';
      return response(status, null, corsHeaders);
    }
    if (request.method !== 'POST') {
      status = 405;
      outcome = 'bad_method';
      return response(status, { error: 'bad_request', message: 'Use POST.' }, corsHeaders);
    }
    if (!originCheck.allowed) {
      status = 403;
      outcome = 'bad_origin';
      return response(status, { error: 'bad_request', message: 'Origin not allowed.' }, corsHeaders);
    }

    // Authentication is REQUIRED. Pull the bearer token first; no token is a 401,
    // never an anonymous fallback.
    const authHeader = getHeader(request, 'authorization').trim();
    const bearer = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (!bearer) {
      status = 401;
      outcome = 'unauthorized';
      return response(status, { error: 'unauthorized', message: 'A Google sign-in token is required.' }, corsHeaders);
    }

    // GOOGLE_CLIENT_ID drives audience verification. When it is unset the verifier
    // returns identity_not_configured; map that to a distinct 503 so the owner can
    // tell "misconfigured server" apart from "bad token".
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      context.warn?.('GOOGLE_CLIENT_ID not configured; /api/sync failing closed.');
    }

    const verified = await verify(bearer[1], { clientId });
    if (!verified.ok) {
      if (verified.reason === 'identity_not_configured') {
        status = 503;
        outcome = 'identity_not_configured';
        return response(
          status,
          { error: 'identity_not_configured', message: 'Sign-in is not configured on the server.' },
          corsHeaders
        );
      }
      status = 401;
      outcome = 'unauthorized';
      return response(status, { error: 'unauthorized', message: 'The sign-in token could not be verified.' }, corsHeaders);
    }

    // The storage key comes ONLY from the verified token, never the body.
    const sub = verified.claims.sub;
    if (typeof sub !== 'string' || !SUB_PATTERN.test(sub)) {
      // A subject id we cannot safely use as a table key. Reject rather than risk
      // collapsing it onto another user's row.
      status = 401;
      outcome = 'unauthorized';
      return response(status, { error: 'unauthorized', message: 'The sign-in token could not be verified.' }, corsHeaders);
    }

    // Rate limit per client IP under the sync namespace.
    const ip = clientIp(request);
    const rate = await checkRateLimit(
      `sync:${ip}`,
      connectionString,
      context,
      now,
      { hourly: SYNC_HOURLY_LIMIT, daily: SYNC_DAILY_LIMIT }
    );
    if (!rate.allowed) {
      status = 429;
      outcome = 'rate_limited';
      return response(
        status,
        { error: 'rate_limited', message: 'Too many sync requests. Please try again later.' },
        { ...corsHeaders, 'Retry-After': String(rate.retryAfterSeconds) }
      );
    }

    // Reject an oversized body before parsing so we never even build a huge object.
    const rawBody = await readBody(request);
    if (Buffer.byteLength(rawBody || '', 'utf8') > MAX_BODY_BYTES) {
      status = 400;
      outcome = 'bad_request';
      return response(status, { error: 'bad_request', message: 'Request body is too large.' }, corsHeaders);
    }

    let parsed;
    try {
      parsed = JSON.parse(rawBody || '{}');
    } catch (_) {
      status = 400;
      outcome = 'bad_request';
      return response(status, { error: 'bad_request', message: 'Body must be JSON.' }, corsHeaders);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      status = 400;
      outcome = 'bad_request';
      return response(status, { error: 'bad_request', message: 'Invalid request body.' }, corsHeaders);
    }

    const op = parsed.op;
    if (op !== 'get' && op !== 'put') {
      status = 400;
      outcome = 'bad_request';
      return response(status, { error: 'bad_request', message: 'op must be "get" or "put".' }, corsHeaders);
    }

    // Build the table client. If storage is not configured we cannot serve sync at
    // all — and unlike rate limiting we must NOT fail open, because losing a
    // user's settings silently is worse than an honest error.
    let table;
    try {
      table = getTable(connectionString);
    } catch (error) {
      context.error?.('Settings table client could not be created.');
      table = null;
    }
    if (!table) {
      status = 503;
      outcome = 'storage_unavailable';
      return response(status, { error: 'storage_unavailable', message: 'Settings storage is unavailable.' }, corsHeaders);
    }

    if (op === 'get') {
      let result;
      try {
        result = await readSettings(table, sub);
      } catch (error) {
        context.error?.('Settings read failed.');
        status = 503;
        outcome = 'storage_unavailable';
        return response(status, { error: 'storage_unavailable', message: 'Settings storage is unavailable.' }, corsHeaders);
      }
      status = 200;
      outcome = 'get_ok';
      // No stored row is a normal empty state, not an error.
      return response(status, { settings: result.settings, updatedAt: result.updatedAt }, corsHeaders);
    }

    // op === 'put'
    const validation = validatePut(parsed, now);
    if (!validation.ok) {
      status = 400;
      outcome = 'bad_request';
      return response(status, { error: 'bad_request', message: validation.message }, corsHeaders);
    }
    const { settings, updatedAt } = validation.value;

    let stored;
    try {
      stored = await readSettings(table, sub);
    } catch (error) {
      context.error?.('Settings read (pre-write) failed.');
      status = 503;
      outcome = 'storage_unavailable';
      return response(status, { error: 'storage_unavailable', message: 'Settings storage is unavailable.' }, corsHeaders);
    }

    // Last-write-wins on the client updatedAt. If what's stored is NEWER than the
    // incoming write, the incoming write is stale: keep the stored row untouched
    // and hand the stored values back so the client can reconcile.
    if (stored.updatedAt !== null && stored.updatedAt > updatedAt) {
      status = 200;
      outcome = 'put_stale';
      return response(status, { settings: stored.settings, updatedAt: stored.updatedAt }, corsHeaders);
    }

    try {
      await writeSettings(table, sub, settings, updatedAt);
    } catch (error) {
      context.error?.('Settings write failed.');
      status = 503;
      outcome = 'storage_unavailable';
      return response(status, { error: 'storage_unavailable', message: 'Settings storage is unavailable.' }, corsHeaders);
    }
    status = 200;
    outcome = 'put_ok';
    return response(status, { settings, updatedAt }, corsHeaders);
  } catch (error) {
    // Unexpected failures only. Never leak details into the body.
    context.error?.('FocusFlow sync endpoint error:', error?.message || error);
    status = 500;
    outcome = 'error';
    return response(status, { error: 'storage_unavailable', message: 'Sync failed. Please try again.' }, corsHeaders);
  } finally {
    // Log only endpoint, outcome category, status and latency. Never the token,
    // the sub, or the settings body.
    context.log?.(JSON.stringify({ endpoint: 'sync', outcome, status, latencyMs: Date.now() - startedAt }));
  }
}

// Read the user's row. Returns {settings: null, updatedAt: null} when absent
// (a genuine 404), and rethrows any other storage error so the caller can turn
// it into storage_unavailable rather than a false empty result.
async function readSettings(table, sub) {
  await ensureTable(table);
  try {
    const entity = await table.getEntity(sub, SETTINGS_ROW_KEY);
    let settings = null;
    try {
      settings = JSON.parse(entity.settingsJson || 'null');
    } catch (_) {
      settings = null;
    }
    // updatedAt is persisted as Edm.Int64 (see writeSettings for why). The SDK
    // hands an Int64 back as a STRING, because a unix-ms value can exceed
    // Number.MAX_SAFE_INTEGER's friends in the Int32 space and JS numbers lose
    // precision above 2^53. Some SDK/config combinations instead return an
    // { value, type } object. Normalise both shapes — and any legacy bare number —
    // to a real number, and guard against NaN so a corrupt cell degrades to
    // "no timestamp" rather than poisoning the last-write-wins comparison.
    const updatedAt = coerceUpdatedAt(entity.updatedAt);
    return { settings, updatedAt };
  } catch (error) {
    if (error && error.statusCode === 404) return { settings: null, updatedAt: null };
    throw error;
  }
}

async function writeSettings(table, sub, settings, updatedAt) {
  await ensureTable(table);
  // Store settings as a single JSON string column so adding a new setting later
  // needs no schema change. PartitionKey is the verified sub; RowKey is fixed.
  //
  // updatedAt MUST be written as an explicit Edm.Int64. A unix-MILLISECOND
  // timestamp (~1.79e12) is ~800x larger than Edm.Int32's max (2,147,483,647),
  // which is the type the data-tables serializer infers for a bare JS number —
  // so passing the raw number makes Azure reject the write with
  // "too large to be cast to type EdmType.INT32". The { value: String(...),
  // type: "Int64" } form pins the type; passing a large plain number is
  // unreliable (it can throw, or silently land as Edm.Double, which reads back
  // as a different type than we wrote).
  await table.upsertEntity(
    {
      partitionKey: sub,
      rowKey: SETTINGS_ROW_KEY,
      settingsJson: JSON.stringify(settings),
      updatedAt: { value: String(updatedAt), type: 'Int64' },
    },
    'Replace'
  );
}

// Normalise the many shapes updatedAt can come back as (Int64 string, legacy bare
// number, or an { value, type } EDM object) into a plain number, or null when it
// is absent or unparseable.
function coerceUpdatedAt(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'object' && 'value' in raw) {
    const n = Number(raw.value);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Create the table on first use, ignoring the 409 that means it already exists —
// the same pattern checkRateLimit uses.
async function ensureTable(table) {
  if (typeof table.createTable !== 'function') return;
  await table.createTable().catch((error) => {
    if (error && error.statusCode !== 409) throw error;
  });
}

// Validate a put payload: the allowlisted settings (with types/ranges) plus a
// plausible updatedAt. Unknown keys — including proxyUrl and googleClientId — are
// simply dropped, never persisted.
function validatePut(raw, now) {
  const incoming = raw.settings;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { ok: false, message: 'settings must be an object.' };
  }

  const updatedAt = raw.updatedAt;
  if (
    typeof updatedAt !== 'number' ||
    !Number.isFinite(updatedAt) ||
    !Number.isInteger(updatedAt) ||
    updatedAt < 0 ||
    updatedAt > now + MAX_CLOCK_SKEW_MS
  ) {
    return { ok: false, message: 'updatedAt must be a plausible unix-ms timestamp.' };
  }

  const settings = {};
  for (const [name, rule] of Object.entries(SETTINGS_SCHEMA)) {
    const value = incoming[name];
    if (value === undefined) continue; // absent is fine; only sync what was sent
    if (rule.type === 'boolean') {
      if (typeof value !== 'boolean') {
        return { ok: false, message: `${name} must be a boolean.` };
      }
      settings[name] = value;
    } else if (rule.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < rule.min || value > rule.max) {
        return { ok: false, message: `${name} must be a number between ${rule.min} and ${rule.max}.` };
      }
      settings[name] = value;
    } else if (rule.type === 'enum') {
      if (!rule.values.includes(value)) {
        return { ok: false, message: `${name} must be one of: ${rule.values.join(', ')}.` };
      }
      settings[name] = value;
    } else if (rule.type === 'idList') {
      // A comma-separated list of known ids. Unknown entries are rejected rather
      // than dropped: this value is echoed back to every device on the account,
      // so it must never be a place to park arbitrary text.
      if (typeof value !== 'string' || value.length > rule.maxLength) {
        return { ok: false, message: `${name} must be a string of at most ${rule.maxLength} characters.` };
      }
      const parts = value === '' ? [] : value.split(',');
      if (parts.some((part) => !rule.values.includes(part))) {
        return { ok: false, message: `${name} must be a comma-separated list of: ${rule.values.join(', ')}.` };
      }
      settings[name] = value;
    }
  }

  return { ok: true, value: { settings, updatedAt } };
}

if (azureFunctionsApp) {
  azureFunctionsApp.http('sync', {
    route: 'sync',
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    handler: sync,
  });
}

module.exports = {
  sync,
  validatePut,
  readSettings,
  writeSettings,
  coerceUpdatedAt,
  SETTINGS_TABLE,
  SYNC_HOURLY_LIMIT,
  SYNC_DAILY_LIMIT,
  MAX_BODY_BYTES,
};
