'use strict';

// Full cryptographic verification of Google-issued ID tokens (JWTs).
//
// This module deliberately does NOT just base64-decode the token and trust its
// claims. An unverified JWT is attacker-controlled text: anyone can craft one
// that says `sub: "victim"`. We therefore verify the RSA signature against
// Google's published public keys before we believe a single claim, and we pin
// the algorithm, issuer, audience and time window ourselves.

const crypto = require('crypto');

const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';

// Google mints ID tokens with either of these two issuer strings.
const VALID_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

// The ONLY signing algorithm we accept. We check the token header's `alg`
// against this allow-list instead of trusting whatever the token asks for.
// Accepting the token's own choice of algorithm is the classic JWT
// vulnerability: `alg: none` (no signature at all) and RS256->HS256
// "algorithm confusion" (verifying an HMAC using the public key as the secret)
// both let an attacker forge tokens. Google uses RS256, so that is all we allow.
const ALLOWED_ALG = 'RS256';

// We tolerate ~60s of clock skew on exp/iat. The signer (Google), the caller,
// and this Function can each have a slightly different clock; without tolerance
// a perfectly valid token can be rejected in the seconds around exp or iat.
const CLOCK_SKEW_SECONDS = 60;

// Fallback JWKS lifetime when Google's response carries no Cache-Control.
const DEFAULT_JWKS_TTL_MS = 60 * 60 * 1000;

// Minimum spacing between "unknown kid" refetches. A hostile caller can send a
// token whose `kid` is random garbage; without this throttle every such request
// would force a fresh fetch of Google's certs and a full parse, letting the
// caller hammer Google and burn our execution time on demand. Once we've
// refetched recently, an unknown kid is simply rejected until the window passes.
const UNKNOWN_KID_REFETCH_INTERVAL_MS = 5 * 60 * 1000;

// In-memory JWKS cache, shared across invocations on the same warm instance.
let jwksCache = { keys: new Map(), expiresAt: 0 };
let lastFetchAt = 0;

function base64urlToBuffer(value) {
  if (typeof value !== 'string') throw new Error('not_base64url');
  return Buffer.from(value, 'base64url');
}

// Parse `max-age=NNN` out of a Cache-Control header, if present.
function parseMaxAgeMs(cacheControl) {
  const match = /(?:^|[,\s])max-age\s*=\s*(\d+)/i.exec(String(cacheControl || ''));
  if (!match) return null;
  return Number(match[1]) * 1000;
}

async function fetchJwks(fetchImpl, now) {
  const res = await fetchImpl(GOOGLE_JWKS_URI, { signal: AbortSignal.timeout(10000) });
  if (!res || !res.ok) {
    throw new Error(`jwks_http_${res ? res.status : 'no_response'}`);
  }
  const body = await res.json();
  const keys = new Map();
  for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    // A JWK that advertises a non-RS256 alg is not usable for us; skip it rather
    // than importing a key we would refuse to verify against anyway.
    if (jwk.alg && jwk.alg !== ALLOWED_ALG) continue;
    try {
      const keyObject = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      keys.set(jwk.kid, { keyObject, alg: jwk.alg || ALLOWED_ALG });
    } catch (_) {
      // Ignore individual malformed keys.
    }
  }

  const ttl = parseMaxAgeMs(res.headers?.get?.('cache-control')) || DEFAULT_JWKS_TTL_MS;
  jwksCache = { keys, expiresAt: now + ttl };
  lastFetchAt = now;
  return keys;
}

// Resolve the signing key for `kid`, refreshing the cache when needed while
// keeping refetches bounded so an unknown kid cannot be weaponised.
async function resolveKey(kid, fetchImpl, now) {
  // Normal periodic refresh once the cached keys expire.
  if (now >= jwksCache.expiresAt) {
    await fetchJwks(fetchImpl, now);
  }

  let key = jwksCache.keys.get(kid);
  if (key) return key;

  // Unknown kid on fresh cache => Google may have rotated keys. Refetch at most
  // once per interval so random-kid spam can't trigger a fetch storm.
  if (now - lastFetchAt >= UNKNOWN_KID_REFETCH_INTERVAL_MS) {
    await fetchJwks(fetchImpl, now);
    key = jwksCache.keys.get(kid);
  }
  return key || null;
}

/**
 * Verify a Google ID token.
 *
 * @param {string} token   The raw JWT from the Authorization: Bearer header.
 * @param {object} options
 *   - clientId  {string}   Expected `aud`. Required; without it we cannot check
 *                          audience, so we fail closed with identity_not_configured.
 *   - now       {number}   Current time in ms (injectable for tests).
 *   - fetchImpl {function} JWKS fetcher (injectable for tests).
 * @returns {Promise<{ok:true, claims:object} | {ok:false, reason:string}>}
 *
 * Reason codes are intentionally coarse (e.g. `bad_signature`, `expired`) so the
 * caller can surface a category without leaking anything that helps an attacker
 * probe. We never return the parsed token or its claims on failure.
 */
async function verifyGoogleIdToken(token, options = {}) {
  const {
    clientId = process.env.GOOGLE_CLIENT_ID,
    now = Date.now(),
    fetchImpl = fetch,
  } = options;

  // Fail closed: with no configured client ID we cannot validate `aud`, and a
  // token we cannot fully validate must be rejected, never trusted.
  if (!clientId) return { ok: false, reason: 'identity_not_configured' };

  if (typeof token !== 'string' || !token) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };

  let header;
  let payload;
  try {
    header = JSON.parse(base64urlToBuffer(parts[0]).toString('utf8'));
    payload = JSON.parse(base64urlToBuffer(parts[1]).toString('utf8'));
  } catch (_) {
    return { ok: false, reason: 'malformed' };
  }
  if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') {
    return { ok: false, reason: 'malformed' };
  }

  // Pin the algorithm before doing anything else. This rejects `alg: none` and
  // any algorithm-confusion attempt outright.
  if (header.alg !== ALLOWED_ALG) return { ok: false, reason: 'unsupported_alg' };
  if (typeof header.kid !== 'string' || !header.kid) return { ok: false, reason: 'malformed' };

  let key;
  try {
    key = await resolveKey(header.kid, fetchImpl, now);
  } catch (_) {
    // Network/JWKS problems are transient; surface as unavailable, not as a
    // signature failure.
    return { ok: false, reason: 'key_unavailable' };
  }
  if (!key) return { ok: false, reason: 'unknown_key' };

  // Verify the RSA-SHA256 signature over the exact `header.payload` bytes.
  let signature;
  try {
    signature = base64urlToBuffer(parts[2]);
  } catch (_) {
    return { ok: false, reason: 'malformed' };
  }
  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
  let verified = false;
  try {
    verified = crypto.verify('RSA-SHA256', signingInput, key.keyObject, signature);
  } catch (_) {
    verified = false;
  }
  if (!verified) return { ok: false, reason: 'bad_signature' };

  // Only after the signature checks out do we trust any claim.
  if (!VALID_ISSUERS.has(payload.iss)) return { ok: false, reason: 'wrong_issuer' };

  // `aud` may be a string or (rarely) an array; require our client ID to match.
  const audMatches = Array.isArray(payload.aud)
    ? payload.aud.includes(clientId)
    : payload.aud === clientId;
  if (!audMatches) return { ok: false, reason: 'wrong_audience' };

  const nowSec = Math.floor(now / 1000);
  if (typeof payload.exp !== 'number' || nowSec > payload.exp + CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'expired' };
  }
  // Reject tokens whose issue time is implausibly in the future (beyond skew):
  // a valid token is never issued for later than "now".
  if (typeof payload.iat !== 'number' || payload.iat - CLOCK_SKEW_SECONDS > nowSec) {
    return { ok: false, reason: 'bad_iat' };
  }
  if (typeof payload.sub !== 'string' || !payload.sub) return { ok: false, reason: 'malformed' };

  return {
    ok: true,
    claims: {
      sub: payload.sub,
      iss: payload.iss,
      aud: clientId,
      exp: payload.exp,
      iat: payload.iat,
      // Optional Google profile claims, surfaced only after full verification so
      // callers (e.g. /api/auth) can build an account object without decoding the
      // token a second time. Absent on non-OpenID tokens; that is fine.
      email: typeof payload.email === 'string' ? payload.email : undefined,
      email_verified: typeof payload.email_verified === 'boolean' ? payload.email_verified : undefined,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      picture: typeof payload.picture === 'string' ? payload.picture : undefined,
    },
  };
}

// Exposed for tests so they can start from a known-empty cache.
function _resetCacheForTests() {
  jwksCache = { keys: new Map(), expiresAt: 0 };
  lastFetchAt = 0;
}

module.exports = {
  verifyGoogleIdToken,
  GOOGLE_JWKS_URI,
  _resetCacheForTests,
};
