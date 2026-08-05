/**
 * Sign in with Google for the FocusFlow service worker.
 *
 * We deliberately use Google Sign-In instead of usernames and passwords, so the
 * extension never stores or even sees a password. There is no password field
 * anywhere in this project, on purpose.
 *
 * We use the **Authorization Code flow with PKCE** via
 * `chrome.identity.launchWebAuthFlow`. Google's older implicit flow
 * (`response_type=id_token`) is deprecated and less safe — the token would land
 * in a URL fragment and in browser history — so we do not use it.
 *
 * How the flow works here:
 *   1. We generate a PKCE `code_verifier` and its `code_challenge` (SHA-256,
 *      base64url), plus a random `state`.
 *   2. We ask Google for an authorization `code` (not a token). Google sends it
 *      back in the redirect's *query string*, along with our `state`, which we
 *      verify so another site cannot inject a response.
 *   3. We do NOT exchange the code here. Exchanging it needs the client secret,
 *      and an extension is a public zip anyone can read — a secret shipped in it
 *      is not a secret. Instead we POST the code to our own backend, which holds
 *      the secret, verifies the ID token, and returns the identity to us.
 *
 * We trust the `account` object the backend returns for identity. We only decode
 * the JWT locally to read `exp` (when to refresh); the backend is the source of
 * truth for who the person is.
 *
 * Storage keys this module owns:
 *   chrome.storage.sync    googleClientId  -> the OAuth client ID (app-level)
 *   chrome.storage.local   accounts        -> { [sub]: accountEntry }
 *   chrome.storage.local   activeAccount   -> the active account's `sub`, or null
 *   chrome.storage.session authState       -> the `state` for the in-flight sign-in
 *
 * An accountEntry is:
 *   { sub, email, name, picture, idToken, expiresAt, lastUsedAt }
 * `sub` is Google's stable user id. We key everything on `sub`, never email,
 * because an account's email can change but its `sub` cannot.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const DEFAULT_PROXY_URL = 'https://func-checkpoint-yt-pb5kh8.azurewebsites.net/api/generate';

// FocusFlow's own OAuth client ID. A client ID is public by design — it appears
// in plain sight in every sign-in URL — so shipping it here is expected and safe.
// The matching client *secret* lives only as an Azure app setting on the backend
// and must never appear in this repo. Users who self-host can override this in
// Settings; everyone else should just be able to press "Sign in".
const DEFAULT_CLIENT_ID =
  '256515213402-godnfs0ruu0gnvrd5bgpeuf6ip3802i8.apps.googleusercontent.com';

// Refresh a token this long before it actually expires, so a request never goes
// out with a token that dies in-flight.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// small storage helpers (promise wrappers)
// ---------------------------------------------------------------------------

function localGet(defaults) {
  return chrome.storage.local.get(defaults);
}

function localSet(value) {
  return chrome.storage.local.set(value);
}

function syncGet(defaults) {
  return chrome.storage.sync.get(defaults);
}

// ---------------------------------------------------------------------------
// client id and backend endpoint
// ---------------------------------------------------------------------------

/**
 * The OAuth client ID to authenticate with. Normally this is FocusFlow's own
 * built-in client; someone running their own backend can override it in
 * Settings. It is only ever missing if a self-hoster blanks it deliberately.
 */
async function getClientId() {
  const { googleClientId } = await syncGet({ googleClientId: '' });
  const clientId = String(googleClientId || '').trim() || DEFAULT_CLIENT_ID;
  if (!clientId) {
    const error = new Error('No Google client ID is set yet — add one in Settings.');
    error.code = 'no_client_id';
    throw error;
  }
  return clientId;
}

async function hasClientId() {
  const { googleClientId } = await syncGet({ googleClientId: '' });
  return Boolean(String(googleClientId || '').trim() || DEFAULT_CLIENT_ID);
}

/**
 * The backend base URL, derived from the same proxy URL used for /api/generate,
 * so the owner only configures one host. We strip a trailing /api/generate (or
 * /generate) and append /api/auth — the code-exchange endpoint.
 */
function backendBase(proxyUrl) {
  return String(proxyUrl || DEFAULT_PROXY_URL)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/generate$/, '')
    .replace(/\/generate$/, '');
}

async function getAuthEndpoint() {
  const { proxyUrl } = await syncGet({ proxyUrl: DEFAULT_PROXY_URL });
  return `${backendBase(proxyUrl)}/api/auth`;
}

/**
 * The settings-sync endpoint, derived from the same proxy URL as everything
 * else so the owner only ever configures one host. We reuse backendBase() on
 * purpose — the host must never be hard-coded in two places that could drift.
 */
async function getSyncEndpoint() {
  const { proxyUrl } = await syncGet({ proxyUrl: DEFAULT_PROXY_URL });
  return `${backendBase(proxyUrl)}/api/sync`;
}

// ---------------------------------------------------------------------------
// base64url + JWT (decode only, and only for `exp`; identity comes from backend)
// ---------------------------------------------------------------------------

/** base64url-encode raw bytes: standard base64 with +/ -> -_ and no padding. */
function base64UrlFromBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode a base64url string to text. JWTs use the URL-safe alphabet (`-` and
 * `_`) and drop the `=` padding, so we put both back before `atob`, then run the
 * bytes through TextDecoder so non-ASCII survives.
 */
function base64UrlDecode(input) {
  const normalized = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Read the `exp` claim (seconds since epoch) from a JWT, or 0 if unreadable. */
function readTokenExp(idToken) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) return 0;
  try {
    const claims = JSON.parse(base64UrlDecode(parts[1]));
    return Number(claims.exp || 0);
  } catch (_) {
    return 0;
  }
}

/**
 * Normalise the expiry the backend sent into epoch milliseconds. The contract
 * shows seconds (a 10-digit value), but we accept milliseconds too, and fall
 * back to the token's own `exp` if the field is missing.
 */
function normalizeExpiry(expiresAt, idToken) {
  let value = Number(expiresAt) || 0;
  if (value > 0 && value < 1e12) value *= 1000; // seconds -> ms
  if (!value && idToken) {
    const exp = readTokenExp(idToken);
    if (exp) value = exp * 1000;
  }
  return value;
}

// ---------------------------------------------------------------------------
// account storage
// ---------------------------------------------------------------------------

async function getAccountsMap() {
  const { accounts } = await localGet({ accounts: {} });
  return accounts && typeof accounts === 'object' ? accounts : {};
}

/**
 * Strip the raw ID token before anything leaves this module for the popup. The
 * popup must never render the token, so it never receives it.
 */
function toPublicAccount(entry) {
  if (!entry) return null;
  return {
    sub: entry.sub,
    email: entry.email || '',
    name: entry.name || '',
    picture: entry.picture || '',
    expiresAt: entry.expiresAt || 0,
    lastUsedAt: entry.lastUsedAt || 0,
    // True when we currently hold a usable token; the popup uses this to show a
    // "session expired, sign in again" hint without ever seeing the token.
    hasValidToken: Boolean(entry.idToken) && (entry.expiresAt || 0) > Date.now(),
  };
}

async function upsertAccount(entry) {
  const accounts = await getAccountsMap();
  const existing = accounts[entry.sub] || {};
  accounts[entry.sub] = { ...existing, ...entry };
  await localSet({ accounts });
  return accounts[entry.sub];
}

// ---------------------------------------------------------------------------
// PKCE + state
// ---------------------------------------------------------------------------

/**
 * A PKCE `code_verifier`: 32 random bytes base64url-encoded gives 43 characters
 * from the unreserved set, which is within the 43–128 range the spec requires.
 */
function randomVerifier() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlFromBytes(bytes);
}

/** code_challenge = BASE64URL(SHA256(code_verifier)). */
async function pkceChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlFromBytes(new Uint8Array(digest));
}

/**
 * A random `state`. Google echoes it back in the redirect; if what comes back is
 * not what we sent, another site tried to inject an authorization response and
 * we reject it.
 */
function randomState() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlFromBytes(bytes);
}

// ---------------------------------------------------------------------------
// the OAuth flow
// ---------------------------------------------------------------------------

function buildAuthUrl({ clientId, redirectUri, codeChallenge, state, prompt }) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'openid email profile',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    prompt,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

function launchWebAuthFlow(url, interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive }, (redirectUrl) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message || 'auth_flow_failed'));
        return;
      }
      if (!redirectUrl) {
        reject(new Error('auth_no_redirect'));
        return;
      }
      resolve(redirectUrl);
    });
  });
}

/**
 * The authorization code flow returns `code` and `state` in the redirect's
 * *query string* (not the fragment), so we read `url.searchParams`.
 */
function extractCode(redirectUrl) {
  const url = new URL(redirectUrl);
  const params = url.searchParams;
  const returnedError = params.get('error');
  if (returnedError) {
    const error = new Error(`Google returned an error: ${returnedError}`);
    error.code = 'oauth_error';
    throw error;
  }
  const code = params.get('code');
  if (!code) {
    const error = new Error('Google did not return an authorization code.');
    error.code = 'no_code';
    throw error;
  }
  return { code, returnedState: params.get('state') };
}

/**
 * Turn the raw rejection from `launchWebAuthFlow` into a stable code. When the
 * person closes the Google window, Chrome rejects with a "did not approve" style
 * message; we treat that as an ordinary cancellation, not a crash.
 */
function normalizeFlowError(error, interactive) {
  const message = String(error?.message || error || '').toLowerCase();
  if (
    message.includes('did not approve') ||
    message.includes('cancel') ||
    message.includes('closed')
  ) {
    const cancelled = new Error('Sign-in was cancelled.');
    cancelled.code = 'user_cancelled';
    return cancelled;
  }
  if (!interactive) {
    const silent = new Error('Silent sign-in was not possible.');
    silent.code = 'silent_failed';
    return silent;
  }
  const generic = new Error('Sign-in could not be completed.');
  generic.code = 'auth_flow_failed';
  return generic;
}

/**
 * Hand the authorization code to our backend, which exchanges it (it holds the
 * client secret), verifies the resulting ID token, and returns the identity.
 * We send the X-Extension-Id header the backend's origin check expects.
 */
async function exchangeCode({ code, codeVerifier, redirectUri }) {
  const endpoint = await getAuthEndpoint();
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Extension-Id': chrome.runtime.id,
      },
      body: JSON.stringify({ code, codeVerifier, redirectUri }),
    });
  } catch (_) {
    const error = new Error('Could not reach the sign-in server.');
    error.code = 'network';
    throw error;
  }

  if (!response.ok) {
    let payload = {};
    try {
      payload = await response.json();
    } catch (_) {
      payload = {};
    }
    const error = new Error(payload.message || 'Sign-in could not be completed.');
    error.code = payload.error || `http_${response.status}`;
    throw error;
  }

  return response.json(); // { idToken, expiresAt, account }
}

/**
 * Run the whole sign-in. With `interactive: false` we ask Google for
 * `prompt=none`, which silently returns a code when the person still has a live
 * Google session and shows nothing otherwise. With `interactive: true` we ask
 * for `prompt=select_account` so switching accounts actually offers a choice.
 *
 * We do not request `access_type=offline`: we deliberately do not want refresh
 * tokens in the extension. An expired token means re-running this flow.
 */
async function signIn({ interactive = true } = {}) {
  const clientId = await getClientId();
  const redirectUri = chrome.identity.getRedirectURL();

  const codeVerifier = randomVerifier();
  const codeChallenge = await pkceChallenge(codeVerifier);
  const state = randomState();
  // Store state so we can check it against the redirect, even if the service
  // worker is torn down and restarted mid-flow.
  await chrome.storage.session.set({ authState: state });

  const url = buildAuthUrl({
    clientId,
    redirectUri,
    codeChallenge,
    state,
    prompt: interactive ? 'select_account' : 'none',
  });

  let redirectUrl;
  try {
    redirectUrl = await launchWebAuthFlow(url, interactive);
  } catch (error) {
    throw normalizeFlowError(error, interactive);
  }

  const { code, returnedState } = extractCode(redirectUrl);

  const { authState: expectedState } = await chrome.storage.session.get({ authState: '' });
  await chrome.storage.session.remove('authState');
  if (!returnedState || returnedState !== expectedState) {
    const error = new Error('The sign-in response did not match this device.');
    error.code = 'state_mismatch';
    throw error;
  }

  const result = await exchangeCode({ code, codeVerifier, redirectUri });
  const account = result.account || {};
  if (!account.sub) {
    const error = new Error('The sign-in server did not return an account id.');
    error.code = 'missing_sub';
    throw error;
  }

  const entry = {
    sub: String(account.sub),
    email: account.email || '',
    name: account.name || '',
    picture: account.picture || '',
    idToken: result.idToken || '',
    expiresAt: normalizeExpiry(result.expiresAt, result.idToken),
    lastUsedAt: Date.now(),
  };
  await upsertAccount(entry);
  await localSet({ activeAccount: entry.sub });
  return toPublicAccount(entry);
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/** The active account as a token-free object, or null when signed out. */
async function getActiveAccount() {
  const { activeAccount } = await localGet({ activeAccount: null });
  if (!activeAccount) return null;
  const accounts = await getAccountsMap();
  return toPublicAccount(accounts[activeAccount]) || null;
}

/** Every account known on this device, token-free, most-recently-used first. */
async function listAccounts() {
  const accounts = await getAccountsMap();
  return Object.values(accounts)
    .map(toPublicAccount)
    .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
}

/**
 * Make a known account active. Does not require re-authentication — the stored
 * token is reused, and refreshed on demand by getIdToken(). Bumps lastUsedAt so
 * the account sorts to the top.
 */
async function switchAccount(sub) {
  const accounts = await getAccountsMap();
  const entry = accounts[sub];
  if (!entry) {
    const error = new Error('That account is not known on this device.');
    error.code = 'unknown_account';
    throw error;
  }
  entry.lastUsedAt = Date.now();
  await localSet({ accounts, activeAccount: sub });
  return toPublicAccount(entry);
}

/**
 * Sign out of the active account. This removes the token but KEEPS the account
 * entry and its per-account data, so signing back in restores the person's
 * settings and progress. To actually erase an account, use removeAccount().
 */
async function signOut() {
  const { activeAccount } = await localGet({ activeAccount: null });
  if (activeAccount) {
    const accounts = await getAccountsMap();
    const entry = accounts[activeAccount];
    if (entry) {
      entry.idToken = '';
      entry.expiresAt = 0;
      await localSet({ accounts });
    }
  }
  await localSet({ activeAccount: null });
  return null;
}

/**
 * Fully remove an account: its entry and its namespaced settings. This is the
 * destructive action, kept separate from signOut() on purpose.
 */
async function removeAccount(sub) {
  const accounts = await getAccountsMap();
  delete accounts[sub];
  await localSet({ accounts });

  // Drop this account's per-account settings from sync storage.
  await chrome.storage.sync.remove(`account:${sub}:settings`);

  const { activeAccount } = await localGet({ activeAccount: null });
  if (activeAccount === sub) {
    await localSet({ activeAccount: null });
  }
  return null;
}

/**
 * Mark the active account's token as dead. Called when the backend rejects a
 * token with 401: we clear the token (so we stop sending it) but keep the
 * account signed in, so the popup can prompt the person to sign in again.
 */
async function invalidateActiveToken() {
  const { activeAccount } = await localGet({ activeAccount: null });
  if (!activeAccount) return;
  const accounts = await getAccountsMap();
  const entry = accounts[activeAccount];
  if (entry) {
    entry.idToken = '';
    entry.expiresAt = 0;
    await localSet({ accounts });
  }
}

/**
 * Return a currently-valid ID token, or null.
 *
 * We do not hold refresh tokens on purpose, so refreshing means re-running the
 * flow. If the stored token is expired or expires within ~5 minutes, we try a
 * silent re-run first (interactive: false) so a signed-in person is not
 * interrupted. A failed silent attempt must not throw — it just means we could
 * not refresh quietly. Interactive fallback is opt-in via `{ interactive: true }`
 * so a background request can never surprise the person with a popup window; the
 * UI turns it on when the person actively clicks sign-in.
 */
async function getIdToken({ interactive = false } = {}) {
  const { activeAccount } = await localGet({ activeAccount: null });
  if (!activeAccount) return null;

  let accounts = await getAccountsMap();
  const entry = accounts[activeAccount];
  if (entry && entry.idToken && entry.expiresAt - Date.now() > EXPIRY_SKEW_MS) {
    return entry.idToken;
  }

  // Token missing or about to expire: try a silent refresh first.
  try {
    await signIn({ interactive: false });
  } catch (silentError) {
    if (!interactive) return null;
    try {
      await signIn({ interactive: true });
    } catch (_) {
      return null;
    }
  }

  accounts = await getAccountsMap();
  const refreshed = accounts[activeAccount];
  return refreshed && refreshed.idToken ? refreshed.idToken : null;
}

export {
  signIn,
  signOut,
  removeAccount,
  switchAccount,
  getActiveAccount,
  listAccounts,
  getIdToken,
  invalidateActiveToken,
  hasClientId,
  getSyncEndpoint,
};
