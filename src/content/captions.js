/**
 * Caption retrieval (Phase 2).
 *
 * YouTube gives no official way to read another creator's transcript, so we use
 * several independent unofficial routes and fall back between them. If one breaks
 * because YouTube changed something, another usually still works.
 *
 *   Strategy 0  - "intercepted":   cues captured straight from a caption RESPONSE
 *                 the player already made (`/youtubei/v1/get_transcript` — the
 *                 complete transcript in one payload — or a non-empty json3
 *                 `/api/timedtext` body). Instant, no network, no truncation.
 *   Strategy B  - "timedtext":     fetch the advertised caption track URL. Fast,
 *                 but YouTube increasingly answers 200 with an EMPTY body unless
 *                 the request carries a PO token it will not give us.
 *   Strategy B' - "timedtext-pot": replay the pot-bearing timedtext URL that the
 *                 player itself fetched (captured in mainWorld.js). Works only if
 *                 the player has actually requested captions this session.
 *   Strategy A  - "panel":         drive YouTube's own "Show transcript" UI. This
 *                 also triggers get_transcript (captured above); DOM scraping of
 *                 the virtualised list is only the last resort.
 *
 * All return: [{ start: <seconds>, text: <string> }]
 */
window.FocusFlow = window.FocusFlow || {};

window.FocusFlow.captions = (() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function waitFor(getter, { timeout = 6000, interval = 150 } = {}) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeout;
      (function poll() {
        const value = getter();
        if (value) return resolve(value);
        if (Date.now() > deadline) return resolve(null);
        setTimeout(poll, interval);
      })();
    });
  }

  // -------------------------------------------------------------- pure helpers

  /** Parse YouTube's json3 caption body into [{start, text}]. */
  function parseJson3(body) {
    const cues = [];
    const data = JSON.parse(body);
    for (const event of data.events || []) {
      const text = (event.segs || [])
        .map((s) => s.utf8 || '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) cues.push({ start: (event.tStartMs || 0) / 1000, text });
    }
    return cues;
  }

  /** Turn "1:23" / "1:02:03" into seconds. */
  function parseTimestamp(raw) {
    const parts = String(raw).trim().split(':').map(Number);
    if (!parts.length || parts.some(Number.isNaN)) return 0;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }

  /** Force a timedtext URL to request json3, replacing any existing fmt param. */
  function rewriteFmtJson3(rawUrl) {
    const [base, query = ''] = String(rawUrl).split('?');
    const params = query.split('&').filter((p) => p && !/^fmt=/.test(p));
    params.push('fmt=json3');
    return `${base}?${params.join('&')}`;
  }

  /** Drop cues that repeat a timestamp we've already seen (virtualised list). */
  function dedupCues(cues) {
    const seen = new Set();
    const out = [];
    for (const cue of cues) {
      const key = `${cue.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cue);
    }
    return out.sort((a, b) => a.start - b.start);
  }

  /** Heuristic: the transcript stops well before the video ends => truncated. */
  function looksTruncated(cues, durationSeconds) {
    if (!cues.length) return false;
    if (!durationSeconds || !isFinite(durationSeconds)) return false;
    const lastStart = cues[cues.length - 1].start;
    return lastStart < durationSeconds * 0.7;
  }

  function videoDuration() {
    const seconds = document.querySelector('video')?.duration;
    return isFinite(seconds) && seconds > 0 ? seconds : null;
  }

  // ---------------------------------------------------------------- strategy B

  function requestTrackInfo(videoId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener('focusflow:tracks', onTracks);
        resolve({ tracks: [], timedTextUrl: null });
      }, 4000);

      function onTracks(event) {
        if (event.detail?.videoId !== videoId) return;
        clearTimeout(timer);
        window.removeEventListener('focusflow:tracks', onTracks);
        resolve({
          tracks: event.detail.tracks || [],
          timedTextUrl: event.detail.timedTextUrl || null,
          panelCues: event.detail.panelCues || null,
          panelCuesSource: event.detail.panelCuesSource || null,
        });
      }

      window.addEventListener('focusflow:tracks', onTracks);
      window.dispatchEvent(
        new CustomEvent('focusflow:request-tracks', { detail: { videoId } })
      );
    });
  }

  // Poll the page world until a captured transcript payload (get_transcript or a
  // non-empty timedtext body) arrives. Opening the panel triggers get_transcript,
  // so this is how the panel strategy gets the complete, untruncated transcript.
  async function pollInterceptedCues(videoId, timeout = 2500) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const info = await requestTrackInfo(videoId);
      if (info.panelCues?.length) {
        return { cues: info.panelCues, source: info.panelCuesSource };
      }
      await sleep(300);
    }
    return null;
  }

  // ------------------------------------------------------- strategy: intercepted

  // Cues captured directly from a caption RESPONSE the player already made
  // (get_transcript panel payload or a non-empty timedtext body). Best case:
  // instant, no network, no PO token, no virtualised-list truncation.
  async function viaIntercepted(info) {
    if (!info.panelCues?.length) {
      console.warn(
        '[FocusFlow] intercepted: no captured transcript payload available yet.'
      );
      return null;
    }
    return {
      cues: dedupCues(info.panelCues),
      interceptedFrom: info.panelCuesSource || 'unknown',
    };
  }

  function pickTrack(tracks, preferred = 'en') {
    if (!tracks.length) return null;
    return (
      tracks.find((t) => t.languageCode === preferred && !t.kind) ||
      tracks.find((t) => t.languageCode === preferred) ||
      tracks.find((t) => t.languageCode.startsWith(preferred.slice(0, 2))) ||
      tracks[0]
    );
  }

  // Strategy B (advertised baseUrl). Increasingly returns HTTP 200 with an empty
  // body because YouTube now requires a PO token; we detect that and give up.
  async function viaTimedText(info) {
    const track = pickTrack(info.tracks);
    if (!info.tracks.length) {
      console.warn(
        '[FocusFlow] timedtext: no caption tracks advertised for this video.'
      );
      return null;
    }
    if (!track?.baseUrl) {
      console.warn('[FocusFlow] timedtext: caption track has no baseUrl.');
      return null;
    }

    const url = rewriteFmtJson3(track.baseUrl);
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) {
      console.warn(`[FocusFlow] timedtext: HTTP ${response.status} for baseUrl.`);
      return null;
    }

    const body = await response.text();
    if (!body.trim()) {
      console.warn(
        '[FocusFlow] timedtext: 200 with EMPTY body (PO-token required) — ' +
          'falling through to the captured pot URL / panel.'
      );
      return null;
    }

    const cues = parseJson3(body);
    if (!cues.length) {
      console.warn('[FocusFlow] timedtext: body parsed but held no cues.');
      return null;
    }
    return { cues, trackKind: track.kind || '' };
  }

  // -------------------------------------------------------- strategy B (pot)

  // Replay the player's own timedtext request, which carried a valid PO token.
  async function viaTimedTextPot(info, videoId) {
    if (!info.timedTextUrl) {
      console.warn(
        `[FocusFlow] timedtext-pot: no pot-bearing URL captured for ${videoId} ` +
          '(the player has not requested captions in this session).'
      );
      return null;
    }

    const url = rewriteFmtJson3(info.timedTextUrl);
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) {
      console.warn(`[FocusFlow] timedtext-pot: HTTP ${response.status}.`);
      return null;
    }

    const body = await response.text();
    if (!body.trim()) {
      console.warn('[FocusFlow] timedtext-pot: 200 with EMPTY body — giving up.');
      return null;
    }

    const cues = parseJson3(body);
    if (!cues.length) {
      console.warn('[FocusFlow] timedtext-pot: body parsed but held no cues.');
      return null;
    }
    const track = pickTrack(info.tracks);
    return { cues, trackKind: track?.kind || '' };
  }

  // ---------------------------------------------------------------- strategy A

  function findTranscriptButton() {
    const candidates = document.querySelectorAll(
      'button, tp-yt-paper-button, yt-button-shape button, ytd-button-renderer, ' +
        'yt-button-shape, [role="button"], [aria-label]'
    );
    for (const el of candidates) {
      const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`;
      if (/transcript/i.test(label) && !/close|hide/i.test(label)) return el;
    }
    return null;
  }

  // Open the collapsed description (in whatever form today's layout uses) so the
  // "Show transcript" control becomes reachable.
  async function expandDescription() {
    const expanders = [
      'ytd-text-inline-expander #expand',
      'ytd-text-inline-expander tp-yt-paper-button#expand',
      'tp-yt-paper-button#expand',
      '#description #expand',
      '#expand',
    ];
    for (const selector of expanders) {
      const el = document.querySelector(selector);
      if (el) {
        el.click();
        await sleep(400);
        if (findTranscriptButton()) return;
      }
    }
  }

  // Find the scroll container that holds the virtualised transcript rows.
  function transcriptScroller() {
    const anySegment = document.querySelector('ytd-transcript-segment-renderer');
    if (!anySegment) return null;
    let node = anySegment.parentElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      const scrollable = /(auto|scroll)/.test(style.overflowY);
      if (scrollable && node.scrollHeight > node.clientHeight + 4) return node;
      node = node.parentElement;
    }
    return (
      document.querySelector('ytd-transcript-segment-list-renderer #segments-container') ||
      document.querySelector('ytd-transcript-segment-list-renderer')
    );
  }

  function collectVisibleSegments() {
    const cues = [];
    for (const segment of document.querySelectorAll('ytd-transcript-segment-renderer')) {
      const stamp = segment.querySelector('.segment-timestamp')?.textContent;
      const text = segment.querySelector('.segment-text')?.textContent?.trim();
      if (stamp && text) cues.push({ start: parseTimestamp(stamp), text });
    }
    return cues;
  }

  // Scroll the virtualised list to the bottom, harvesting rows as they render.
  async function harvestSegments() {
    const scroller = transcriptScroller();
    const collected = new Map(); // start -> text

    function absorb() {
      for (const cue of collectVisibleSegments()) {
        if (!collected.has(cue.start)) collected.set(cue.start, cue.text);
      }
    }

    absorb();
    if (!scroller) {
      // Non-scrolling layout: everything we can see is all there is.
      return [...collected].map(([start, text]) => ({ start, text }));
    }

    let lastCount = -1;
    let stable = 0;
    for (let i = 0; i < 60; i++) {
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(180);
      absorb();
      if (collected.size === lastCount) {
        if (++stable >= 3) break; // no new rows across several scrolls
      } else {
        stable = 0;
        lastCount = collected.size;
      }
    }

    return [...collected].map(([start, text]) => ({ start, text }));
  }

  async function viaPanel(videoId) {
    if (!findTranscriptButton()) await expandDescription();

    const button = await waitFor(findTranscriptButton, { timeout: 4000 });
    if (!button) {
      console.warn(
        '[FocusFlow] panel: "Show transcript" button not found on this layout.'
      );
      return null;
    }

    const alreadyOpen = document.querySelector('ytd-transcript-segment-renderer');
    if (!alreadyOpen) button.click();

    // Opening the panel makes YouTube call /youtubei/v1/get_transcript, which the
    // page-world interceptor captures in full. Prefer that over DOM scraping.
    const intercepted = await pollInterceptedCues(videoId, 2500);
    if (intercepted?.cues?.length) {
      if (!alreadyOpen) button.click();
      const cues = dedupCues(intercepted.cues);
      return { cues, viaIntercept: intercepted.source || 'get_transcript' };
    }

    const segments = await waitFor(
      () => {
        const found = document.querySelectorAll('ytd-transcript-segment-renderer');
        return found.length ? found : null;
      },
      { timeout: 8000 }
    );
    if (!segments) {
      if (!alreadyOpen) button.click();
      console.warn(
        '[FocusFlow] panel: transcript opened but no segments rendered.'
      );
      return null;
    }

    // Fallback: scrape and scroll the virtualised DOM list.
    const cues = dedupCues(await harvestSegments());

    if (!alreadyOpen) button.click(); // leave the page as we found it

    if (!cues.length) {
      console.warn('[FocusFlow] panel: segments present but none had text.');
      return null;
    }

    const truncated = looksTruncated(cues, videoDuration());
    if (truncated) {
      console.warn(
        `[FocusFlow] panel: transcript may be TRUNCATED — last cue at ` +
          `${Math.round(cues[cues.length - 1].start)}s of a ` +
          `${Math.round(videoDuration())}s video (${cues.length} cues).`
      );
    }
    return { cues, truncated };
  }

  // ------------------------------------------------------------------- public

  async function fetchTranscript(videoId) {
    const info = await requestTrackInfo(videoId);
    const strategies = [
      ['intercepted', () => viaIntercepted(info)],
      ['timedtext-pot', () => viaTimedTextPot(info, videoId)],
      ['timedtext', () => viaTimedText(info)],
      ['panel', () => viaPanel(videoId)],
    ];

    for (const [source, strategy] of strategies) {
      try {
        const result = await strategy();
        if (result?.cues?.length) {
          return {
            source,
            cues: result.cues,
            truncated: result.truncated || false,
            trackKind: result.trackKind,
          };
        }
      } catch (error) {
        console.warn(`[FocusFlow] caption strategy "${source}" threw:`, error);
      }
    }

    console.warn(
      `[FocusFlow] no transcript for ${videoId}: all strategies failed. Run ` +
        `window.FocusFlow.captions.diagnose('${videoId}') to see why.`
    );
    return { source: 'none', cues: [] };
  }

  /**
   * User-facing debug helper. Reports what each strategy saw so the repo owner
   * can diagnose future breakage from the browser console.
   */
  async function diagnose(videoId) {
    const report = {
      videoId,
      videoDuration: videoDuration(),
      attempted: [],
      tracksAdvertised: [],
      potUrlCaptured: false,
      interceptedAvailable: false,
      interceptedFrom: null,
      interceptedCueCount: 0,
      interceptedRange: null,
      strategies: {},
    };

    const info = await requestTrackInfo(videoId);
    report.tracksAdvertised = info.tracks.map((t) => ({
      languageCode: t.languageCode,
      kind: t.kind || '',
      name: t.name,
    }));
    report.potUrlCaptured = Boolean(info.timedTextUrl);
    if (info.panelCues?.length) {
      report.interceptedAvailable = true;
      report.interceptedFrom = info.panelCuesSource || 'unknown';
      report.interceptedCueCount = info.panelCues.length;
      report.interceptedRange = {
        firstStart: info.panelCues[0].start,
        lastStart: info.panelCues[info.panelCues.length - 1].start,
      };
    }

    async function record(name, fn) {
      report.attempted.push(name);
      try {
        const result = await fn();
        const cues = result?.cues || [];
        report.strategies[name] = {
          ok: cues.length > 0,
          cueCount: cues.length,
          totalChars: cues.reduce((n, c) => n + c.text.length, 0),
          firstStart: cues.length ? cues[0].start : null,
          lastStart: cues.length ? cues[cues.length - 1].start : null,
          truncated: result?.truncated || false,
        };
      } catch (error) {
        report.strategies[name] = { ok: false, error: String(error) };
      }
    }

    await record('intercepted', () => viaIntercepted(info));
    await record('timedtext-pot', () => viaTimedTextPot(info, videoId));
    await record('timedtext', () => viaTimedText(info));
    await record('panel', () => viaPanel(videoId));
    return report;
  }

  /** Returns the transcript text spoken between two timestamps. */
  function textBetween(cues, fromSeconds, toSeconds) {
    return cues
      .filter((cue) => cue.start >= fromSeconds && cue.start < toSeconds)
      .map((cue) => cue.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return {
    fetchTranscript,
    textBetween,
    diagnose,
    // Exposed for unit testing of pure logic; not part of the public contract.
    _parseJson3: parseJson3,
    _parseTimestamp: parseTimestamp,
    _rewriteFmtJson3: rewriteFmtJson3,
    _dedupCues: dedupCues,
    _looksTruncated: looksTruncated,
  };
})();
