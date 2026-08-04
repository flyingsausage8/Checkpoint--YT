/**
 * Caption retrieval (Phase 2).
 *
 * YouTube gives no official way to read another creator's transcript, so we use
 * two independent unofficial routes and fall back between them. If one breaks
 * because YouTube changed something, the other usually still works.
 *
 *   Strategy B - "timedtext": ask the page for its caption track URLs and fetch
 *                the transcript directly. Fast and invisible to the user.
 *   Strategy A - "panel":     drive YouTube's own "Show transcript" UI and read
 *                the text off the page. Slower but very hard to break.
 *
 * Both return: [{ start: <seconds>, text: <string> }]
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

  // ---------------------------------------------------------------- strategy B

  function requestTracks(videoId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener('focusflow:tracks', onTracks);
        resolve([]);
      }, 4000);

      function onTracks(event) {
        if (event.detail?.videoId !== videoId) return;
        clearTimeout(timer);
        window.removeEventListener('focusflow:tracks', onTracks);
        resolve(event.detail.tracks || []);
      }

      window.addEventListener('focusflow:tracks', onTracks);
      window.dispatchEvent(
        new CustomEvent('focusflow:request-tracks', { detail: { videoId } })
      );
    });
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

  async function viaTimedText(videoId) {
    const track = pickTrack(await requestTracks(videoId));
    if (!track?.baseUrl) return null;

    // json3 is the format YouTube's own player asks for; the legacy XML format
    // is increasingly returned empty.
    const url = `${track.baseUrl}${track.baseUrl.includes('?') ? '&' : '?'}fmt=json3`;
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) return null;

    const body = await response.text();
    if (!body.trim()) return null;

    const cues = [];
    for (const event of JSON.parse(body).events || []) {
      const text = (event.segs || [])
        .map((s) => s.utf8)
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) cues.push({ start: (event.tStartMs || 0) / 1000, text });
    }
    return cues.length ? cues : null;
  }

  // ---------------------------------------------------------------- strategy A

  function findTranscriptButton() {
    const candidates = document.querySelectorAll(
      'button, tp-yt-paper-button, yt-button-shape button'
    );
    for (const el of candidates) {
      const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`;
      if (/transcript/i.test(label) && !/close/i.test(label)) return el;
    }
    return null;
  }

  function parseTimestamp(raw) {
    const parts = raw.trim().split(':').map(Number);
    if (parts.some(Number.isNaN)) return 0;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }

  async function viaPanel() {
    // The transcript button usually lives inside the collapsed description.
    if (!findTranscriptButton()) {
      document.querySelector('ytd-text-inline-expander #expand')?.click();
      await sleep(400);
    }

    const button = await waitFor(findTranscriptButton, { timeout: 3000 });
    if (!button) return null;

    const alreadyOpen = document.querySelector('ytd-transcript-segment-renderer');
    if (!alreadyOpen) button.click();

    const segments = await waitFor(() => {
      const found = document.querySelectorAll('ytd-transcript-segment-renderer');
      return found.length ? found : null;
    });
    if (!segments) return null;

    // Let virtualised rows settle so we capture the whole list.
    await sleep(500);

    const cues = [];
    for (const segment of document.querySelectorAll('ytd-transcript-segment-renderer')) {
      const stamp = segment.querySelector('.segment-timestamp')?.textContent;
      const text = segment.querySelector('.segment-text')?.textContent?.trim();
      if (stamp && text) cues.push({ start: parseTimestamp(stamp), text });
    }

    if (!alreadyOpen) button.click(); // leave the page as we found it

    return cues.length ? cues : null;
  }

  // ------------------------------------------------------------------- public

  async function fetchTranscript(videoId) {
    for (const [source, strategy] of [
      ['timedtext', () => viaTimedText(videoId)],
      ['panel', viaPanel],
    ]) {
      try {
        const cues = await strategy();
        if (cues) return { source, cues };
      } catch (error) {
        console.warn(`[FocusFlow] caption strategy "${source}" failed:`, error);
      }
    }
    return { source: 'none', cues: [] };
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

  return { fetchTranscript, textBetween };
})();
