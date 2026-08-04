const { formatTime } = window.FocusFlowFormat;
const DEFAULT_PROXY_URL = 'https://func-checkpoint-yt-pb5kh8.azurewebsites.net/api/generate';

const DEFAULT_SETTINGS = {
  enabled: true,
  chunkMinutes: 3,
  minVideoMinutes: 4,
  autoPause: true,
  useAI: false,
  proxyUrl: DEFAULT_PROXY_URL,
};

const elements = {
  enabled: document.querySelector('#enabled'),
  chunkRange: document.querySelector('#chunkRange'),
  chunkMinutes: document.querySelector('#chunkMinutes'),
  chunkValue: document.querySelector('#chunkValue'),
  minVideoMinutes: document.querySelector('#minVideoMinutes'),
  autoPause: document.querySelector('#autoPause'),
  useAI: document.querySelector('#useAI'),
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
    enabled: elements.enabled.getAttribute('aria-pressed') === 'true',
    chunkMinutes: clamp(elements.chunkMinutes.value, 1, 20, DEFAULT_SETTINGS.chunkMinutes),
    minVideoMinutes: Math.max(0, Number(elements.minVideoMinutes.value) || 0),
    autoPause: elements.autoPause.checked,
    useAI: elements.useAI.checked,
    proxyUrl: elements.proxyUrl.value.trim() || DEFAULT_PROXY_URL,
  };
}

function render(settings) {
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
  chrome.storage.sync.set(settings, showSaved);
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

chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => render(settings));
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
  elements.proxyUrl,
]) {
  input.addEventListener('change', save);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.lastStatus) renderStatus(changes.lastStatus.newValue);
});

window.addEventListener('unload', () => clearInterval(progressTimer));
