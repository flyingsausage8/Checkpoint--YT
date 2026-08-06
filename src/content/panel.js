/**
 * The FocusFlow panel that sits at the top of YouTube's recommendations column.
 *
 * The browser action popup is fine for setup, but it closes the moment you
 * click back at the video, which makes it useless for the thing people
 * actually want to see while watching: how far the next checkpoint is and
 * whether FocusFlow is working at all. This puts that on the page, above the
 * recommended videos, where it can stay open.
 *
 * Settings written here go to exactly the same place the popup writes them,
 * and content.js already re-plans the video whenever they change, so the two
 * stay in step without this file knowing anything about the pipeline.
 */
window.FocusFlow = window.FocusFlow || {};

window.FocusFlow.panel = (() => {
  const S = window.FocusFlowSettings;
  const DEFAULT_SETTINGS = S.DEFAULTS;

  const RECHECK_MS = 1000;
  const SAVE_DEBOUNCE_MS = 400;

  // Mirrors END_BUFFER_SECONDS in content.js: makeCheckpoints() stops placing
  // checkpoints this many seconds before the end so the last question never
  // lands on the outro. Kept in step so the panel's estimate matches the plan.
  const END_BUFFER_SECONDS = 30;

  let root = null;
  let els = {};
  let settings = { ...DEFAULT_SETTINGS };
  let recheckTimer = null;
  let tickTimer = null;
  let saveTimer = null;
  let collapsed = false;

  const fmt = (seconds) => window.FocusFlowFormat.formatTime(seconds);

  function host() {
    return document.querySelector('#secondary-inner') || document.querySelector('#secondary');
  }

  function onWatchPage() {
    return /^\/watch$/.test(location.pathname);
  }

  // --- storage ------------------------------------------------------------
  // Both of these are in src/shared/settings.js so the panel, the popup and the
  // content script cannot drift apart about where settings live (signed out:
  // top-level sync keys; signed in: `account:<sub>:settings`).

  const loadSettings = () => S.load();
  const persistSettings = (next) => S.persist(next);

  /**
   * Saving re-plans the whole video, so a slider being dragged must not save on
   * every step. The UI updates immediately; only the write is debounced.
   */
  function queueSave() {
    clearTimeout(saveTimer);
    els.saveNote.textContent = 'Saving…';
    saveTimer = setTimeout(async () => {
      await persistSettings(settings);
      els.saveNote.textContent = 'Saved';
      setTimeout(() => {
        if (els.saveNote) els.saveNote.textContent = '';
      }, 1200);
    }, SAVE_DEBOUNCE_MS);
  }

  // --- building -----------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function groupTitle(text) {
    return el('div', 'ffp-group-title', text);
  }

  // How many checkpoints the current spacing implies for a video of this length.
  // This is the same evenly-spaced count content.js's makeCheckpoints() produces,
  // so it is exact when AI is off and a close "about" figure when AI is on (where
  // chapters and skipped sponsor/intro sections nudge it up or down). Returns null
  // when we do not yet know the video length.
  function estimatedCheckpoints() {
    const duration = window.FocusFlow.session?.progress?.()?.durationSeconds;
    if (!Number.isFinite(duration) || duration <= 0) return null;
    const target = S.sectionBounds(settings).target;
    if (!Number.isFinite(target) || target <= 0) return null;
    return Math.max(0, Math.floor((duration - END_BUFFER_SECONDS - 1e-6) / target));
  }

  function renderCheckpointEstimate() {
    if (!els.checkpointEstimate) return;
    const count = estimatedCheckpoints();
    if (count === null) {
      els.checkpointEstimate.textContent = 'Checkpoint count appears once the video length is known.';
    } else {
      els.checkpointEstimate.textContent = `About ${count} checkpoint${count === 1 ? '' : 's'} for this video.`;
    }
  }

  function row(labelText, control, hintText) {
    const wrap = el('div', 'ffp-row');
    const label = el('label', 'ffp-label', labelText);
    if (control.id) label.htmlFor = control.id;
    wrap.append(label, control);
    if (hintText) wrap.appendChild(el('div', 'ffp-hint', hintText));
    return wrap;
  }

  function checkbox(id, labelText, hintText, key) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = settings[key] !== false;
    input.addEventListener('change', () => {
      settings[key] = input.checked;
      queueSave();
    });
    const label = el('label', 'ffp-check');
    label.htmlFor = id;
    label.append(input, el('span', null, labelText));
    const wrap = el('div', 'ffp-row ffp-row-check');
    wrap.appendChild(label);
    if (hintText) wrap.appendChild(el('div', 'ffp-hint', hintText));
    return { wrap, input };
  }

  // Focus mode used to live here. It moved to the toolbar popup, because the
  // panel only exists on a watch page and someone staring at a wall of
  // recommendations on the home page had no way to switch the hiding off. The
  // panel keeps everything about this video's checkpoints and questions.

  function build() {
    root = el('div', 'ffp-panel');
    root.id = 'focusflow-panel';

    // Header ---------------------------------------------------------------
    const head = el('div', 'ffp-head');
    const title = el('div', 'ffp-title', 'FocusFlow');
    const power = el('button', 'ffp-power');
    power.type = 'button';
    power.addEventListener('click', () => {
      settings.enabled = !settings.enabled;
      renderPower();
      queueSave();
    });
    const toggle = el('button', 'ffp-collapse');
    toggle.type = 'button';
    toggle.addEventListener('click', () => setCollapsed(!collapsed));
    head.append(title, power, toggle);

    // Body -----------------------------------------------------------------
    const body = el('div', 'ffp-body');

    const summary = el('div', 'ffp-summary');
    const summaryLine = el('div', 'ffp-summary-line', 'Checking this video…');
    const progressLine = el('div', 'ffp-progress-line', '');
    const track = el('div', 'ffp-track');
    const fill = el('div', 'ffp-fill');
    track.appendChild(fill);
    summary.append(summaryLine, track, progressLine);

    const ask = el('button', 'ffp-btn', 'Ask a question now');
    ask.type = 'button';
    ask.addEventListener('click', async () => {
      const session = window.FocusFlow.session;
      if (!session?.triggerNow) return;
      ask.disabled = true;
      try {
        await session.triggerNow();
      } finally {
        ask.disabled = false;
      }
    });

    // Settings -------------------------------------------------------------
    const settingsWrap = el('div', 'ffp-settings');

    const chunk = document.createElement('input');
    chunk.type = 'range';
    chunk.id = 'ffp-chunk';
    chunk.min = '1';
    chunk.max = '20';
    chunk.step = '1';
    chunk.value = String(settings.chunkMinutes);
    const chunkValue = el('span', 'ffp-value', `${settings.chunkMinutes} min`);
    chunk.addEventListener('input', () => {
      settings.chunkMinutes = Number(chunk.value);
      chunkValue.textContent = `${settings.chunkMinutes} min`;
      renderBounds();
      renderCheckpointEstimate();
      queueSave();
    });
    const chunkRow = row(
      'Check in about every',
      chunk,
      'The length AI aims for, and the exact spacing when AI is off.'
    );
    chunkRow.querySelector('.ffp-label').appendChild(chunkValue);
    // The consequence of the slider above, shown live: rather than a second
    // control that could contradict the spacing, this reads out how many
    // checkpoints the current spacing implies for the video open right now.
    const checkpointEstimate = el('div', 'ffp-hint ffp-estimate', '');
    chunkRow.appendChild(checkpointEstimate);

    // Fine-tune: the target above is what the AI aims for, but a topic rarely
    // ends exactly on time, so these two give it room to move either way.
    const fine = el('details', 'ffp-fine');
    const fineHead = el('summary', 'ffp-fine-head', 'Fine-tune section length');
    const fineBody = el('div', 'ffp-fine-body');

    const shortest = document.createElement('input');
    shortest.type = 'number';
    shortest.id = 'ffp-sec-min';
    shortest.min = '0.5';
    shortest.max = '60';
    shortest.step = '0.5';
    const longest = document.createElement('input');
    longest.type = 'number';
    longest.id = 'ffp-sec-max';
    longest.min = '1';
    longest.max = '120';
    longest.step = '0.5';
    const fineNote = el('div', 'ffp-hint', '');

    // One place decides what the three numbers really mean, so the sentence
    // under them can never disagree with what the AI is actually told.
    function renderBounds() {
      const bounds = S.sectionBounds(settings);
      const round = (seconds) => Math.round((seconds / 60) * 10) / 10;
      shortest.value = String(round(bounds.min));
      longest.value = String(round(bounds.max));
      fineNote.textContent = `Sections will be ${round(bounds.min)}–${round(
        bounds.max
      )} minutes, aiming for ${round(bounds.target)}.`;
    }

    shortest.addEventListener('change', () => {
      settings.sectionMinMinutes = Math.max(0.5, Number(shortest.value) || 0.5);
      renderBounds();
      queueSave();
    });
    longest.addEventListener('change', () => {
      settings.sectionMaxMinutes = Math.max(1, Number(longest.value) || 1);
      renderBounds();
      queueSave();
    });

    fineBody.append(row('Shortest (min)', shortest), row('Longest (min)', longest), fineNote);
    fine.append(fineHead, fineBody);

    const minLen = document.createElement('input');
    minLen.type = 'number';
    minLen.id = 'ffp-minlen';
    minLen.min = '0';
    minLen.max = '600';
    minLen.value = String(settings.minVideoMinutes);
    minLen.addEventListener('change', () => {
      settings.minVideoMinutes = Math.max(0, Number(minLen.value) || 0);
      minLen.value = String(settings.minVideoMinutes);
      queueSave();
    });
    const minRow = row('Skip videos shorter than (min)', minLen);

    const pause = checkbox('ffp-pause', 'Pause the video at each checkpoint', null, 'autoPause');
    const useAI = checkbox('ffp-ai', 'Use AI to write the questions', null, 'useAI');
    const aiCheckpoints = checkbox(
      'ffp-aicp',
      'Let AI decide where sections end',
      'Off means evenly spaced checkpoints instead.',
      'aiCheckpoints'
    );

    settingsWrap.append(
      groupTitle('Timing'),
      chunkRow,
      fine,
      minRow,
      groupTitle('Questions'),
      useAI.wrap,
      aiCheckpoints.wrap,
      pause.wrap
    );
    renderBounds();

    const saveNote = el('div', 'ffp-save', '');
    body.append(groupTitle('This video'), summary, ask, settingsWrap, saveNote);
    root.append(head, body);

    els = {
      power,
      toggle,
      body,
      summaryLine,
      progressLine,
      track,
      fill,
      ask,
      chunk,
      chunkValue,
      checkpointEstimate,
      minLen,
      pause: pause.input,
      useAI: useAI.input,
      aiCheckpoints: aiCheckpoints.input,
      renderBounds,
      saveNote,
    };

    renderPower();
    setCollapsed(collapsed, { save: false });
    renderCheckpointEstimate();
    return root;
  }

  function renderPower() {
    els.power.textContent = settings.enabled ? 'On' : 'Off';
    els.power.setAttribute('aria-pressed', String(Boolean(settings.enabled)));
    root.classList.toggle('ffp-off', !settings.enabled);
  }

  function setCollapsed(next, { save = true } = {}) {
    collapsed = Boolean(next);
    root.classList.toggle('ffp-collapsed', collapsed);
    els.toggle.textContent = collapsed ? 'Show' : 'Hide';
    els.toggle.setAttribute('aria-expanded', String(!collapsed));
    els.body.hidden = collapsed;
    // A UI preference, not a synced setting: keeping it in local storage means
    // it never has to be added to the sync allowlist in two separate files.
    if (save) chrome.storage.local.set({ panelCollapsed: collapsed });
  }

  // --- live state ---------------------------------------------------------

  function renderStatus(status) {
    if (!status || !status.videoId) {
      els.summaryLine.textContent = 'Waiting for a video…';
      return;
    }
    if (status.ready) {
      const source = status.aiActive ? 'AI questions' : 'offline questions';
      els.summaryLine.textContent = `${status.checkpointCount} checkpoints · ${source}`;
      els.summaryLine.classList.remove('ffp-warn');
    } else {
      els.summaryLine.textContent = status.reason || 'Not running on this video';
      els.summaryLine.classList.add('ffp-warn');
    }
  }

  function renderProgress() {
    renderCheckpointEstimate();
    const progress = window.FocusFlow.session?.progress?.();
    if (!progress?.ok || !progress.durationSeconds) {
      els.progressLine.textContent = '';
      els.fill.style.width = '0%';
      els.track.hidden = true;
      return;
    }
    els.track.hidden = false;
    els.fill.style.width = `${Math.min(100, progress.percent)}%`;
    const parts = [`Section ${progress.chunkIndex} of ${progress.chunkTotal}`];
    if (progress.nextCheckpointSeconds != null) {
      const remaining = Math.max(0, progress.nextCheckpointSeconds - progress.currentSeconds);
      parts.push(`next checkpoint in ${fmt(remaining)}`);
    } else {
      parts.push('no more checkpoints');
    }
    els.progressLine.textContent = parts.join(' · ');
    els.ask.disabled = !window.FocusFlow.session?.hasCheckpoints?.();
  }

  function refreshStatus() {
    chrome.storage.local.get({ lastStatus: null }, ({ lastStatus }) => {
      if (root) renderStatus(lastStatus);
    });
  }

  // --- mounting -----------------------------------------------------------

  function mount() {
    const parent = host();
    if (!parent || !root) return false;
    if (root.parentElement === parent && parent.firstElementChild === root) return true;
    parent.insertBefore(root, parent.firstElementChild);
    return true;
  }

  function startTimers() {
    stopTimers();
    // YouTube re-renders the sidebar on navigation and on layout changes, which
    // can drop or reorder our node; cheap to re-assert than to observe.
    recheckTimer = setInterval(() => {
      if (!onWatchPage()) return destroy();
      mount();
    }, RECHECK_MS);
    tickTimer = setInterval(renderProgress, 1000);
  }

  function stopTimers() {
    if (recheckTimer) clearInterval(recheckTimer);
    if (tickTimer) clearInterval(tickTimer);
    recheckTimer = null;
    tickTimer = null;
  }

  let storageListener = null;

  async function init() {
    if (!onWatchPage()) return false;
    if (root) {
      mount();
      return true;
    }

    settings = { ...DEFAULT_SETTINGS, ...(await loadSettings()) };
    const { panelCollapsed } = await chrome.storage.local.get({ panelCollapsed: false });
    collapsed = Boolean(panelCollapsed);

    build();
    mount();
    refreshStatus();
    renderProgress();
    startTimers();

    storageListener = (changes, area) => {
      if (area === 'local' && changes.lastStatus) renderStatus(changes.lastStatus.newValue);
      // Settings changed elsewhere (the popup, or a sync pull from another
      // device) must show up here rather than leaving a stale form on screen.
      if (area === 'sync') refreshSettingsFromStorage();
    };
    chrome.storage.onChanged.addListener(storageListener);
    return true;
  }

  async function refreshSettingsFromStorage() {
    const next = { ...DEFAULT_SETTINGS, ...(await loadSettings()) };
    // Ignore an echo of what we just wrote, so a slider doesn't jump under the
    // cursor while it is being dragged.
    if (JSON.stringify(next) === JSON.stringify(settings)) return;
    settings = next;
    if (!root) return;
    els.chunk.value = String(settings.chunkMinutes);
    els.chunkValue.textContent = `${settings.chunkMinutes} min`;
    els.minLen.value = String(settings.minVideoMinutes);
    els.pause.checked = settings.autoPause !== false;
    els.useAI.checked = settings.useAI !== false;
    els.aiCheckpoints.checked = settings.aiCheckpoints !== false;
    els.renderBounds();
    renderCheckpointEstimate();
    renderPower();
  }

  function destroy() {
    stopTimers();
    if (storageListener) chrome.storage.onChanged.removeListener(storageListener);
    storageListener = null;
    root?.remove();
    root = null;
    els = {};
  }

  return { init, destroy, refreshStatus };
})();
