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

  /** A small on/off pill. Used for focus mode, where a checkbox reads too quietly. */
  function switchButton(id, onChange) {
    const button = el('button', 'ffp-switch');
    button.type = 'button';
    button.id = id;
    button.addEventListener('click', () => {
      if (button.disabled) return;
      onChange(button.getAttribute('aria-pressed') !== 'true');
    });
    return button;
  }

  function setSwitch(button, on, { disabled = false } = {}) {
    button.setAttribute('aria-pressed', String(Boolean(on)));
    button.textContent = on ? 'On' : 'Off';
    button.disabled = disabled;
    button.classList.toggle('ffp-switch-off', !on);
  }

  function switchRow(labelText, button, hintText) {
    const wrap = el('div', 'ffp-switch-row');
    const label = el('label', 'ffp-switch-label', labelText);
    label.htmlFor = button.id;
    wrap.append(label, button);
    if (hintText) {
      const hint = el('div', 'ffp-hint ffp-switch-hint', hintText);
      wrap.appendChild(hint);
    }
    return wrap;
  }

  // --- focus mode ---------------------------------------------------------
  // Three switches over one stored value. `focusMode` is the single source of
  // truth ('off' | 'standard' | 'complete' | 'custom'); the switches are just
  // three views of it, which is why every path below goes through applyFocusMode
  // rather than setting flags independently and hoping they agree.

  // Remembered only for this page view: if someone turns customize on and then
  // off again, they should get back the complete-focus setting they had, not a
  // silent reset to standard.
  let completeBeforeCustom = false;

  function focusState() {
    const mode = S.normaliseMode(settings.focusMode);
    return { mode, on: mode !== 'off', complete: mode === 'complete', custom: mode === 'custom' };
  }

  function applyFocusMode(mode) {
    settings.focusMode = mode;
    renderFocus();
    // Show the result immediately rather than after the debounced write comes
    // back through the storage listener, so the page reacts as you click.
    window.FocusFlow.focus?.apply(settings);
    queueSave();
  }

  function buildFocus() {
    const wrap = el('div', 'ffp-focus');
    wrap.appendChild(el('div', 'ffp-section-title', 'Focus mode'));

    const master = switchButton('ffp-focus-on', (next) => {
      if (!next) return applyFocusMode('off');
      // Coming back on lands on whichever level they were last using.
      applyFocusMode(completeBeforeCustom ? 'complete' : 'standard');
    });
    wrap.appendChild(
      switchRow('Hide distractions', master, 'Off puts YouTube back exactly as it was.')
    );

    // Everything below only makes sense while focus mode is on, so it slides
    // away with it instead of sitting there greyed out.
    const levels = el('div', 'ffp-slide');
    const levelsInner = el('div', 'ffp-slide-inner');

    const complete = switchButton('ffp-focus-complete', (next) => {
      completeBeforeCustom = next;
      applyFocusMode(next ? 'complete' : 'standard');
    });
    levelsInner.appendChild(
      switchRow('Complete focus', complete, 'Hides everything in the list below, not just the usual few.')
    );

    const custom = switchButton('ffp-focus-custom', (next) => {
      if (next) {
        // Seed from whatever is hidden right now, so switching to customize
        // never changes the page by itself — it just hands over the controls.
        settings.focusParts = S.hiddenParts(settings).join(',');
        completeBeforeCustom = focusState().complete;
        return applyFocusMode('custom');
      }
      applyFocusMode(completeBeforeCustom ? 'complete' : 'standard');
    });
    levelsInner.appendChild(
      switchRow('Customize focus', custom, 'Pick exactly what disappears.')
    );

    const parts = el('div', 'ffp-slide ffp-parts');
    const partsInner = el('div', 'ffp-slide-inner');
    const partInputs = {};
    for (const part of S.FOCUS_PARTS) {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = `ffp-part-${part.id}`;
      input.addEventListener('change', () => {
        const chosen = S.FOCUS_PARTS.filter((p) => partInputs[p.id].checked).map((p) => p.id);
        settings.focusParts = chosen.join(',');
        window.FocusFlow.focus?.apply(settings);
        queueSave();
      });
      const label = el('label', 'ffp-check');
      label.htmlFor = input.id;
      label.append(input, el('span', null, part.label));
      const row = el('div', 'ffp-row ffp-row-check');
      row.appendChild(label);
      if (part.hint) row.appendChild(el('div', 'ffp-hint', part.hint));
      partsInner.appendChild(row);
      partInputs[part.id] = input;
    }
    parts.appendChild(partsInner);
    levelsInner.appendChild(parts);
    levels.appendChild(levelsInner);
    wrap.appendChild(levels);

    return { wrap, master, complete, custom, levels, parts, partInputs };
  }

  /**
   * A slide container is `max-height: 0` when closed. The open height has to be
   * a real number for the transition to run, and `max-height: none` doesn't
   * animate, so we measure the content and set it explicitly.
   */
  function setSlide(container, open) {
    const inner = container.firstElementChild;
    container.classList.toggle('ffp-slide-open', open);
    container.style.maxHeight = open ? `${inner.scrollHeight}px` : '0px';
    // Once open, drop the fixed height so the section can still grow if its
    // contents change; a stale pixel value would clip them.
    if (open) {
      setTimeout(() => {
        if (container.classList.contains('ffp-slide-open')) container.style.maxHeight = 'none';
      }, 260);
    }
  }

  function renderFocus() {
    const state = focusState();
    setSwitch(els.focusMaster, state.on);
    // Complete focus is disabled, not hidden, while customizing: it explains
    // where the per-part list came from, and hiding it would make the section
    // jump about as you toggle.
    setSwitch(els.focusComplete, state.complete, { disabled: state.custom });
    setSwitch(els.focusCustom, state.custom);
    els.focusComplete.title = state.custom
      ? 'Turn customize focus off to use complete focus.'
      : '';

    const chosen = new Set(S.hiddenParts(settings));
    for (const part of S.FOCUS_PARTS) {
      els.focusParts[part.id].checked = chosen.has(part.id);
    }

    setSlide(els.focusLevels, state.on);
    setSlide(els.focusPartsBox, state.custom);
  }

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
      queueSave();
    });
    const chunkRow = row('Check in about every', chunk, 'Only used when AI is not choosing the sections itself.');
    chunkRow.querySelector('.ffp-label').appendChild(chunkValue);

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

    settingsWrap.append(chunkRow, minRow, pause.wrap, useAI.wrap, aiCheckpoints.wrap);

    const focus = buildFocus();

    const saveNote = el('div', 'ffp-save', '');
    body.append(summary, ask, settingsWrap, focus.wrap, saveNote);
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
      minLen,
      pause: pause.input,
      useAI: useAI.input,
      aiCheckpoints: aiCheckpoints.input,
      focusMaster: focus.master,
      focusComplete: focus.complete,
      focusCustom: focus.custom,
      focusLevels: focus.levels,
      focusPartsBox: focus.parts,
      focusParts: focus.partInputs,
      saveNote,
    };

    renderPower();
    setCollapsed(collapsed, { save: false });
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
    // The sliding sections size themselves from the live layout, so they can
    // only be measured once the panel is actually in the page.
    renderFocus();
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
    completeBeforeCustom = S.normaliseMode(settings.focusMode) === 'complete';
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
    renderPower();
    renderFocus();
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
