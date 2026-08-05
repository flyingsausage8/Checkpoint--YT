/**
 * Runs in the PAGE's own JavaScript world (not the extension's isolated world),
 * which is the only place YouTube's internal player data is visible.
 *
 * Three jobs, all passive:
 *   1. Sniff `/youtubei/v1/player` responses to learn the caption track list.
 *   2. Sniff the player's OWN `/api/timedtext` requests. Those requests carry a
 *      valid PO token (`pot`/`potc`), which the extension cannot mint itself but
 *      YouTube now requires. Capturing the URL lets the isolated world replay it.
 *   3. Sniff caption RESPONSE bodies — `/youtubei/v1/get_transcript` (the full
 *      transcript in one payload, no virtualisation truncation) and any non-empty
 *      `/api/timedtext` json3 body — and cache the parsed cues directly, so no
 *      replay/round-trip is needed.
 *
 * It hands both to the extension via DOM CustomEvents and never touches playback.
 */
(() => {
  const CACHE = new Map(); // videoId -> caption track array
  const TIMEDTEXT = new Map(); // videoId (the `v` param) -> full pot-bearing URL
  const PANELCUES = new Map(); // videoId -> { cues:[{start,text}], endpoint }
  const LENGTHS = new Map(); // videoId -> real length in seconds (ads cannot skew it)

  function readTracks(playerResponse) {
    try {
      const details = playerResponse?.videoDetails;
      // Record the real length first. The <video> element reports an ad's
      // duration while a pre-roll plays, so this is the only value the
      // extension can trust when deciding where checkpoints belong.
      const length = Number(details?.lengthSeconds);
      if (details?.videoId && isFinite(length) && length > 0) {
        LENGTHS.set(details.videoId, length);
      }
      const tracks =
        playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!details?.videoId || !Array.isArray(tracks) || !tracks.length) return;
      CACHE.set(
        details.videoId,
        tracks.map((t) => ({
          baseUrl: t.baseUrl,
          languageCode: t.languageCode,
          kind: t.kind || '',
          name: t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode,
        }))
      );
    } catch (_) {
      /* malformed payload, ignore */
    }
  }

  // Remember the most recent full timedtext URL the player fetched, keyed by the
  // video id embedded in the URL's `v` param. Keeping every query parameter is
  // the whole point: `pot`/`potc`/`signature`/`expire` are what make it work.
  function cacheTimedText(rawUrl) {
    try {
      const u = new URL(rawUrl, location.href);
      if (!u.pathname.includes('/api/timedtext')) return;
      const v = u.searchParams.get('v');
      if (!v) return;
      TIMEDTEXT.set(v, u.href);
    } catch (_) {
      /* not a parseable URL, ignore */
    }
  }

  function currentVideoId() {
    try {
      const v = new URL(location.href).searchParams.get('v');
      if (v) return v;
    } catch (_) {}
    return window.ytInitialPlayerResponse?.videoDetails?.videoId || null;
  }

  function videoIdFromUrl(rawUrl) {
    try {
      return new URL(rawUrl, location.href).searchParams.get('v');
    } catch (_) {
      return null;
    }
  }

  // Parse a json3 caption body (from /api/timedtext) into [{start, text}].
  function parseJson3Cues(body) {
    if (!body || !body.trim()) return [];
    const cues = [];
    let data;
    try {
      data = JSON.parse(body);
    } catch (_) {
      return [];
    }
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

  // Defensive, path-independent walker for /youtubei/v1/get_transcript payloads.
  // YouTube reshuffles the wrapper objects often, so instead of following a fixed
  // path we recurse the whole tree looking for `transcriptSegmentRenderer` nodes.
  // Section headers use a different renderer and are simply ignored.
  function extractTranscriptSegments(root) {
    const out = [];
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (seen.has(node)) continue;
      seen.add(node);

      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
        continue;
      }

      const seg = node.transcriptSegmentRenderer;
      if (seg && typeof seg === 'object') {
        const startMs = Number(seg.startMs);
        const runs = seg.snippet?.runs || [];
        const text = runs
          .map((r) => r.text || '')
          .join('')
          .replace(/\s+/g, ' ')
          .trim();
        if (isFinite(startMs) && text) out.push({ start: startMs / 1000, text });
      }

      const keys = Object.keys(node);
      for (let i = keys.length - 1; i >= 0; i--) {
        const val = node[keys[i]];
        if (val && typeof val === 'object') stack.push(val);
      }
    }

    const byStart = new Map();
    for (const cue of out) if (!byStart.has(cue.start)) byStart.set(cue.start, cue.text);
    return [...byStart]
      .map(([start, text]) => ({ start, text }))
      .sort((a, b) => a.start - b.start);
  }

  // Keep the richest transcript we've captured for a video (get_transcript wins
  // when it yields more cues than a partial timedtext body).
  function storePanelCues(videoId, cues, endpoint) {
    if (!videoId || !cues || !cues.length) return;
    const existing = PANELCUES.get(videoId);
    if (!existing || cues.length > existing.cues.length) {
      PANELCUES.set(videoId, { cues, endpoint });
    }
  }

  // --- fetch() interception: player data + timedtext -------------------------
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (url.includes('/api/timedtext')) cacheTimedText(url);
    } catch (_) {}

    const result = originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (url.includes('/youtubei/v1/player')) {
        result
          .then((res) => res.clone().json())
          .then(readTracks)
          .catch(() => {});
      }
      if (url.includes('/youtubei/v1/get_transcript')) {
        result
          .then((res) => res.clone().json())
          .then((data) => storePanelCues(currentVideoId(), extractTranscriptSegments(data), 'get_transcript'))
          .catch(() => {});
      }
      if (url.includes('/api/timedtext')) {
        result
          .then((res) => res.clone().text())
          .then((body) =>
            storePanelCues(videoIdFromUrl(url) || currentVideoId(), parseJson3Cues(body), 'timedtext')
          )
          .catch(() => {});
      }
    } catch (_) {}
    return result;
  };

  // --- XMLHttpRequest interception: YouTube uses XHR for some timedtext calls
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url, ...rest) {
      try {
        this.__ff_url = url;
      } catch (_) {}
      return originalOpen.call(this, method, url, ...rest);
    };

    XHR.prototype.send = function (...args) {
      try {
        const url = this.__ff_url || '';
        if (typeof url === 'string' && url.includes('/api/timedtext')) {
          cacheTimedText(url);
        }
        if (
          typeof url === 'string' &&
          (url.includes('/api/timedtext') || url.includes('/youtubei/v1/get_transcript'))
        ) {
          this.addEventListener('load', function () {
            try {
              const u = this.__ff_url || '';
              let raw = '';
              try {
                raw = this.responseText;
              } catch (_) {
                raw = typeof this.response === 'string' ? this.response : '';
              }
              if (!raw) return;
              if (u.includes('/youtubei/v1/get_transcript')) {
                storePanelCues(
                  currentVideoId(),
                  extractTranscriptSegments(JSON.parse(raw)),
                  'get_transcript'
                );
              } else if (u.includes('/api/timedtext')) {
                storePanelCues(
                  videoIdFromUrl(u) || currentVideoId(),
                  parseJson3Cues(raw),
                  'timedtext'
                );
              }
            } catch (_) {}
          });
        }
      } catch (_) {}
      return originalSend.apply(this, args);
    };
  }

  window.addEventListener('focusflow:request-tracks', (event) => {
    const videoId = event.detail?.videoId;
    if (!CACHE.has(videoId) || !LENGTHS.has(videoId)) {
      readTracks(window.ytInitialPlayerResponse);
    }

    window.dispatchEvent(
      new CustomEvent('focusflow:tracks', {
        detail: {
          videoId,
          tracks: CACHE.get(videoId) || [],
          timedTextUrl: TIMEDTEXT.get(videoId) || null,
          panelCues: PANELCUES.get(videoId)?.cues || null,
          panelCuesSource: PANELCUES.get(videoId)?.endpoint || null,
          lengthSeconds: LENGTHS.get(videoId) || null,
        },
      })
    );
  });

  // Exposed only for unit-testing the pure walker in Node (page world, harmless).
  try {
    window.__FocusFlow_extractTranscriptSegments = extractTranscriptSegments;
  } catch (_) {}
})();
