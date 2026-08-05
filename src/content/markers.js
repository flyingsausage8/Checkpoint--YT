/**
 * Checkpoint dots drawn onto YouTube's own progress bar.
 *
 * Why the dots carry their meaning in *fill state* rather than colour: the bar
 * underneath is not a fixed colour. It is red normally, yellow during an ad,
 * blue during an audio-description bumper, light grey where buffered, dark grey
 * where unwatched, and there is even a rainbow easter egg. Nothing we tint can
 * be relied on to read the same way in all of those, so "hollow = still ahead
 * of you, solid = dealt with" is the signal, and colour is only ever an accent.
 */
window.FocusFlow = window.FocusFlow || {};

window.FocusFlow.markers = (() => {
  // z-index 41 puts us above the chapter segments and the "most replayed"
  // heatmap (32/40) but below the scrubber (43), so the dots never cover the
  // handle showing where the viewer actually is.
  const LAYER_CLASS = 'ff-marker-layer';
  const RECHECK_MS = 1000;

  let layer = null;
  let dots = [];
  let checkpoints = [];
  let duration = 0;
  let video = null;
  let currentIndex = -1;
  let recheckTimer = null;

  function progressBar() {
    return document.querySelector('#movie_player .ytp-progress-bar');
  }

  /**
   * Detect ads by duration, not by YouTube's classes or ad overlay elements.
   *
   * Measured on a real watch page: `#movie_player` keeps `ad-showing` and
   * `ad-interrupting` long after the ad has finished, and `.ytp-ad-player-overlay`
   * and even the skip button still report layout boxes during ordinary playback.
   * Every DOM signal is stale. The media element's own duration is not: while an
   * ad plays it reports the *ad's* length, and that mismatch is precisely the
   * condition under which our dots would point at the wrong timeline.
   */
  function isOffPlan() {
    const playing = Number(video?.duration);
    if (!Number.isFinite(playing) || playing <= 0) return true;
    return Math.abs(playing - duration) > 2;
  }

  /**
   * While an ad plays the bar is showing the ad's timeline, so a dot at "60%"
   * would point at a moment inside the advert. Hide the layer until the real
   * video is back.
   */
  function syncAdState() {
    if (!layer) return;
    layer.dataset.ffHidden = isOffPlan() ? '1' : '0';
  }

  function buildDots() {
    dots = checkpoints.map((seconds, index) => {
      const dot = document.createElement('div');
      dot.className = 'ff-marker';
      dot.style.left = `${Math.min(100, Math.max(0, (seconds / duration) * 100))}%`;
      dot.dataset.index = String(index);
      return dot;
    });
  }

  function mount() {
    const bar = progressBar();
    if (!bar) return false;

    layer = document.createElement('div');
    layer.className = LAYER_CLASS;
    dots.forEach((dot) => layer.appendChild(dot));
    bar.appendChild(layer);
    syncAdState();
    return true;
  }

  /**
   * YouTube rebuilds parts of the player on navigation, and on switching to
   * theatre/fullscreen/miniplayer, which can drop our layer. Cheap poll rather
   * than a subtree observer: the progress bar mutates constantly during
   * playback, so an observer there would fire far more often than this.
   */
  function startRecheck() {
    stopRecheck();
    recheckTimer = setInterval(() => {
      if (!layer) return;
      if (!layer.isConnected) {
        const bar = progressBar();
        if (bar) bar.appendChild(layer);
      }
      syncAdState();
    }, RECHECK_MS);
  }

  function stopRecheck() {
    if (recheckTimer) clearInterval(recheckTimer);
    recheckTimer = null;
  }

  function watchAds() {
    // Deliberately no MutationObserver: every DOM ad signal YouTube exposes
    // proved stale (see isOffPlan). The duration check runs on the recheck
    // timer and on every timeupdate instead, which is both cheaper and correct.
  }

  /**
   * @param {{checkpoints: number[], durationSeconds: number, video: HTMLVideoElement}} plan
   */
  function attach(plan) {
    destroy();

    const times = (plan?.checkpoints || []).filter((t) => Number.isFinite(t) && t > 0);
    const total = Number(plan?.durationSeconds);
    if (!times.length || !Number.isFinite(total) || total <= 0) return false;

    checkpoints = times;
    duration = total;
    video = plan.video || document.querySelector('#movie_player video');
    currentIndex = -1;

    buildDots();
    if (!mount()) {
      // The player chrome may not exist yet on a cold load. Keep the dots we
      // built and let the recheck timer place them once it appears.
      layer = document.createElement('div');
      layer.className = LAYER_CLASS;
      dots.forEach((dot) => layer.appendChild(dot));
    }
    watchAds();
    startRecheck();
    return true;
  }

  /** Fill a dot in, with a short pop so the change is noticeable. */
  function markDone(index) {
    const dot = dots[index];
    if (!dot || dot.classList.contains('ff-marker-done')) return;
    dot.classList.add('ff-marker-done', 'ff-marker-pop');

    // Clear the animation class on a timer as well as on animationend. The
    // event is not guaranteed: it never fires under prefers-reduced-motion
    // (the animation is disabled), and it was observed not firing in a
    // background tab, which would leave the class stuck on the element.
    const clear = () => dot.classList.remove('ff-marker-pop');
    dot.addEventListener('animationend', clear, { once: true });
    setTimeout(clear, 700);
  }

  /** Hollow a dot back out — used when the viewer chooses to rewatch. */
  function markPending(index) {
    dots[index]?.classList.remove('ff-marker-done', 'ff-marker-pop');
  }

  /**
   * Accent the next checkpoint the viewer is heading towards. Cyan is ours
   * alone: YouTube never paints the bar this colour, so it reads as "FocusFlow"
   * rather than as part of the player.
   */
  function setCurrentTime(seconds) {
    syncAdState();
    if (!dots.length) return;
    const next = checkpoints.findIndex(
      (time, i) => seconds < time && !dots[i].classList.contains('ff-marker-done')
    );
    if (next === currentIndex) return;
    if (currentIndex >= 0) dots[currentIndex]?.classList.remove('ff-marker-next');
    if (next >= 0) dots[next].classList.add('ff-marker-next');
    currentIndex = next;
  }

  function destroy() {
    stopRecheck();
    layer?.remove();
    layer = null;
    dots = [];
    checkpoints = [];
    duration = 0;
    video = null;
    currentIndex = -1;
  }

  return { attach, markDone, markPending, setCurrentTime, destroy };
})();
