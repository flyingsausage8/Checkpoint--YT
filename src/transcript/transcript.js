const { formatTime } = window.FocusFlowFormat;

const params = new URLSearchParams(location.search);
const tabId = Number(params.get('tabId'));
const els = {
  title: document.querySelector('#title'),
  meta: document.querySelector('#meta'),
  filter: document.querySelector('#filter'),
  copyAll: document.querySelector('#copyAll'),
  download: document.querySelector('#download'),
  confirm: document.querySelector('#confirm'),
  message: document.querySelector('#message'),
  list: document.querySelector('#list'),
};

let transcript = null;
let confirmTimer = null;

function sourceExplanation(source) {
  if (source === 'timedtext') return 'timedtext: direct YouTube caption track';
  if (source === 'panel') return 'panel: read from YouTube transcript panel fallback';
  return 'none: no captions found, so checkpoints use self-check questions';
}

function showMessage(message) {
  els.message.textContent = message;
  els.list.replaceChildren();
}

function setConfirm(message) {
  els.confirm.textContent = message;
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => {
    els.confirm.textContent = '';
  }, 1800);
}

function highlightText(text, query) {
  const fragment = document.createDocumentFragment();
  if (!query) {
    fragment.append(document.createTextNode(text));
    return fragment;
  }

  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  let cursor = 0;
  let index = lower.indexOf(needle);
  while (index !== -1) {
    fragment.append(document.createTextNode(text.slice(cursor, index)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(index, index + needle.length);
    fragment.append(mark);
    cursor = index + needle.length;
    index = lower.indexOf(needle, cursor);
  }
  fragment.append(document.createTextNode(text.slice(cursor)));
  return fragment;
}

async function sendToVideo(message) {
  if (!Number.isInteger(tabId)) throw new Error('missing tab id');
  return chrome.tabs.sendMessage(tabId, message);
}

async function seek(seconds) {
  try {
    const response = await sendToVideo({ type: 'focusflow:seek', seconds });
    if (!response?.ok) throw new Error(response?.error || 'seek failed');
    setConfirm(`Jumped to ${formatTime(seconds)}`);
  } catch (_) {
    setConfirm('Could not jump. Is the YouTube tab still open?');
  }
}

function makeDivider(index, seconds) {
  const div = document.createElement('div');
  div.className = 'divider';
  div.textContent = `— Checkpoint ${index} (${formatTime(seconds)}) —`;
  return div;
}

function makeRow(cue, query) {
  const row = document.createElement('div');
  row.className = 'row';
  const time = document.createElement('button');
  time.className = 'time';
  time.type = 'button';
  time.textContent = formatTime(cue.start);
  time.addEventListener('click', () => seek(cue.start));
  const text = document.createElement('div');
  text.className = 'text';
  text.append(highlightText(cue.text, query));
  row.append(time, text);
  return row;
}

function renderList() {
  if (!transcript) return;
  const query = els.filter.value.trim();
  const cues = transcript.cues.filter((cue) => cue.text.toLowerCase().includes(query.toLowerCase()));
  const nodes = [];
  let checkpointIndex = 0;

  for (const cue of cues) {
    while (
      checkpointIndex < transcript.checkpoints.length &&
      cue.start >= transcript.checkpoints[checkpointIndex]
    ) {
      nodes.push(makeDivider(checkpointIndex + 1, transcript.checkpoints[checkpointIndex]));
      checkpointIndex += 1;
    }
    nodes.push(makeRow(cue, query));
  }

  els.list.replaceChildren(...nodes);
  els.message.textContent = cues.length ? '' : 'No transcript rows match your search.';
}

function transcriptText() {
  if (!transcript) return '';
  const lines = [transcript.title, `Video ID: ${transcript.videoId}`, `Source: ${transcript.source}`, ''];
  for (const cue of transcript.cues) lines.push(`[${formatTime(cue.start)}] ${cue.text}`);
  return lines.join('\n');
}

async function copyAll() {
  try {
    await navigator.clipboard.writeText(transcriptText());
    setConfirm('Copied transcript.');
  } catch (_) {
    setConfirm('Copy failed.');
  }
}

function downloadTxt() {
  const blob = new Blob([transcriptText()], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${transcript?.videoId || 'focusflow'}-transcript.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

async function loadTranscript() {
  if (!Number.isInteger(tabId)) {
    showMessage('Open this page from the FocusFlow popup on a YouTube video.');
    return;
  }

  try {
    const response = await sendToVideo({ type: 'focusflow:get-transcript' });
    if (!response?.ok) throw new Error(response?.error || 'not_ready');
    transcript = response;
    els.title.textContent = response.title || 'YouTube transcript';
    els.meta.textContent = `${sourceExplanation(response.source)} · ${response.cues.length} cues · ${response.checkpoints.length} checkpoints · ${formatTime(response.durationSeconds)}`;
    if (!response.cues.length) {
      showMessage('No captions were found for this video. FocusFlow will use self-check questions.');
      return;
    }
    renderList();
  } catch (_) {
    showMessage('Could not read the transcript. Open a YouTube video, refresh the page, wait for FocusFlow to load, then try again.');
  }
}

els.filter.addEventListener('input', renderList);
els.copyAll.addEventListener('click', copyAll);
els.download.addEventListener('click', downloadTxt);
loadTranscript();
