/**
 * One place that knows what a FocusFlow settings object looks like and where it
 * is stored.
 *
 * Settings live in two shapes: signed out they are top-level `chrome.storage.sync`
 * keys, signed in they are a single `account:<sub>:settings` object so two people
 * sharing a computer don't share preferences. That rule used to be copy-pasted
 * into the popup, the content script and the panel, and any copy drifting out of
 * step would silently give one person two different sets of settings on one
 * machine. New code should use this module instead of writing a fourth copy.
 *
 * Loaded as a plain content script (no ES modules in content scripts), so it
 * hangs off `window` in the extension's isolated world.
 */
window.FocusFlowSettings = (() => {
  const DEFAULT_PROXY_URL = 'https://func-checkpoint-yt-pb5kh8.azurewebsites.net/api/generate';

  /**
   * The parts of YouTube focus mode can hide.
   *
   * `standard` marks the ones hidden by the plain on state — the everyday
   * distractions almost everyone wants gone. The rest only go when the user
   * asks for complete focus, because they are either occasionally useful
   * (live chat, the left menu) or only appear at the end of a video.
   */
  const FOCUS_PARTS = [
    { id: 'homeFeed', label: 'Home page video wall', hint: 'Leaves the search bar so you can go straight to what you came for.', standard: true },
    { id: 'related', label: 'Recommended videos beside the player', standard: true },
    { id: 'comments', label: 'Comments', standard: true },
    { id: 'shorts', label: 'Shorts', hint: 'Shelves on the home page, in search and in the menu.', standard: true },
    { id: 'endScreen', label: 'Suggestions at the end of a video', hint: 'Also the ones that appear over a paused video.', standard: false },
    { id: 'liveChat', label: 'Live chat', standard: false },
    { id: 'guide', label: 'The menu down the left side', standard: false },
  ];

  const ALL_PART_IDS = FOCUS_PARTS.map((part) => part.id);
  const STANDARD_PART_IDS = FOCUS_PARTS.filter((part) => part.standard).map((part) => part.id);

  const FOCUS_MODES = ['off', 'standard', 'complete', 'custom'];

  const DEFAULTS = {
    enabled: true,
    chunkMinutes: 3,
    minVideoMinutes: 4,
    autoPause: true,
    useAI: true,
    aiCheckpoints: true,
    proxyUrl: DEFAULT_PROXY_URL,
    // Distraction hiding is on by default: the point of the extension is to help
    // someone finish the video they chose, and the page is what pulls them away.
    focusMode: 'standard',
    // Only read when focusMode is 'custom'. A comma-separated list rather than
    // one storage key per part, so adding a part later doesn't mean editing the
    // sync allowlist in the extension AND the schema in the backend again.
    focusParts: STANDARD_PART_IDS.join(','),
  };

  function normaliseMode(mode) {
    return FOCUS_MODES.includes(mode) ? mode : DEFAULTS.focusMode;
  }

  function parseParts(value) {
    if (typeof value !== 'string') return [];
    // Unknown ids are dropped rather than kept: they can only come from a newer
    // version of the extension on another device, and a stale class name would
    // hide nothing anyway.
    return value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => ALL_PART_IDS.includes(part));
  }

  /**
   * The parts that should actually be hidden right now, whatever route the user
   * took to get there. Everything that hides things reads this, so the three
   * modes can never disagree about what "complete focus" means.
   */
  function hiddenParts(settings) {
    const mode = normaliseMode(settings?.focusMode);
    if (mode === 'off') return [];
    if (mode === 'complete') return [...ALL_PART_IDS];
    if (mode === 'custom') return parseParts(settings?.focusParts);
    return [...STANDARD_PART_IDS];
  }

  async function activeAccountSub() {
    const { activeAccount } = await chrome.storage.local.get({ activeAccount: null });
    return activeAccount;
  }

  async function load() {
    const sub = await activeAccountSub();
    if (sub) {
      const key = `account:${sub}:settings`;
      const stored = await chrome.storage.sync.get({ [key]: null });
      if (stored[key]) return { ...DEFAULTS, ...stored[key] };
    }
    return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  }

  async function persist(next) {
    const sub = await activeAccountSub();
    if (sub) {
      await chrome.storage.sync.set({ [`account:${sub}:settings`]: next });
    } else {
      await chrome.storage.sync.set(next);
    }
  }

  return {
    DEFAULTS,
    DEFAULT_PROXY_URL,
    FOCUS_PARTS,
    FOCUS_MODES,
    ALL_PART_IDS,
    STANDARD_PART_IDS,
    normaliseMode,
    parseParts,
    hiddenParts,
    load,
    persist,
  };
})();
