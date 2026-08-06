/**
 * Focus mode: turns the user's settings into classes on <html>.
 *
 * All the actual hiding is in focus.css. This file only decides which classes
 * belong on the page, which keeps the "what does complete focus mean" question
 * in one place (src/shared/settings.js) and makes turning focus mode off a
 * genuinely complete undo — no YouTube nodes are ever removed or edited.
 *
 * Runs at document_start, before YouTube has painted anything, so distractions
 * are never visible for a moment on the way in. The storage read is async but
 * takes a millisecond or two, while YouTube's feed takes hundreds, so the class
 * is in place long before there is anything to hide.
 *
 * There is deliberately no re-apply on navigation: <html> survives YouTube's
 * SPA routing, so the classes set here stay correct for the whole visit.
 */
window.FocusFlow = window.FocusFlow || {};

window.FocusFlow.focus = (() => {
  const CLASS_PREFIX = 'ff-hide-';
  const settingsApi = () => window.FocusFlowSettings;

  let started = false;

  function apply(settings) {
    const api = settingsApi();
    if (!api) return;
    const wanted = new Set(api.hiddenParts(settings));
    const root = document.documentElement;
    if (!root) return;

    for (const id of api.ALL_PART_IDS) {
      root.classList.toggle(`${CLASS_PREFIX}${id}`, wanted.has(id));
    }
  }

  async function refresh() {
    try {
      apply(await settingsApi().load());
    } catch (error) {
      // A failed read must not leave the page half-hidden. Showing everything is
      // the safe failure: an unexpectedly busy YouTube is recoverable, a
      // permanently blank one looks like the extension broke the site.
      clear();
      console.warn('[FocusFlow] could not read focus settings', error);
    }
  }

  function clear() {
    const api = settingsApi();
    const root = document.documentElement;
    if (!api || !root) return;
    for (const id of api.ALL_PART_IDS) root.classList.remove(`${CLASS_PREFIX}${id}`);
  }

  function start() {
    if (started) return;
    started = true;
    refresh();
    chrome.storage.onChanged.addListener((changes, area) => {
      // Sync carries the settings themselves; local carries which account is
      // signed in, and switching account changes which settings object applies.
      if (area === 'sync' || (area === 'local' && changes.activeAccount)) refresh();
    });
  }

  start();

  // Exposed so the panel can show the result of a toggle the instant it is
  // clicked, rather than waiting for its debounced write to come back around
  // through the storage listener.
  return { apply, refresh, clear };
})();
