'use strict';

// POST /api/auth — OAuth 2.0 Authorization Code + PKCE token exchange.
//
// Google's implicit flow (response_type=id_token) is deprecated, so the
// extension now runs Authorization Code flow with PKCE. The code-for-token
// exchange MUST happen here on the backend because it requires the OAuth client
// secret, and anything shipped inside a Chrome extension is publicly readable.
//
// This endpoint exchanges a one-time authorization code for tokens, verifies the
// returned id_token with the SAME verifier used by /api/generate, and returns
// only the verified id_token plus a small profile. It never returns (or logs)
// the access token, any refresh token, the raw code, the PKCE verifier, or the
// client secret.

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

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Authorization codes are short; cap generously to reject obvious junk without
// guessing Google's exact format.
const MAX_CODE_LENGTH = 2048;
// PKCE code verifier is 43–128 chars from the unreserved set (RFC 7636 §4.1).
const MIN_VERIFIER_LENGTH = 43;
const MAX_VERIFIER_LENGTH = 128;
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]+$/;

// The one extension identity we serve. The redirect URI is derived from it and
// pinned: we NEVER forward a caller-supplied redirect_uri to Google unchecked.
const PINNED_EXTENSION_ID = 'obdbogcpgepohhgmmhggnflagmebboee';
const ALLOWED_REDIRECT_URIS = new Set([
  `https://${PINNED_EXTENSION_ID}.chromiumapp.org/`,
]);

// Sign-in is a rare event (once per browser session / token refresh), so this
// limit is much tighter than /api/generate. A low ceiling still leaves ample
// headroom for a real user while making it pointless to spin this endpoint to
// burn Google's token-exchange quota or the owner's budget. Keyed per client IP
// under an `auth:` namespace so it is independent of the generate buckets.
const AUTH_HOURLY_LIMIT = 10;
const AUTH_DAILY_LIMIT = 40;

async function auth(request, context = console) {
  const startedAt = Date.now();
  let status = 500;
  const origin = getHeader(request, 'origin') || '';
  const extensionId = getHeader(request, 'x-extension-id') || '';
  const corsHeaders = corsFor(origin);

  try {
    // Same origin protection as /api/generate (shared checkOrigin): Origin OR
    // X-Extension-Id must match the allowlist. This endpoint must not be callable
    // from arbitrary websites.
    const originCheck = checkOrigin(origin, process.env.ALLOWED_ORIGINS || '', extensionId);

    if (request.method === 'OPTIONS') {
      status = originCheck.allowed ? 204 : 403;
      return response(status, null, corsHeaders);
    }
    if (request.method !== 'POST') {
      status = 405;
      return response(status, { error: 'bad_request', message: 'Use POST.' }, corsHeaders);
    }
    if (!originCheck.allowed) {
      status = 403;
      return response(status, { error: 'bad_request', message: 'Origin not allowed.' }, corsHeaders);
    }

    // Fail closed when the OAuth client is not configured: without the secret we
    // cannot exchange, and without the client id we cannot verify the id_token.
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      context.warn?.('GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not configured; /api/auth failing closed.');
      status = 503;
      return response(
        status,
        { error: 'identity_not_configured', message: 'Sign-in is not configured on the server.' },
        corsHeaders
      );
    }

    // Rate limit before touching Google, so abuse cannot burn quota.
    const ip = clientIp(request);
    const rate = await checkRateLimit(
      `auth:${ip}`,
      process.env.AzureWebJobsStorage,
      context,
      Date.now(),
      { hourly: AUTH_HOURLY_LIMIT, daily: AUTH_DAILY_LIMIT }
    );
    if (!rate.allowed) {
      status = 429;
      return response(
        status,
        { error: 'rate_limited', message: 'Too many sign-in attempts. Please try again later.' },
        { ...corsHeaders, 'Retry-After': String(rate.retryAfterSeconds) }
      );
    }

    const rawBody = await readBody(request);
    let parsed;
    try {
      parsed = JSON.parse(rawBody || '{}');
    } catch (_) {
      status = 400;
      return response(status, { error: 'bad_request', message: 'Body must be JSON.' }, corsHeaders);
    }

    const validation = validateAuthPayload(parsed);
    if (!validation.ok) {
      status = 400;
      return response(status, { error: 'bad_request', message: validation.message }, corsHeaders);
    }
    const { code, codeVerifier, redirectUri } = validation.value;

    const exchange = await exchangeCode(
      { code, codeVerifier, redirectUri, clientId, clientSecret },
      context
    );
    if (!exchange.ok) {
      status = exchange.status;
      return response(status, { error: exchange.error, message: exchange.message }, corsHeaders);
    }

    // Verify the returned id_token before trusting a single claim in it.
    const verified = await verifyGoogleIdToken(exchange.idToken, { clientId });
    if (!verified.ok) {
      status = 401;
      return response(
        status,
        { error: 'invalid_token', message: 'The identity token could not be verified.' },
        corsHeaders
      );
    }

    const claims = verified.claims;
    status = 200;
    // Return ONLY the verified id_token, its expiry, and a small profile. The
    // access token and any refresh token were deliberately never read from the
    // exchange response and are not returned.
    return response(
      status,
      {
        idToken: exchange.idToken,
        expiresAt: claims.exp,
        account: {
          sub: claims.sub,
          email: claims.email || null,
          name: claims.name || null,
          picture: claims.picture || null,
        },
      },
      corsHeaders
    );
  } catch (error) {
    // Unexpected failures only. Never leak details to the body.
    context.error?.('FocusFlow auth endpoint error:', error?.message || error);
    status = 500;
    return response(status, { error: 'exchange_failed', message: 'Sign-in failed. Please try again.' }, corsHeaders);
  } finally {
    // Log an outcome category only — never the code, verifier, secret, tokens or
    // email. Authorization codes are single-use credentials; logs are not safe.
    context.log?.(JSON.stringify({ endpoint: 'auth', status, latencyMs: Date.now() - startedAt }));
  }
}

// Validate the untrusted request body. The redirect URI in particular is treated
// as hostile input and must match our pinned allowlist — we never pass an
// arbitrary caller-supplied redirect_uri on to Google.
function validateAuthPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'Invalid request body.' };
  }

  const { code, codeVerifier, redirectUri } = raw;

  if (typeof code !== 'string' || code.length < 1 || code.length > MAX_CODE_LENGTH) {
    return { ok: false, message: 'Missing or invalid authorization code.' };
  }
  if (
    typeof codeVerifier !== 'string' ||
    codeVerifier.length < MIN_VERIFIER_LENGTH ||
    codeVerifier.length > MAX_VERIFIER_LENGTH ||
    !VERIFIER_PATTERN.test(codeVerifier)
  ) {
    return { ok: false, message: 'Missing or invalid PKCE verifier.' };
  }
  if (typeof redirectUri !== 'string' || !ALLOWED_REDIRECT_URIS.has(redirectUri)) {
    return { ok: false, message: 'Invalid redirect URI.' };
  }

  return { ok: true, value: { code, codeVerifier, redirectUri } };
}

// Exchange the authorization code at Google's token endpoint. Any non-OK
// response from Google (invalid/expired code, mismatched verifier, etc.) becomes
// a clean, categorised 4xx — never a 500 or a raw error body. `fetchImpl` is
// injectable so tests can simulate Google without network access.
async function exchangeCode(
  { code, codeVerifier, redirectUri, clientId, clientSecret },
  context = console,
  fetchImpl = fetch
) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    // We intentionally request no offline access; we do not want a refresh token.
  });

  let res;
  try {
    res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
    });
  } catch (_) {
    // Transport/timeout problem reaching Google.
    context.warn?.('Token exchange transport error.');
    return { ok: false, status: 502, error: 'exchange_failed', message: 'Could not reach the identity provider.' };
  }

  let body = {};
  try {
    body = await res.json();
  } catch (_) {
    body = {};
  }

  if (!res.ok) {
    // Log the coarse Google error category only (e.g. invalid_grant), never the
    // code/verifier. Map everything to a single 4xx category for the client.
    context.warn?.(`Token exchange rejected (http ${res.status}, error ${body?.error || 'unknown'}).`);
    return { ok: false, status: 400, error: 'exchange_failed', message: 'Authorization code exchange failed.' };
  }

  const idToken = body.id_token;
  if (typeof idToken !== 'string' || !idToken) {
    return { ok: false, status: 400, error: 'exchange_failed', message: 'No identity token returned.' };
  }

  // Security: we never read body.access_token or body.refresh_token. Even if
  // Google returned a refresh token, it is discarded here and never persisted.
  return { ok: true, idToken };
}

if (azureFunctionsApp) {
  azureFunctionsApp.http('auth', {
    route: 'auth',
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    handler: auth,
  });
}

module.exports = {
  auth,
  validateAuthPayload,
  exchangeCode,
  ALLOWED_REDIRECT_URIS,
  AUTH_HOURLY_LIMIT,
  AUTH_DAILY_LIMIT,
};
