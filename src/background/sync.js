/**
 * Settings sync for signed-in users.
 *
 * Why this file exists at all:
 *   The extension keeps settings in chrome.storage.sync. That name is
 *   misleading — Chrome's "sync" storage follows a *Chrome profile* signed into
 *   a Google-Chrome account, NOT a FocusFlow account. So it does not give the
 *   owner what they actually asked for: "I can get my data on another device /
 *   another Chrome profile." Only our own backend can do that. This module
 *   pulls and pushes the six syncable settings through POST /api/sync so a
 *   FocusFlow account carries its settings anywhere it signs in.
 *
 * What it deliberately does NOT do:
 *   - It touches nothing when nobody is signed in. A signed-out user is an
 *     accessibility user who must never notice this feature exists, and must
 *     never trigger a network call for sync.
 *   - It never blocks or breaks the UI. Settings always save locally first
 *     (the popup/content own that); the network is background best-effort.
 *
 * Only these six settings sync. proxyUrl and googleClientId are intentionally
 * excluded: proxyUrl is the URL transcripts get POSTed to, so accepting it from
 * the network would let anyone able to write a user's server row silently
 * redirect that user's transcript data to a server they control. Endpoint
 * configuration must stay local, per device.
 */
import {
  getIdToken,
  invalidateActiveToken,
  getActiveAccount,
  getSyncEndpoint,
} from './auth.js';

const SYNC_KEYS = [
  'enabled',
  'chunkMinutes',
  'sectionMinMinutes',
  'sectionMaxMinutes',
  'minVideoMinutes',
  'autoPause',
  'useAI',
  'aiCheckpoints',
  'focusMode',
  'focusParts',
];

// Kept in step with FOCUS_MODES / FOCUS_PARTS in src/shared/settings.js. The
// service worker is a module and content scripts are not, so it cannot import
// that file; an unknown value here is coerced to a safe default rather than
// trusted, which is what matters — this data arrives from a server.
const FOCUS_MODES = ['off', 'standard', 'complete', 'custom'];
const FOCUS_PART_IDS = ['homeFeed', 'related', 'comments', 'shorts', 'endScreen', 'liveChat', 'guide'];

// Debounce pushes so dragging a slider fires one request, not one per pixel.
const DEBOUNCE_MS = 2500;

// A backup alarm so a push still happens if the service worker is torn down
// (MV3 kills it after ~30s idle) before the in-memory debounce timer fires.
// Alarms and storage are the only things that survive a worker death.
const FLUSH_ALARM = 'focusflow:sync-flush';

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * Reduce any settings object to exactly the syncable fields, coerced the same
 * way content.js coerces them. Producing a stable key order here is what lets
 * us JSON.stringify two settings objects and compare them for equality.
 */
function pickSyncable(settings) {
  const s = settings || {};
  return {
    enabled: s.enabled !== false,
    chunkMinutes: clampNumber(s.chunkMinutes, 1, 20, 3),
    minVideoMinutes: Math.max(
      0,
      Number.isFinite(Number(s.minVideoMinutes)) ? Number(s.minVideoMinutes) : 4
    ),
    autoPause: s.autoPause !== false,
    useAI: s.useAI !== false,
    aiCheckpoints: s.aiCheckpoints !== false,
    focusMode: FOCUS_MODES.includes(s.focusMode) ? s.focusMode : 'standard',
    focusParts: cleanFocusParts(s.focusParts),
  };
}

// Sorted and filtered so the same set of parts always produces the same string:
// pickSyncable's output is compared with JSON.stringify to decide whether
// anything actually changed, and 'a,b' vs 'b,a' would look like a change and
// cause an endless push loop between two devices.
function cleanFocusParts(value) {
  if (typeof value !== 'string') return '';
  const chosen = new Set(
    value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => FOCUS_PART_IDS.includes(part))
  );
  return FOCUS_PART_IDS.filter((part) => chosen.has(part)).join(',');
}

function settingsKey(sub) {
  return `account:${sub}:settings`;
}

function stateKey(sub) {
  return `sync:${sub}`;
}

// ---------------------------------------------------------------------------
// per-account sync state (kept in chrome.storage.local so it survives a
// service-worker death; the popup reads it to show "Synced" vs "on this
// device only")
// ---------------------------------------------------------------------------

async function getSyncState(sub) {
  const key = stateKey(sub);
  const got = await chrome.storage.local.get({ [key]: null });
  return (
    got[key] || {
      status: 'unknown', // unknown | synced | pending | error | unauthorized
      updatedAt: 0,
      syncedSettings: '', // JSON of the settings we believe the server holds
      lastError: '',
      lastSyncedAt: 0,
      dirty: false,
    }
  );
}

async function setSyncState(sub, patch) {
  const key = stateKey(sub);
  const next = { ...(await getSyncState(sub)), ...patch };
  await chrome.storage.local.set({ [key]: next });
  return next;
}

// ---------------------------------------------------------------------------
// reading / writing the account's settings in sync storage
// ---------------------------------------------------------------------------

/**
 * The current settings for an account. On a brand-new sign-in the namespaced
 * key does not exist yet, so we fall back to the anonymous top-level settings
 * as a sensible starting point — the same fallback popup.js and content.js use.
 */
async function readAccountSettings(sub) {
  const key = settingsKey(sub);
  const got = await chrome.storage.sync.get({ [key]: null });
  if (got[key]) return got[key];
  return chrome.storage.sync.get({
    enabled: true,
    chunkMinutes: 3,
    minVideoMinutes: 4,
    autoPause: true,
    useAI: true,
    aiCheckpoints: true,
    focusMode: 'standard',
    focusParts: 'homeFeed,related,comments,shorts',
  });
}

/**
 * Apply server-authoritative settings to local storage. We MERGE onto whatever
 * is already stored so device-local fields the server never sees — proxyUrl and
 * googleClientId — are preserved. Overwriting them here is exactly the redirect
 * risk this module refuses to take.
 */
async function applyServerSettings(sub, syncable) {
  const key = settingsKey(sub);
  const existing =
    (await chrome.storage.sync.get({ [key]: null }))[key] ||
    (await readAccountSettings(sub));
  const merged = { ...existing, ...pickSyncable(syncable) };
  await chrome.storage.sync.set({ [key]: merged });
}

/**
 * Record that we and the server now agree, and (optionally) write the agreed
 * settings to local storage. We set the sync state BEFORE writing settings on
 * purpose: writing settings fires chrome.storage.onChanged, and our own
 * listener compares the new settings against syncedSettings to decide whether a
 * change was user-made. Setting syncedSettings first makes that comparison
 * match, so applying a server pull never bounces straight back as a push.
 */
async function markSynced(sub, syncable, updatedAt, { applyToStorage } = {}) {
  const picked = pickSyncable(syncable);
  await setSyncState(sub, {
    status: 'synced',
    updatedAt: updatedAt || Date.now(),
    syncedSettings: JSON.stringify(picked),
    lastError: '',
    lastSyncedAt: Date.now(),
    dirty: false,
  });
  if (applyToStorage) await applyServerSettings(sub, picked);
}

// ---------------------------------------------------------------------------
// the network call
// ---------------------------------------------------------------------------

// Injectable so unit tests can stub the network and the token accessor without
// a real Google session or a deployed backend. Production uses the real ones.
let fetchImpl = (...args) => fetch(...args);
let getIdTokenImpl = getIdToken;

function _setTestHooks({ fetch: f, getIdToken: g } = {}) {
  if (f) fetchImpl = f;
  if (g) getIdTokenImpl = g;
}

/**
 * POST one request to /api/sync with the signed-in user's ID token attached.
 * Returns { ok, data } on success or { ok:false, error } on any failure. It
 * never throws — sync is best-effort and must never break the caller.
 */
async function postSync(body) {
  // We ask for the token silently only (interactive:false, the default): a
  // background sync must never surprise the user with a sign-in window. No
  // token means we simply cannot sync; that is not an error worth retrying.
  const idToken = await Promise.resolve(getIdTokenImpl()).catch(() => null);
  if (!idToken) return { ok: false, error: 'unauthorized' };

  const endpoint = await getSyncEndpoint();
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Extension-Id': chrome.runtime.id,
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch (_) {
    return { ok: false, error: 'network' };
  }

  if (response.status === 401) {
    // The token has expired or been revoked. Mark it dead so we stop sending
    // it, and let the popup prompt a fresh sign-in. Never retry a 401 in a loop
    // — it is useless and burns the owner's Azure budget.
    await invalidateActiveToken();
    return { ok: false, error: 'unauthorized' };
  }

  if (!response.ok) {
    let payload = {};
    try {
      payload = await response.json();
    } catch (_) {
      payload = {};
    }
    return { ok: false, error: payload.error || `http_${response.status}` };
  }

  let data = {};
  try {
    data = await response.json();
  } catch (_) {
    data = {};
  }
  return { ok: true, data };
}

async function recordFailure(sub, error) {
  await setSyncState(sub, {
    status: error === 'unauthorized' ? 'unauthorized' : 'error',
    lastError: error,
    dirty: true, // still unsynced — a later attempt should try again
  });
}

// ---------------------------------------------------------------------------
// pull (on sign-in / account switch) and push (on settings change)
// ---------------------------------------------------------------------------

/**
 * Pull the server's settings and reconcile.
 *
 * Merge order — this is the important part. We PULL FIRST and only push the
 * local settings up when the server has nothing yet. If we pushed first, a
 * fresh device signing in with default settings would overwrite the real
 * settings already sitting on the server and wipe them. Pull-first means the
 * server (the source of truth for an existing account) always wins on a new
 * device, and a genuinely new account gets seeded from whatever is local.
 */
async function pull(sub) {
  const res = await postSync({ op: 'get' });
  if (!res.ok) {
    await recordFailure(sub, res.error);
    return res;
  }

  const { settings, updatedAt } = res.data || {};
  if (settings && typeof settings === 'object') {
    // Server has settings for this account -> authoritative. Apply locally.
    await markSynced(sub, settings, updatedAt || Date.now(), {
      applyToStorage: true,
    });
    return res;
  }

  // Server has nothing yet -> seed it from the local settings so the account
  // starts populated instead of empty.
  const local = pickSyncable(await readAccountSettings(sub));
  const stamp = Date.now();
  const put = await postSync({ op: 'put', settings: local, updatedAt: stamp });
  if (!put.ok) {
    await recordFailure(sub, put.error);
    return put;
  }
  const d = put.data || {};
  const serverSettings = d.settings ? pickSyncable(d.settings) : null;
  // A concurrent writer could already have won even here — accept whatever the
  // server returns as authoritative.
  if (serverSettings && JSON.stringify(serverSettings) !== JSON.stringify(local)) {
    await markSynced(sub, serverSettings, d.updatedAt || stamp, {
      applyToStorage: true,
    });
  } else {
    await markSynced(sub, local, d.updatedAt || stamp, { applyToStorage: false });
  }
  return put;
}

/** Push the current local settings up, honouring last-write-wins. */
async function flush(sub) {
  const state = await getSyncState(sub);
  if (!state.dirty) return { ok: true, skipped: true };

  const settings = pickSyncable(await readAccountSettings(sub));
  const updatedAt = state.updatedAt || Date.now();
  const res = await postSync({ op: 'put', settings, updatedAt });
  if (!res.ok) {
    await recordFailure(sub, res.error);
    return res;
  }

  const d = res.data || {};
  const serverSettings = d.settings ? pickSyncable(d.settings) : null;
  // Conflict rule: if our put was stale, the server refuses and returns its own
  // settings + updatedAt. We accept that as authoritative rather than fighting
  // it — last-write-wins on updatedAt, and the server holds the newer write.
  if (
    serverSettings &&
    JSON.stringify(serverSettings) !== JSON.stringify(settings)
  ) {
    await markSynced(sub, serverSettings, d.updatedAt || updatedAt, {
      applyToStorage: true,
    });
  } else {
    await markSynced(sub, settings, d.updatedAt || updatedAt, {
      applyToStorage: false,
    });
  }
  return res;
}

// ---------------------------------------------------------------------------
// debounced scheduling
// ---------------------------------------------------------------------------

const flushTimers = new Map();

function scheduleFlush(sub) {
  clearTimeout(flushTimers.get(sub));
  flushTimers.set(
    sub,
    setTimeout(() => {
      flushTimers.delete(sub);
      flush(sub).catch(() => {});
    }, DEBOUNCE_MS)
  );
  // Backup: if the worker dies before the timer above fires, this alarm will
  // still flush the pending change on the next wake.
  try {
    chrome.alarms.create(FLUSH_ALARM, { delayInMinutes: 0.5 });
  } catch (_) {
    /* alarms may be unavailable in a stubbed test env */
  }
}

/**
 * A settings change was observed for the active account. Stamp updatedAt at the
 * moment of the change, mark the account dirty, and schedule a push. If the new
 * settings equal what we last synced, this was our own server-apply echoing
 * back (or a no-op) and we do nothing — that is what stops a pull/push loop.
 */
async function onSettingsChanged(sub) {
  const current = pickSyncable(await readAccountSettings(sub));
  const state = await getSyncState(sub);
  if (state.syncedSettings && JSON.stringify(current) === state.syncedSettings) {
    return;
  }
  await setSyncState(sub, {
    status: 'pending',
    updatedAt: Date.now(),
    dirty: true,
  });
  scheduleFlush(sub);
}

// ---------------------------------------------------------------------------
// public entry points, wired from background.js
// ---------------------------------------------------------------------------

/**
 * Pull the active account's settings from the server. Called after a successful
 * sign-in and after switching accounts. Safe to call when signed out — it does
 * nothing and makes no network call.
 */
async function pullActive() {
  const active = await getActiveAccount();
  if (!active) return;
  await pull(active.sub);
}

async function flushActiveIfDirty() {
  const active = await getActiveAccount();
  if (!active) return;
  const state = await getSyncState(active.sub);
  if (state.dirty) await flush(active.sub);
}

/**
 * Install the listeners that drive push-on-change. Called once when the service
 * worker starts. Guards on there being an active account so a signed-out user
 * never triggers a sync.
 */
function initSync() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const touchedAccountSettings = Object.keys(changes).some((k) =>
      /^account:.+:settings$/.test(k)
    );
    if (!touchedAccountSettings) return;
    getActiveAccount()
      .then((active) => {
        if (!active) return;
        if (changes[settingsKey(active.sub)]) onSettingsChanged(active.sub);
      })
      .catch(() => {});
  });

  if (chrome.alarms?.onAlarm) {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === FLUSH_ALARM) flushActiveIfDirty().catch(() => {});
    });
  }

  // Recover a push that a worker death may have interrupted mid-debounce.
  flushActiveIfDirty().catch(() => {});
}

export {
  initSync,
  pullActive,
  flushActiveIfDirty,
  // exported for unit tests only:
  pull,
  flush,
  onSettingsChanged,
  getSyncState,
  pickSyncable,
  _setTestHooks,
};
