const { formatTime } = window.FocusFlowFormat;
const S = window.FocusFlowSettings;

// The whole settings object as we last read or wrote it. The popup only has
// controls for some of it (focus mode and the advanced setup fields); the rest —
// section length, auto-pause, the AI switches, all of which live in the on-page
// panel now — is carried through untouched. Without that, saving here would wipe
// them, because signing in stores settings as one replaced object.
let settings = { ...S.DEFAULTS };

const elements = {
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
  // focus mode
  focusOn: document.querySelector('#focusOn'),
  focusComplete: document.querySelector('#focusComplete'),
  focusCustom: document.querySelector('#focusCustom'),
  focusLevels: document.querySelector('#focusLevels'),
  focusPartsBox: document.querySelector('#focusParts'),
  focusParts: {},
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

function render(loaded) {
  settings = { ...S.DEFAULTS, ...loaded };
  completeBeforeCustom = S.normaliseMode(settings.focusMode) === 'complete';
  elements.proxyUrl.value = settings.proxyUrl || S.DEFAULT_PROXY_URL;
  renderFocus();
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
  S.persist(settings).then(showSaved);
}

// --- focus mode ------------------------------------------------------------
// Three switches over one stored value. `focusMode` ('off' | 'standard' |
// 'complete' | 'custom') is the single source of truth; the switches are three
// views of it, which is why every path goes through applyFocusMode rather than
// setting flags independently and hoping they agree.
//
// Nothing here touches the page directly. The content script (src/content/focus.js)
// watches storage, so writing the setting is what updates every open YouTube tab.

// Remembered only while the popup is open: turning customize off should give
// back the complete-focus level you had, not silently reset to standard.
let completeBeforeCustom = false;

// The first render must not animate, or every popup opening would play a slide.
let booting = true;

function focusState() {
  const mode = S.normaliseMode(settings.focusMode);
  return { mode, on: mode !== 'off', complete: mode === 'complete', custom: mode === 'custom' };
}

function applyFocusMode(mode) {
  settings.focusMode = mode;
  renderFocus();
  save();
}

function setSwitch(button, on, { disabled = false } = {}) {
  button.setAttribute('aria-pressed', String(Boolean(on)));
  button.textContent = on ? 'On' : 'Off';
  button.disabled = disabled;
  button.classList.toggle('switch-off', !on);
}

/**
 * A slide container is `max-height: 0` when closed. The open height has to be a
 * real number for the transition to run, and `max-height: none` cannot animate,
 * so we measure the content and set it explicitly.
 */
function setSlide(container, open) {
  const inner = container.firstElementChild;
  container.classList.toggle('slide-open', open);
  container.style.maxHeight = open ? `${inner.scrollHeight}px` : '0px';
  // Once open, drop the fixed height so the section can still grow if its
  // contents change; a stale pixel value would clip them.
  if (open) {
    setTimeout(() => {
      if (container.classList.contains('slide-open')) container.style.maxHeight = 'none';
    }, 260);
  }
}

function buildFocusParts() {
  const box = elements.focusPartsBox.firstElementChild;
  for (const part of S.FOCUS_PARTS) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = `part-${part.id}`;
    input.addEventListener('change', () => {
      settings.focusParts = S.FOCUS_PARTS.filter((p) => elements.focusParts[p.id].checked)
        .map((p) => p.id)
        .join(',');
      save();
    });

    const label = document.createElement('label');
    label.htmlFor = input.id;
    const text = document.createElement('span');
    text.textContent = part.label;
    label.append(input, text);

    const row = document.createElement('div');
    row.className = 'part-row';
    row.appendChild(label);
    if (part.hint) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = part.hint;
      row.appendChild(hint);
    }
    box.appendChild(row);
    elements.focusParts[part.id] = input;
  }
}

function renderFocus() {
  const state = focusState();
  setSwitch(elements.focusOn, state.on);
  // Complete focus is disabled rather than hidden while customizing: it explains
  // where the per-part list came from, and hiding it would make the section jump
  // about as you toggle.
  setSwitch(elements.focusComplete, state.complete, { disabled: state.custom });
  setSwitch(elements.focusCustom, state.custom);
  elements.focusComplete.title = state.custom
    ? 'Turn customize focus off to use complete focus.'
    : '';

  const chosen = new Set(S.hiddenParts(settings));
  for (const part of S.FOCUS_PARTS) {
    elements.focusParts[part.id].checked = chosen.has(part.id);
  }

  if (booting) document.body.classList.add('booting');
  setSlide(elements.focusLevels, state.on);
  setSlide(elements.focusPartsBox, state.custom);
  if (booting) {
    booting = false;
    requestAnimationFrame(() => document.body.classList.remove('booting'));
  }
}

buildFocusParts();

elements.focusOn.addEventListener('click', () => {
  if (elements.focusOn.disabled) return;
  if (focusState().on) return applyFocusMode('off');
  // Coming back on lands on whichever level was last in use.
  applyFocusMode(completeBeforeCustom ? 'complete' : 'standard');
});

elements.focusComplete.addEventListener('click', () => {
  if (elements.focusComplete.disabled) return;
  const next = !focusState().complete;
  completeBeforeCustom = next;
  applyFocusMode(next ? 'complete' : 'standard');
});

elements.focusCustom.addEventListener('click', () => {
  if (elements.focusCustom.disabled) return;
  if (!focusState().custom) {
    // Seed from whatever is hidden right now, so switching to customize never
    // changes the page by itself — it just hands over the controls.
    settings.focusParts = S.hiddenParts(settings).join(',');
    completeBeforeCustom = focusState().complete;
    return applyFocusMode('custom');
  }
  applyFocusMode(completeBeforeCustom ? 'complete' : 'standard');
});

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

S.load().then(render);
loadClientId();
refreshAccount();
refreshStatus();
refreshProgress();

elements.testCheckpoint.addEventListener('click', testCheckpoint);
elements.viewTranscript.addEventListener('click', openTranscript);
elements.showPosition.addEventListener('click', showPositionOnVideo);

elements.proxyUrl.addEventListener('change', () => {
  settings.proxyUrl = elements.proxyUrl.value.trim() || S.DEFAULT_PROXY_URL;
  elements.proxyUrl.value = settings.proxyUrl;
  save();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.lastStatus) renderStatus(changes.lastStatus.newValue);
  // The panel owns the section and AI settings now. The popup still carries them
  // through every save, so it has to notice when they change under it — writing
  // back a stale copy would quietly undo whatever was just set beside the video.
  if (areaName === 'sync') refreshSettings();
  // The service worker updates `sync:<sub>` as a push succeeds or fails; keep
  // the sync line honest when that happens while the popup is open.
  if (areaName === 'local' && Object.keys(changes).some((key) => /^sync:/.test(key))) {
    refreshSyncStatus();
  }
});

async function refreshSettings() {
  const next = { ...S.DEFAULTS, ...(await S.load()) };
  // Ignore the echo of our own write, so the focus section doesn't re-render
  // (and re-measure its slides) every time a switch is clicked.
  if (JSON.stringify(next) === JSON.stringify(settings)) return;
  render(next);
}

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
  render(await S.load());
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

