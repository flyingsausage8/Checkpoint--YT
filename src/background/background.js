/**
 * Background service worker.
 *
 * All calls to the Azure Function happen here, never in the content script.
 * A content script inherits the page's origin, so its requests are sent with
 * `Origin: https://www.youtube.com` and are subject to CORS. Requests made from
 * the service worker carry the extension's own `chrome-extension://<id>` origin
 * and bypass CORS because the host is declared in `host_permissions` — which is
 * also what lets the backend's origin allowlist mean something.
 */
import {
  signIn,
  signOut,
  removeAccount,
  switchAccount,
  getActiveAccount,
  listAccounts,
  getIdToken,
  invalidateActiveToken,
  hasClientId,
} from './auth.js';
import { initSync, pullActive } from './sync.js';

// Start watching for settings changes so a signed-in user's edits push to the
// server. Safe when signed out — it never fires a sync without an active account.
initSync();

const DEFAULT_PROXY_URL = 'https://func-checkpoint-yt-pb5kh8.azurewebsites.net/api/generate';
const TIMEOUT_MS = 45000;

function endpointFromBase(baseUrl) {
  const url = String(baseUrl || DEFAULT_PROXY_URL).trim().replace(/\/+$/, '');
  return url.endsWith('/generate') ? url : `${url}/api/generate`;
}

async function postToBackend(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const { proxyUrl } = await chrome.storage.sync.get({ proxyUrl: DEFAULT_PROXY_URL });
    const endpoint = endpointFromBase(proxyUrl);

    const headers = {
      'Content-Type': 'application/json',
      'X-Extension-Id': chrome.runtime.id,
    };

    // When someone is signed in, attach their Google ID token so the backend can
    // verify who they are and rate-limit per account. We ask silently only: a
    // background request must never pop a sign-in window. When signed out,
    // `idToken` is null and we send exactly what we always have (anonymous).
    const idToken = await getIdToken().catch(() => null);
    if (idToken) {
      headers.Authorization = `Bearer ${idToken}`;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (response.status === 401) {
      // The backend rejected our token. Treat it as dead: clear it so we stop
      // sending it, and tell the caller to prompt a fresh sign-in. Never retry.
      await invalidateActiveToken();
      return { ok: false, error: 'unauthorized', endpoint };
    }

    if (!response.ok) {
      return { ok: false, error: `http_${response.status}`, endpoint };
    }
    const body = await response.json();
    return { ok: true, body, endpoint };
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

async function requestQuestions({ videoId, title, chunks }) {
  const result = await postToBackend({ videoId, title, chunks });
  if (!result.ok) return { ok: false, error: result.error, endpoint: result.endpoint };
  return {
    ok: true,
    questions: result.body.questions,
    reason: result.body.reason,
    diagnostics: result.body.diagnostics,
    endpoint: result.endpoint,
  };
}

// Issue #1: segment mode asks the backend where the natural topic breaks are.
async function requestSegments(payload) {
  const result = await postToBackend({ ...payload, mode: 'segment' });
  if (!result.ok) return { ok: false, error: result.error, endpoint: result.endpoint };
  return {
    ok: true,
    sections: result.body.sections,
    reason: result.body.reason,
    diagnostics: result.body.diagnostics,
    endpoint: result.endpoint,
  };
}

// Issue #8: chapter mode asks which chapters are sponsor reads or channel
// branding rather than the video's actual material.
async function requestChapters(payload) {
  const result = await postToBackend({ ...payload, mode: 'chapters' });
  if (!result.ok) return { ok: false, error: result.error, endpoint: result.endpoint };
  return {
    ok: true,
    chapters: result.body.chapters,
    reason: result.body.reason,
    diagnostics: result.body.diagnostics,
    endpoint: result.endpoint,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'focusflow:generate-questions') {
    requestQuestions(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === 'focusflow:segment-video') {
    requestSegments(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === 'focusflow:classify-chapters') {
    requestChapters(message.payload || {})
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  // --- account / auth messages, all driven from the popup ------------------
  // The popup asks the service worker to run these because the interactive
  // sign-in window can outlive the popup (which closes when it loses focus).

  if (message?.type === 'focusflow:auth-state') {
    authState()
      .then((state) => sendResponse({ ok: true, ...state }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === 'focusflow:auth-sign-in') {
    signIn({ interactive: true })
      // Pull the account's settings from the server before we answer, so the
      // popup renders server-authoritative settings straight after sign-in.
      // pullActive never throws and never blocks the UI on failure.
      .then(async (account) => {
        await pullActive().catch(() => {});
        return account;
      })
      .then((account) => sendResponse({ ok: true, account }))
      .catch((error) =>
        sendResponse({ ok: false, error: error?.code || 'auth_flow_failed', message: String(error?.message || error) })
      );
    return true;
  }

  if (message?.type === 'focusflow:auth-sign-out') {
    signOut()
      .then(() => authState())
      .then((state) => sendResponse({ ok: true, ...state }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === 'focusflow:auth-switch') {
    switchAccount(message.sub)
      // Switching accounts is like signing in as that account: pull its
      // settings so the newly-active person sees their own, not the previous
      // account's, settings.
      .then(async () => {
        await pullActive().catch(() => {});
        return authState();
      })
      .then((state) => sendResponse({ ok: true, ...state }))
      .catch((error) =>
        sendResponse({ ok: false, error: error?.code || 'switch_failed', message: String(error?.message || error) })
      );
    return true;
  }

  if (message?.type === 'focusflow:auth-remove') {
    removeAccount(message.sub)
      .then(() => authState())
      .then((state) => sendResponse({ ok: true, ...state }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  return false;
});

// Bundle everything the popup needs to draw the account area in one round-trip.
async function authState() {
  const [active, accounts, clientIdSet] = await Promise.all([
    getActiveAccount(),
    listAccounts(),
    hasClientId(),
  ]);
  return { active, accounts, clientIdSet };
}
