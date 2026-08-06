const { formatTime } = window.FocusFlowFormat;
const DEFAULT_PROXY_URL = 'https://func-checkpoint-yt-pb5kh8.azurewebsites.net/api/generate';

const DEFAULT_SETTINGS = {
  enabled: true,
  chunkMinutes: 3,
  minVideoMinutes: 4,
  autoPause: true,
  useAI: true,
  aiCheckpoints: true,
  proxyUrl: DEFAULT_PROXY_URL,
  // Focus mode has no controls in the popup — it lives in the on-page panel,
  // where you can see what it hides. It is listed here so the popup loads and
  // writes it back untouched instead of dropping it.
  focusMode: 'standard',
  focusParts: 'homeFeed,related,comments,shorts',
};

// The last settings we loaded or saved, used so the popup preserves keys it has
// no form controls for. See readForm().
let lastLoaded = { ...DEFAULT_SETTINGS };

const elements = {
  enabled: document.querySelector('#enabled'),
  chunkRange: document.querySelector('#chunkRange'),
  chunkMinutes: document.querySelector('#chunkMinutes'),
  chunkValue: document.querySelector('#chunkValue'),
  minVideoMinutes: document.querySelector('#minVideoMinutes'),
  autoPause: document.querySelector('#autoPause'),
  useAI: document.querySelector('#useAI'),
  aiCheckpoints: document.querySelector('#aiCheckpoints'),
  proxyUrl: document.querySelector('#proxyUrl'),
  testCheckpoint: document.querySelector('#testCheckpoint'),
  viewTranscript: document.querySelector('#viewTranscript'),
  showPosition: document.querySelector('#showPosition'),
  testStatus: document.querySelector('#testStatus'),
  progressReadout: document.querySelector('#progressReadout'),
  progressTrack: document.querySelector('#progressTrack'),
  progressFill: document.querySelector('#progressFill'),
  progressLine: document.querySelector('#progressLine'),
  playState: document.querySelector('#playState'),
  videoStatus: document.querySelector('#videoStatus'),
  saveStatus: document.querySelector('#saveStatus'),
  googleClientId: document.querySelector('#googleClientId'),
  // account area
  accountSignedOut: document.querySelector('#accountSignedOut'),
  accountSignedIn: document.querySelector('#accountSignedIn'),
  accountAvatar: document.querySelector('#accountAvatar'),
  accountName: document.querySelector('#accountName'),
  accountEmail: document.querySelector('#accountEmail'),
  sessionExpired: document.querySelector('#sessionExpired'),
  switchRow: document.querySelector('#switchRow'),
  switchAccount: document.querySelector('#switchAccount'),
  signInBtn: document.querySelector('#signInBtn'),
  signOutBtn: document.querySelector('#signOutBtn'),
  removeAccountBtn: document.querySelector('#removeAccountBtn'),
  accountError: document.querySelector('#accountError'),
  syncStatus: document.querySelector('#syncStatus'),
};

let saveTimer = null;
let testTimer = null;
const progressTimer = setInterval(refreshProgress, 500);

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function setEnabled(enabled) {
  elements.enabled.setAttribute('aria-pressed', String(enabled));
  elements.enabled.textContent = enabled ? 'On' : 'Off';
}

function readForm() {
  return {
    // Spread the settings we loaded first: when signed in, saving replaces the
    // whole account settings object, so any key this form doesn't know about —
    // focus mode, or anything a newer version adds — would otherwise be wiped
    // the first time someone touched a slider in the popup.
    ...lastLoaded,
    enabled: elements.enabled.getAttribute('aria-pressed') === 'true',
    chunkMinutes: clamp(elements.chunkMinutes.value, 1, 20, DEFAULT_SETTINGS.chunkMinutes),
    minVideoMinutes: Math.max(0, Number(elements.minVideoMinutes.value) || 0),
    autoPause: elements.autoPause.checked,
    useAI: elements.useAI.checked,
    aiCheckpoints: elements.aiCheckpoints.checked,
    proxyUrl: elements.proxyUrl.value.trim() || DEFAULT_PROXY_URL,
  };
}

function render(settings) {
  lastLoaded = { ...lastLoaded, ...settings };
  const chunkMinutes = clamp(settings.chunkMinutes, 1, 20, DEFAULT_SETTINGS.chunkMinutes);
  setEnabled(settings.enabled !== false);
  elements.chunkRange.value = String(chunkMinutes);
  elements.chunkMinutes.value = String(chunkMinutes);
  elements.chunkValue.textContent = String(chunkMinutes);
  elements.minVideoMinutes.value = String(
    Math.max(0, Number(settings.minVideoMinutes) || DEFAULT_SETTINGS.minVideoMinutes)
  );
  elements.autoPause.checked = settings.autoPause !== false;
  elements.useAI.checked = settings.useAI === true;
  elements.aiCheckpoints.checked = settings.aiCheckpoints !== false;
  elements.proxyUrl.value = settings.proxyUrl || DEFAULT_PROXY_URL;
}

function showSaved() {
  elements.saveStatus.textContent = 'Saved';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    elements.saveStatus.textContent = '';
  }, 1200);
}

function showTestStatus(message) {
  elements.testStatus.textContent = message;
  clearTimeout(testTimer);
  testTimer = setTimeout(() => {
    elements.testStatus.textContent = '';
  }, 1800);
}

function save() {
  const settings = readForm();
  render(settings);
  persistSettings(settings).then(showSaved);
}

// --- account-aware settings storage ---------------------------------------
// Signed out, settings live in the original top-level sync keys. Signed in,
// they live under `account:<sub>:settings` so two people on one device don't
// share settings. `sub` is Google's stable id — we never key on email.

async function activeAccountSub() {
  const { activeAccount } = await chrome.storage.local.get({ activeAccount: null });
  return activeAccount;
}

async function loadSettings() {
  const sub = await activeAccountSub();
  if (sub) {
    const key = `account:${sub}:settings`;
    const stored = await chrome.storage.sync.get({ [key]: null });
    // First sign-in has no saved settings, so start from the anonymous ones.
    return stored[key] || (await chrome.storage.sync.get(DEFAULT_SETTINGS));
  }
  return chrome.storage.sync.get(DEFAULT_SETTINGS);
}

async function persistSettings(settings) {
  const sub = await activeAccountSub();
  if (sub) {
    await chrome.storage.sync.set({ [`account:${sub}:settings`]: settings });
  } else {
    await chrome.storage.sync.set(settings);
  }
}

function setStatusRows(rows) {
  elements.videoStatus.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const left = document.createElement('span');
      left.textContent = label;
      const right = document.createElement('strong');
      right.textContent = value;
      return [left, right];
    })
  );
}

function renderStatus(status) {
  if (!status) {
    setStatusRows([['Status', 'Open a YouTube watch page']]);
    return;
  }
  setStatusRows([
    ['Ready', status.ready ? 'yes' : 'no'],
    ['Video ID', status.videoId || 'none'],
    ['Length', formatTime(status.durationSeconds)],
    ['Checkpoints', String(status.checkpointCount ?? 0)],
    ['Captions', status.captionsSource || 'unknown'],
    ['Cues', String(status.transcriptCueCount ?? 0)],
    ['Questions', status.questionSource || 'offline'],
    ['Why', status.aiReason && status.aiReason !== 'ok' ? status.aiReason : 'AI questions active'],
    ['Note', status.reason || 'OK'],
  ]);
}

function refreshStatus() {
  chrome.storage.local.get({ lastStatus: null }, ({ lastStatus }) => renderStatus(lastStatus));
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function isWatchTab(tab) {
  return Boolean(tab?.id && /^https:\/\/www\.youtube\.com\/watch\b/.test(tab.url || ''));
}

async function messageActiveYouTube(message) {
  const tab = await activeTab();
  if (!isWatchTab(tab)) throw new Error('not_youtube');
  return chrome.tabs.sendMessage(tab.id, message);
}

async function testCheckpoint() {
  try {
    const response = await messageActiveYouTube({ type: 'focusflow:test-checkpoint' });
    showTestStatus(response?.ok ? 'Checkpoint opened.' : 'FocusFlow is not ready yet.');
    setTimeout(refreshStatus, 300);
  } catch (_) {
    showTestStatus('Open or reload a YouTube watch page first.');
  }
}

async function openTranscript() {
  try {
    const tab = await activeTab();
    if (!isWatchTab(tab)) {
      showTestStatus('Open a YouTube watch page first.');
      return;
    }
    const url = chrome.runtime.getURL(`src/transcript/transcript.html?tabId=${tab.id}`);
    await chrome.tabs.create({ url });
  } catch (_) {
    showTestStatus('Could not open transcript.');
  }
}

async function showPositionOnVideo() {
  try {
    const response = await messageActiveYouTube({ type: 'focusflow:show-position' });
    showTestStatus(response?.ok ? 'Position shown on video.' : 'FocusFlow is not ready yet.');
  } catch (_) {
    showTestStatus('Open or reload a YouTube watch page first.');
  }
}

function renderNotReadyProgress() {
  elements.progressReadout.textContent = '--:-- / --:--';
  elements.progressFill.style.width = '0%';
  elements.progressTrack.querySelectorAll('.progress-tick').forEach((tick) => tick.remove());
  elements.progressLine.textContent = 'Open a YouTube video to see progress.';
  elements.playState.textContent = '';
}

function renderProgress(progress) {
  elements.progressReadout.textContent = `${formatTime(progress.currentSeconds)} / ${formatTime(
    progress.durationSeconds
  )} (${Math.round(progress.percent)}%)`;
  elements.progressFill.style.width = `${Math.max(0, Math.min(100, progress.percent))}%`;
  elements.progressTrack.querySelectorAll('.progress-tick').forEach((tick) => tick.remove());
  for (const checkpoint of progress.checkpoints || []) {
    if (!progress.durationSeconds) continue;
    const tick = document.createElement('span');
    tick.className = 'progress-tick';
    tick.style.left = `${Math.max(0, Math.min(100, (checkpoint / progress.durationSeconds) * 100))}%`;
    elements.progressTrack.appendChild(tick);
  }
  const next =
    progress.secondsUntilNextCheckpoint === null
      ? 'no more checkpoints'
      : `next checkpoint in ${formatTime(progress.secondsUntilNextCheckpoint)}`;
  elements.progressLine.textContent = `Section ${progress.chunkIndex} of ${progress.chunkTotal} · ${next}`;
  elements.playState.textContent = progress.paused ? 'Paused' : 'Playing';
}

async function refreshProgress() {
  try {
    const progress = await messageActiveYouTube({ type: 'focusflow:get-progress' });
    if (!progress?.ok) renderNotReadyProgress();
    else renderProgress(progress);
  } catch (_) {
    renderNotReadyProgress();
  }
}

loadSettings().then(render);
loadClientId();
refreshAccount();
refreshStatus();
refreshProgress();

elements.enabled.addEventListener('click', () => {
  setEnabled(elements.enabled.getAttribute('aria-pressed') !== 'true');
  save();
});

elements.testCheckpoint.addEventListener('click', testCheckpoint);
elements.viewTranscript.addEventListener('click', openTranscript);
elements.showPosition.addEventListener('click', showPositionOnVideo);

elements.chunkRange.addEventListener('input', () => {
  elements.chunkMinutes.value = elements.chunkRange.value;
  elements.chunkValue.textContent = elements.chunkRange.value;
});
elements.chunkRange.addEventListener('change', save);

elements.chunkMinutes.addEventListener('input', () => {
  const value = clamp(elements.chunkMinutes.value, 1, 20, DEFAULT_SETTINGS.chunkMinutes);
  elements.chunkRange.value = String(value);
  elements.chunkValue.textContent = String(value);
});

for (const input of [
  elements.chunkMinutes,
  elements.minVideoMinutes,
  elements.autoPause,
  elements.useAI,
  elements.aiCheckpoints,
  elements.proxyUrl,
]) {
  input.addEventListener('change', save);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.lastStatus) renderStatus(changes.lastStatus.newValue);
  // The service worker updates `sync:<sub>` as a push succeeds or fails; keep
  // the sync line honest when that happens while the popup is open.
  if (areaName === 'local' && Object.keys(changes).some((key) => /^sync:/.test(key))) {
    refreshSyncStatus();
  }
});

// --- Google client ID (app-level, not per account) ------------------------

function loadClientId() {
  chrome.storage.sync.get({ googleClientId: '' }, ({ googleClientId }) => {
    elements.googleClientId.value = googleClientId || '';
  });
}

function saveClientId() {
  const googleClientId = elements.googleClientId.value.trim();
  chrome.storage.sync.set({ googleClientId }, () => {
    showSaved();
    refreshAccount();
  });
}

elements.googleClientId.addEventListener('change', saveClientId);

// --- account area ----------------------------------------------------------
// All auth work happens in the service worker (see background/auth.js). The
// interactive Google window can outlive this popup, so we message the worker
// rather than run the flow here. Everything shown below comes from the token's
// claims and is written with textContent — never innerHTML — so a hostile
// display name cannot inject markup.

function sendAuth(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: 'no_response' });
    });
  });
}

function showAccountError(text) {
  elements.accountError.textContent = text || '';
}

const AUTH_ERROR_TEXT = {
  no_client_id: 'No Google client ID is set yet — add one in Settings below.',
  user_cancelled: 'Sign-in was cancelled.',
  silent_failed: 'Could not refresh your session — please sign in again.',
  state_mismatch: 'Sign-in could not be verified. Please try again.',
  network: 'Could not reach the sign-in server. Check your connection and try again.',
  auth_flow_failed: 'Sign-in could not be completed. Please try again.',
};

function renderAccount(state) {
  const active = state?.active || null;
  const accounts = state?.accounts || [];

  renderSyncStatus(active);

  if (!active) {
    elements.accountSignedIn.hidden = true;
    elements.accountSignedOut.hidden = false;
    return;
  }

  elements.accountSignedOut.hidden = true;
  elements.accountSignedIn.hidden = false;

  // textContent only — never build HTML from token-provided strings.
  elements.accountName.textContent = active.name || active.email || 'Signed in';
  elements.accountEmail.textContent = active.email || '';

  if (active.picture) {
    elements.accountAvatar.src = active.picture;
    elements.accountAvatar.hidden = false;
  } else {
    elements.accountAvatar.removeAttribute('src');
    elements.accountAvatar.hidden = true;
  }

  elements.sessionExpired.hidden = active.hasValidToken !== false;

  // Offer a switcher only when more than one account is known on this device.
  if (accounts.length > 1) {
    elements.switchRow.hidden = false;
    elements.switchAccount.replaceChildren(
      ...accounts.map((acc) => {
        const option = document.createElement('option');
        option.value = acc.sub;
        option.textContent = acc.name || acc.email || acc.sub;
        option.selected = acc.sub === active.sub;
        return option;
      })
    );
  } else {
    elements.switchRow.hidden = true;
    elements.switchAccount.replaceChildren();
  }
}

async function refreshAccount() {
  const state = await sendAuth({ type: 'focusflow:auth-state' });
  if (state.ok) renderAccount(state);
}

// --- sync status line ------------------------------------------------------
// A quiet, honest one-liner about where settings live. Signed out, settings
// stay on this device only, so we invite the user to sign in. Signed in, we
// show "Synced" only when the service worker has actually confirmed a sync with
// the server; anything else (pending, error, expired session) is reported
// plainly as device-only rather than a false "Synced". The service worker keeps
// this state in chrome.storage.local under `sync:<sub>`.
async function renderSyncStatus(active) {
  if (!active) {
    elements.syncStatus.textContent = 'Sign in to sync your settings across devices.';
    return;
  }
  const key = `sync:${active.sub}`;
  const stored = await chrome.storage.local.get({ [key]: null });
  const status = stored[key]?.status;
  elements.syncStatus.textContent =
    status === 'synced' ? 'Synced' : 'Saved on this device only';
}

async function refreshSyncStatus() {
  const state = await sendAuth({ type: 'focusflow:auth-state' });
  renderSyncStatus(state.ok ? state.active : null);
}

// After any account change, reload settings so the form reflects the new
// (or now-anonymous) person, and clear any stale error.
async function afterAccountChange(state) {
  if (state.ok) renderAccount(state);
  showAccountError('');
  render(await loadSettings());
}

elements.signInBtn.addEventListener('click', async () => {
  showAccountError('');
  elements.signInBtn.disabled = true;
  const result = await sendAuth({ type: 'focusflow:auth-sign-in' });
  elements.signInBtn.disabled = false;
  if (result.ok) {
    await afterAccountChange(await sendAuth({ type: 'focusflow:auth-state' }));
  } else {
    showAccountError(AUTH_ERROR_TEXT[result.error] || result.message || 'Sign-in failed.');
  }
});

elements.signOutBtn.addEventListener('click', async () => {
  const state = await sendAuth({ type: 'focusflow:auth-sign-out' });
  await afterAccountChange(state);
});

elements.removeAccountBtn.addEventListener('click', async () => {
  const state = await sendAuth({ type: 'focusflow:auth-state' });
  const sub = state.ok && state.active ? state.active.sub : null;
  if (!sub) return;
  const next = await sendAuth({ type: 'focusflow:auth-remove', sub });
  await afterAccountChange(next);
});

elements.switchAccount.addEventListener('change', async () => {
  const sub = elements.switchAccount.value;
  if (!sub) return;
  const state = await sendAuth({ type: 'focusflow:auth-switch', sub });
  await afterAccountChange(state);
});

window.addEventListener('unload', () => clearInterval(progressTimer));

