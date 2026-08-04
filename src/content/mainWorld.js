/**
 * Runs in the PAGE's own JavaScript world (not the extension's isolated world),
 * which is the only place YouTube's internal player data is visible.
 *
 * Its single job: find the list of caption tracks for a video and hand it to the
 * extension via a DOM event. It never touches playback.
 */
(() => {
  const CACHE = new Map(); // videoId -> caption track array

  function readTracks(playerResponse) {
    try {
      const details = playerResponse?.videoDetails;
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

  // YouTube requests fresh player data on every in-page navigation. Sniffing the
  // response keeps our caption list in sync without reloading the page.
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const result = originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (url.includes('/youtubei/v1/player')) {
        result
          .then((res) => res.clone().json())
          .then(readTracks)
          .catch(() => {});
      }
    } catch (_) {}
    return result;
  };

  window.addEventListener('focusflow:request-tracks', (event) => {
    const videoId = event.detail?.videoId;
    if (!CACHE.has(videoId)) readTracks(window.ytInitialPlayerResponse);

    window.dispatchEvent(
      new CustomEvent('focusflow:tracks', {
        detail: { videoId, tracks: CACHE.get(videoId) || [] },
      })
    );
  });
})();
