(() => {
  const DEFAULT_PROXY_URL = 'https://func-checkpoint-yt-pb5kh8.azurewebsites.net/api/generate';
  const AI_PROXY_ENABLED_IN_THIS_BUILD = true;
  // The shared module is the only definition of what a setting is and what it
  // defaults to. Keeping a second copy here is what let the new section-length
  // keys reach the panel but never the planner.
  const DEFAULT_SETTINGS = window.FocusFlowSettings.DEFAULTS;
  const END_BUFFER_SECONDS = 30;
  const MIN_AI_WORDS = 100;
  // Kept below the backend's per-request transcript budget so one section can
  // never be too large to ask a question about on its own.
  const MAX_CHAPTER_CHARS = 8000;
  const MAX_QUESTION_CACHE_VIDEOS = 50;
  const TRACE_ENABLED = true;
  const transcriptCache = new Map();
  const questionCache = new Map();
  const sectionCache = new Map();

  let state = null;
  let lastKnownVideoId = currentVideoId();
  let navTimer = null;

  const log = (...args) => console.warn('[FocusFlow]', ...args);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Issue #5: trace the five setup steps in the page console the user is already
  // watching, so the AI pipeline is visible without opening the worker console.
  const trace = (step, message, data) => {
    if (!TRACE_ENABLED) return;
    console.log(
      '%c[FocusFlow] STEP ' + step + '/5%c ' + message,
      'background:#2d6cdf;color:white;padding:2px 6px;border-radius:3px',
      '',
      data ?? ''
    );
  };

  const traceWarn = (step, message) =>
    console.warn('[FocusFlow] STEP ' + step + '/5 FAILED - ' + message);

  // Turn an internal reason code into plain English, reusing the shared map in
  // ai.js so failures read the same everywhere.
  function describeReason(code) {
    if (window.FocusFlow?.ai?.describeError) return window.FocusFlow.ai.describeError(code);
    return String(code || 'unknown error');
  }

  // Bug 1: STEP 2 must be logged when the request is dispatched, not when it
  // resolves ~25s later. This fires synchronously from ai.js, once per window.
  function traceRequestSent(endpoint, info) {
    trace(2, 'API request sent to Azure', {
      endpoint,
      mode: info.mode,
      window: info.totalWindows > 1 ? `${info.windowIndex}/${info.totalWindows}` : `1/${info.totalWindows || 1}`,
      chars: info.chars,
    });
  }

  // STEP 3 and STEP 4 stay after the response returns, reading the diagnostics
  // the background worker relayed from the backend.
  function traceResponseSteps(info, returnedCount, roundTripMs) {
    if (info?.diagnostics && info.diagnostics.deployment) {
      trace(3, 'Model received transcript and instructions', info.diagnostics);
    } else {
      traceWarn(3, 'backend returned no model diagnostics');
    }
    trace(4, 'Model returned questions', { returned: returnedCount, roundTripMs });
  }

  // Bug 1: a heartbeat so a long request never looks like a hang. Logs every
  // 10s until cleared in the caller's finally.
  function startHeartbeat() {
    let elapsed = 0;
    return setInterval(() => {
      elapsed += 10;
      console.log(`[FocusFlow] STEP 3/5 waiting on Azure... ${elapsed}s`);
    }, 10000);
  }

  // Mirrors background.endpointFromBase so STEP 2 can name the real endpoint at
  // dispatch time, before the worker's response (which carries it) comes back.
  function resolveEndpoint(proxyUrl) {
    const url = String(proxyUrl || DEFAULT_PROXY_URL).trim().replace(/\/+$/, '');
    return url.endsWith('/generate') ? url : `${url}/api/generate`;
  }

  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(Number.isFinite(Number(seconds)) ? Number(seconds) : 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = String(total % 60).padStart(2, '0');
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${rest}`;
    return `${minutes}:${rest}`;
  }

  function currentVideoId() {
    if (location.pathname !== '/watch') return null;
    return new URLSearchParams(location.search).get('v');
  }

  function storageGet(area, keys) {
    return new Promise((resolve) => chrome.storage[area].get(keys, resolve));
  }

  function storageSet(area, value) {
    return new Promise((resolve) => chrome.storage[area].set(value, resolve));
  }

  function storageRemove(area, keys) {
    return new Promise((resolve) => chrome.storage[area].remove(keys, resolve));
  }

  async function getSettings() {
    // Settings are per-account once someone signs in. We look up the active
    // account (kept in local storage by the auth module) and, if there is one,
    // read that account's namespaced settings from sync. Signed-out use keeps
    // reading the original top-level keys, so anonymous viewing is unchanged.
    const { activeAccount } = await storageGet('local', { activeAccount: null });
    let saved;
    if (activeAccount) {
      const key = `account:${activeAccount}:settings`;
      const namespaced = await storageGet('sync', { [key]: null });
      // First sign-in has no saved settings yet, so fall back to the anonymous
      // ones as a sensible starting point.
      saved = namespaced[key] || (await storageGet('sync', DEFAULT_SETTINGS));
    } else {
      saved = await storageGet('sync', DEFAULT_SETTINGS);
    }
    return {
      // Everything the shared module knows about passes through untouched, so a
      // new setting never has to be added here as well to take effect.
      ...DEFAULT_SETTINGS,
      ...saved,
      enabled: saved.enabled !== false,
      chunkMinutes: clampNumber(saved.chunkMinutes, 1, 20, DEFAULT_SETTINGS.chunkMinutes),
      minVideoMinutes: Math.max(
        0,
        Number.isFinite(Number(saved.minVideoMinutes))
          ? Number(saved.minVideoMinutes)
          : DEFAULT_SETTINGS.minVideoMinutes
      ),
      autoPause: saved.autoPause !== false,
      useAI: saved.useAI !== false,
      aiCheckpoints: saved.aiCheckpoints !== false,
      proxyUrl: typeof saved.proxyUrl === 'string' ? saved.proxyUrl.trim() : DEFAULT_PROXY_URL,
    };
  }

  function aiEnabled(settings) {
    return Boolean(
      AI_PROXY_ENABLED_IN_THIS_BUILD &&
        settings.useAI &&
        settings.proxyUrl &&
        !/YOUR-|example\.com/i.test(settings.proxyUrl)
    );
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  async function waitForVideo(token) {
    for (let i = 0; i < 120 && !token.cancelled; i++) {
      const video =
        document.querySelector('#movie_player video') || document.querySelector('video');
      if (video && Number.isFinite(video.duration) && video.duration > 0) return video;
      await sleep(250);
    }
    return null;
  }

  // YouTube reuses the same <video> element for pre-roll ads, so its `duration`
  // reports the ad length (e.g. 28s) or NaN before metadata loads. Detect the ad
  // state so we never plan checkpoints against an advertisement's timeline.
  function isAdShowing() {
    const player = document.querySelector('#movie_player');
    if (player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'))) {
      return true;
    }
    return Boolean(document.querySelector('.ad-showing, .ytp-ad-player-overlay, .ytp-ad-module .ytp-ad-text'));
  }

  // Ask the page world (mainWorld.js) for the authoritative video length through
  // the existing tracks bridge. lengthSeconds comes from ytInitialPlayerResponse
  // and is never skewed by ads. Resolves to a positive number, or null when the
  // page world replies without a usable length (older build, cold load).
  function requestPageLength(videoId, timeoutMs = 1500) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const onTracks = (event) => {
        const detail = event.detail || {};
        if (detail.videoId && videoId && detail.videoId !== videoId) return;
        const length = Number(detail.lengthSeconds);
        // mainWorld answers each request with exactly one tracks event, so the
        // first matching reply is authoritative: use its length if valid, else
        // resolve null immediately rather than stalling until the timeout.
        finish(Number.isFinite(length) && length > 0 ? length : null);
      };
      function finish(value) {
        if (settled) return;
        settled = true;
        window.removeEventListener('focusflow:tracks', onTracks);
        if (timer) clearTimeout(timer);
        resolve(value);
      }
      window.addEventListener('focusflow:tracks', onTracks);
      try {
        window.dispatchEvent(new CustomEvent('focusflow:request-tracks', { detail: { videoId } }));
      } catch (_) {
        /* page world not reachable */
      }
      timer = setTimeout(() => finish(null), timeoutMs);
    });
  }

  // Retries the page-world length request for a few seconds, because on a cold
  // load ytInitialPlayerResponse may not be populated for the first few hundred
  // milliseconds. Returns a positive number or null.
  async function fetchPageLength(videoId, token, budgetMs = 4000) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline && !token.cancelled) {
      const length = await requestPageLength(videoId);
      if (Number.isFinite(length) && length > 0) return length;
      await sleep(250);
    }
    return null;
  }

  // Returns a trustworthy duration ({ seconds, source, elementDuration }) or null.
  //
  // lengthSeconds is authoritative and ads cannot skew it, so it is the primary
  // source and short-circuits the whole thing — there is no reason to wait for the
  // <video> element, whose `duration` reports video+ad length and does NOT settle
  // back to the true length after a pre-roll ad ends (observed 707.721 for a 649s
  // video). The element is only a fallback for when the page world has no length.
  async function resolveDuration(video, videoId, token) {
    const pageLength = await fetchPageLength(videoId, token);
    if (token.cancelled) return null;

    if (Number.isFinite(pageLength) && pageLength > 0) {
      const elementDuration = Number(video.duration);
      const elementUsable = Number.isFinite(elementDuration) && elementDuration > 0;
      const disagrees = elementUsable && Math.abs(pageLength - elementDuration) > 2;
      return {
        seconds: pageLength,
        source: disagrees ? 'lengthSeconds-after-disagreement' : 'lengthSeconds',
        elementDuration: elementUsable ? elementDuration : null,
      };
    }

    // Fallback: no page-world length. Poll the element, waiting out ad playback
    // and unloaded metadata, within the 30s budget.
    const deadline = Date.now() + 30000;
    let lastSeen = null;
    while (Date.now() < deadline && !token.cancelled) {
      const adShowing = isAdShowing();
      const elementDuration = Number(video.duration);
      const elementUsable = Number.isFinite(elementDuration) && elementDuration > 0;
      if (elementUsable) lastSeen = elementDuration;
      if (!adShowing && elementUsable) {
        return { seconds: elementDuration, source: 'video-element', elementDuration };
      }
      await sleep(250);
    }
    if (Number.isFinite(lastSeen) && lastSeen > 0) {
      return { seconds: lastSeen, source: 'video-element-timeout', elementDuration: lastSeen };
    }
    return null;
  }

  function makeCheckpoints(duration, chunkMinutes) {
    const chunkSeconds = chunkMinutes * 60;
    const checkpoints = [];
    for (let time = chunkSeconds; time < duration - END_BUFFER_SECONDS; time += chunkSeconds) {
      checkpoints.push(time);
    }
    return checkpoints;
  }

  async function loadTranscript(videoId) {
    if (transcriptCache.has(videoId)) return transcriptCache.get(videoId);

    const key = `transcript:${videoId}`;
    try {
      const saved = await storageGet('local', key);
      // Only trust a cached transcript that actually has content. Caching a
      // failure would permanently poison the video: caption extraction fails
      // for transient reasons (slow page hydration, YouTube A/B layouts), so a
      // single bad run must never stop us from trying again.
      if (saved[key]?.cues?.length) {
        transcriptCache.set(videoId, saved[key]);
        return saved[key];
      }
    } catch (error) {
      log('Could not read cached transcript:', error);
    }

    const transcript = await window.FocusFlow.captions.fetchTranscript(videoId);
    if (!transcript?.cues?.length) {
      log(`No transcript for ${videoId}; not caching so the next visit retries.`);
      return transcript;
    }

    transcriptCache.set(videoId, transcript);
    try {
      await storageSet('local', { [key]: transcript });
    } catch (error) {
      log('Could not cache transcript:', error);
    }
    return transcript;
  }

  function outsideText(cues, fromSeconds, toSeconds, duration) {
    const before = window.FocusFlow.captions.textBetween(cues, 0, fromSeconds);
    const after = window.FocusFlow.captions.textBetween(cues, toSeconds, duration);
    return `${before} ${after}`.trim();
  }

  function buildChunks(cues, checkpoints) {
    return checkpoints.map((checkpoint, i) => {
      const startSeconds = i === 0 ? 0 : checkpoints[i - 1];
      return {
        index: i + 1,
        startSeconds,
        endSeconds: checkpoint,
        text: window.FocusFlow.captions.textBetween(cues, startSeconds, checkpoint),
        // Issue #9: per-line timestamps let the backend name the exact second an
        // answer is stated, powering the overlay's "Show me where" replay.
        lines: linesBetween(cues, startSeconds, checkpoint),
      };
    });
  }

  // Timestamped transcript lines for a section, in the { t, text } shape the
  // backend expects. Mirrors captions.textBetween's window but keeps each cue's
  // start time instead of flattening everything into one blob.
  function linesBetween(cues, fromSeconds, toSeconds) {
    return (cues || [])
      .filter((cue) => cue.start >= fromSeconds && cue.start < toSeconds)
      .map((cue) => ({ t: Math.max(0, Math.round(cue.start)), text: String(cue.text || '').trim() }))
      .filter((line) => line.text);
  }

  function wordCount(text) {
    return String(text || '').trim().split(/\s+/).filter(Boolean).length;
  }

  // Bug 2: combine AI sections with timed offline checkpoints over the time
  // ranges of any windows that failed, so a partial result still covers the
  // whole video. Returns aligned checkpoint / question / title arrays; a null
  // question means the overlay falls back to an offline question at that point.
  function planFromSections(sections, failedWindows, duration, chunkMinutes) {
    const entries = sections.map((section) => ({
      time: Math.round(section.endSeconds),
      question: section.question,
      title: section.title || '',
    }));

    const step = Math.max(60, Math.round(chunkMinutes * 60));
    for (const win of failedWindows || []) {
      const start = Math.round(win.windowStart);
      const end = Math.round(win.windowEnd);
      for (let t = start + step; t < end; t += step) {
        entries.push({ time: t, question: null, title: '' });
      }
    }

    entries.sort((a, b) => a.time - b.time);

    // Only apply the end-buffer trim when we actually know the true duration.
    // Guarding on a finite duration prevents a bad value (an ad's length or NaN)
    // from silently discarding every section.
    const hasDuration = Number.isFinite(duration) && duration > 0;
    const endLimit = hasDuration ? duration - END_BUFFER_SECONDS : Infinity;

    const checkpoints = [];
    const aiQuestions = [];
    const sectionTitles = [];
    let last = -Infinity;
    for (const entry of entries) {
      if (entry.time <= 0) continue;
      if (hasDuration && entry.time >= duration) continue;
      if (entry.time - last < 1) continue;
      checkpoints.push(entry.time);
      aiQuestions.push(entry.question);
      sectionTitles.push(entry.title);
      last = entry.time;
    }

    // Drop only trailing checkpoints that genuinely sit within END_BUFFER_SECONDS
    // of the real end, rather than throwing away every usable section.
    while (hasDuration && checkpoints.length && checkpoints[checkpoints.length - 1] >= endLimit) {
      checkpoints.pop();
      aiQuestions.pop();
      sectionTitles.pop();
    }
    return { checkpoints, aiQuestions, sectionTitles };
  }

  async function evictCache(prefix, max) {
    try {
      const all = await storageGet('local', null);
      const entries = Object.entries(all)
        .filter(([key, value]) => key.startsWith(prefix) && value?.createdAt)
        .sort((a, b) => Number(b[1].createdAt) - Number(a[1].createdAt));
      const stale = entries.slice(max).map(([key]) => key);
      if (stale.length) await storageRemove('local', stale);
    } catch (error) {
      log('Could not evict old cache entries for', prefix, error);
    }
  }

  async function evictQuestionCache() {
    return evictCache('questions:', MAX_QUESTION_CACHE_VIDEOS);
  }

  // Issue #1: ask the AI where the natural section breaks are. Returns
  // { sections, reason, trace, cached, failedWindows, totalWindows }. `sections`
  // is null on total failure so the caller can fall back to timed checkpoints.
  async function loadAISections(videoId, title, transcript, durationSeconds, settings, onRequestSent) {
    if (!aiEnabled(settings)) return { sections: null, reason: 'AI questions are turned off' };

    const cues = transcript.cues || [];
    const key = `sections:${videoId}`;

    if (sectionCache.has(videoId)) {
      return { sections: sectionCache.get(videoId), reason: 'ok', cached: true, failedWindows: [] };
    }

    try {
      const saved = await storageGet('local', key);
      const cached = window.FocusFlow.validate.sections(saved[key]?.sections);
      if (cached) {
        sectionCache.set(videoId, cached);
        return { sections: cached, reason: 'ok', cached: true, failedWindows: [] };
      }
    } catch (error) {
      log('Could not read AI section cache:', error);
    }

    if (transcript.source === 'none') {
      return { sections: null, reason: 'This video has no captions to read' };
    }
    if (wordCount(cues.map((cue) => cue.text).join(' ')) <= MIN_AI_WORDS) {
      return { sections: null, reason: 'Captions are too short for AI sections' };
    }

    const result = await window.FocusFlow.ai.segmentVideo({
      videoId,
      title,
      cues,
      durationSeconds,
      settings,
      onRequestSent,
    });
    if (!result?.sections) {
      return {
        sections: null,
        reason: describeAIError(result?.reason),
        trace: result?.trace,
        failedWindows: result?.failedWindows || [],
        totalWindows: result?.totalWindows || 0,
      };
    }

    // Re-validate the model output client-side before trusting it.
    const validated = window.FocusFlow.validate.sections(result.sections);
    if (!validated) {
      return { sections: null, reason: 'AI returned unusable sections', trace: result?.trace };
    }

    // Only cache a complete result. A partial result (some windows failed) is
    // left uncached so the failed windows are retried on the next visit.
    if (!(result.failedWindows && result.failedWindows.length)) {
      sectionCache.set(videoId, validated);
      try {
        await storageSet('local', { [key]: { createdAt: Date.now(), sections: validated } });
        await evictCache('sections:', MAX_QUESTION_CACHE_VIDEOS);
      } catch (error) {
        log('Could not cache AI sections:', error);
      }
    }

    return {
      sections: validated,
      reason: result.reason,
      diagnostics: result.diagnostics,
      trace: result.trace,
      failedWindows: result.failedWindows || [],
      totalWindows: result.totalWindows || 0,
    };
  }

  // Issue #8: when the uploader wrote chapters, they are a better description of
  // the video's structure than anything a model can infer, so every chapter end
  // becomes a checkpoint. Chapters that are not part of the material (sponsor
  // reads, channel intros and outros) get none. A chapter longer than the
  // viewer's maximum is handed to segment mode so it gains interior breaks.
  //
  // Returns null when the video has no chapters, so the caller falls through to
  // whole-video segmentation.
  async function planChapterSections(videoId, title, transcript, durationSeconds, settings, onRequestSent) {
    const cues = transcript.cues || [];
    const chapters = await window.FocusFlow.captions.fetchChapters(videoId, durationSeconds);
    if (!chapters || chapters.length < 2) return null;

    // A chapter plan costs a classification call plus a question call, so a
    // second visit to the same video should not pay for it again.
    const key = `plan:${videoId}`;
    try {
      const saved = await storageGet('local', key);
      const cached = saved[key];
      if (cached?.sections?.length && cached.bounds === settings.sectionMaxMinutes) {
        const sections = cached.sections.filter((section) =>
          window.FocusFlow.validate.questions([section.question], 1)
        );
        if (sections.length === cached.sections.length) {
          return { ...cached, sections, cached: true };
        }
      }
    } catch (error) {
      log('Could not read chapter plan cache:', error);
    }

    const classification = await window.FocusFlow.ai.classifyChapters({ videoId, title, chapters, cues });
    const verdicts = new Map((classification?.verdicts || []).map((verdict) => [verdict.index, verdict]));

    const skipped = [];
    const kept = chapters.filter((chapter) => {
      const verdict = verdicts.get(chapter.index);
      if (!verdict?.skip) return true;
      skipped.push({ title: chapter.title, reason: verdict.reason, startSeconds: chapter.startSeconds });
      return false;
    });
    if (!kept.length) {
      return { sections: [], chapters, skipped, reason: 'every chapter was classified as non-content' };
    }

    const bounds = window.FocusFlowSettings.sectionBounds(settings);
    const sections = [];
    let splitFailures = 0;

    const longChapters = kept.filter((c) => c.endSeconds - c.startSeconds > bounds.max);
    trace(
      4,
      `chapter plan: ${kept.length} of ${chapters.length} chapters kept, ` +
        `${longChapters.length} longer than ${bounds.max}s and due to be split`
    );

    // Minutes are not the only way a chapter can be too big. A fast talker, or a
    // viewer who set the maximum to half an hour, produces a chapter whose
    // transcript alone would blow the per-request character budget, so the
    // character count gets a say as well.
    const needsSplit = (chapter) => {
      const span = chapter.endSeconds - chapter.startSeconds;
      const text = window.FocusFlow.captions.textBetween(cues, chapter.startSeconds, chapter.endSeconds);
      return span > bounds.max || text.length > MAX_CHAPTER_CHARS;
    };

    // Each chapter split is an independent segmentVideo round trip, so waiting
    // for one to finish before starting the next wastes wall-clock time. Run the
    // splits concurrently (a few at a time), then assemble `sections` in the
    // original chapter order below so it stays sorted by time — the caller builds
    // checkpoints from it in order.
    const toSplit = kept.filter(needsSplit);
    const splitResults = new Map();
    const SPLIT_CONCURRENCY = 4;
    for (let i = 0; i < toSplit.length; i += SPLIT_CONCURRENCY) {
      const group = toSplit.slice(i, i + SPLIT_CONCURRENCY);
      const groupResults = await Promise.all(
        group.map((chapter) =>
          window.FocusFlow.ai.segmentVideo({
            videoId,
            title,
            cues,
            durationSeconds,
            settings,
            range: { start: chapter.startSeconds, end: chapter.endSeconds },
            onRequestSent,
          })
        )
      );
      group.forEach((chapter, j) => splitResults.set(chapter, groupResults[j]));
    }

    for (const chapter of kept) {
      if (splitResults.has(chapter)) {
        const result = splitResults.get(chapter);
        const validated = result?.sections ? window.FocusFlow.validate.sections(result.sections) : null;
        if (validated && validated.length) {
          validated.forEach((section) => {
            sections.push({
              startSeconds: section.startSeconds,
              endSeconds: section.endSeconds,
              title: section.title || chapter.title,
              question: section.question || null,
            });
          });
          continue;
        }
        // The split failed, but the chapter itself is still a valid section, so
        // the viewer loses the extra breaks rather than the whole chapter.
        splitFailures += 1;
      }

      sections.push({
        startSeconds: chapter.startSeconds,
        endSeconds: chapter.endSeconds,
        title: chapter.title,
        question: null,
      });
    }

    // Whatever segment mode did not already answer needs a question of its own.
    const pending = sections
      .map((section, position) => ({ section, position }))
      .filter((entry) => !entry.section.question);

    if (pending.length) {
      const chunks = pending.map((entry, i) => ({
        index: i + 1,
        startSeconds: entry.section.startSeconds,
        endSeconds: entry.section.endSeconds,
        text: window.FocusFlow.captions
          .textBetween(cues, entry.section.startSeconds, entry.section.endSeconds)
          // Last line of defence: a section that survived every split above and
          // is still enormous gets trimmed rather than failing the whole batch.
          .slice(0, MAX_CHAPTER_CHARS),
        lines: linesBetween(cues, entry.section.startSeconds, entry.section.endSeconds),
      }));
      const result = await window.FocusFlow.ai.generateForVideo({ videoId, title, chunks, onRequestSent });
      (result?.questions || []).forEach((question, i) => {
        if (question && pending[i]) pending[i].section.question = question;
      });
    }

    const usable = sections.filter((section) => section.question);
    const plan = {
      sections: usable,
      chapters,
      skipped,
      splitFailures,
      dropped: sections.length - usable.length,
      classificationReason: classification?.reason,
    };

    // Only a complete plan is worth keeping. Caching one with holes in it would
    // make a transient AI failure permanent for that video.
    if (usable.length === sections.length && usable.length) {
      try {
        await storageSet('local', {
          [`plan:${videoId}`]: { ...plan, bounds: settings.sectionMaxMinutes, createdAt: Date.now() },
        });
        await evictCache('plan:', MAX_QUESTION_CACHE_VIDEOS);
      } catch (error) {
        log('Could not cache chapter plan:', error);
      }
    }

    return plan;
  }

  async function loadAIQuestions(videoId, title, chunks, transcript, settings, onRequestSent) {
    if (!aiEnabled(settings)) return { questions: null, reason: 'AI questions are turned off' };

    const key = `questions:${videoId}`;
    if (questionCache.has(videoId)) {
      return { questions: questionCache.get(videoId), reason: 'ok' };
    }

    try {
      const saved = await storageGet('local', key);
      const cached = window.FocusFlow.validate.questions(saved[key]?.questions, chunks.length);
      if (cached) {
        const restored = alignToChunks(cached, chunks);
        questionCache.set(videoId, restored);
        return { questions: restored, reason: 'ok' };
      }
    } catch (error) {
      log('Could not read AI question cache:', error);
    }

    if (transcript.source === 'none') {
      return { questions: null, reason: 'This video has no captions to read' };
    }
    if (wordCount(chunks.map((chunk) => chunk.text).join(' ')) <= MIN_AI_WORDS) {
      return { questions: null, reason: 'Captions are too short for AI questions' };
    }

    const result = await window.FocusFlow.ai.generateForVideo({ videoId, title, chunks, onRequestSent });
    if (!result?.questions) {
      return { questions: null, reason: describeAIError(result?.reason), trace: result?.trace };
    }

    questionCache.set(videoId, result.questions);
    try {
      const storable = result.questions.filter(Boolean);
      await storageSet('local', { [key]: { createdAt: Date.now(), questions: storable } });
      await evictQuestionCache();
    } catch (error) {
      log('Could not cache AI questions:', error);
    }

    const reason =
      result.reason === 'partial'
        ? `AI covered ${result.covered} of ${result.total} checkpoints`
        : 'ok';
    return { questions: result.questions, reason, trace: result.trace };
  }

  // Cached questions carry their chunk index, so they can be restored into the
  // right slots even if the chunk length setting changed since they were saved.
  function alignToChunks(questions, chunks) {
    const bySlot = new Array(chunks.length).fill(null);
    questions.forEach((question, position) => {
      const slot = Number.isInteger(question.index)
        ? chunks.findIndex((chunk) => chunk.index === question.index)
        : position;
      if (slot >= 0 && slot < bySlot.length && !bySlot[slot]) bySlot[slot] = question;
    });
    return bySlot;
  }

  function describeAIError(code) {
    const messages = {
      http_400: 'Backend rejected the request',
      http_403: 'Backend refused this extension',
      http_413: 'Transcript was too large',
      http_429: 'Hit the hourly AI limit - try again later',
      http_500: 'Backend error',
      http_502: 'AI returned an unusable answer',
      timeout: 'Backend timed out',
      network: 'Could not reach the backend',
      invalid_output: 'AI returned an unusable answer',
    };
    if (code && messages[code]) return messages[code];
    if (typeof code === 'string' && code.includes('Receiving end does not exist')) {
      return 'Background service worker is not running - reload the extension';
    }
    return `AI unavailable (${code || 'unknown'})`;
  }

  function safePlay(video) {
    try {
      const promise = video.play();
      if (promise?.catch) promise.catch((error) => log('Could not resume video:', error));
    } catch (error) {
      log('Could not resume video:', error);
    }
  }

  function validatedQuestion(question, videoId) {
    const valid = window.FocusFlow.validate.questions([question], 1);
    if (valid?.[0]) return valid[0];
    return window.FocusFlow.questionBank.next(videoId);
  }

  function offlineQuestion(videoId, cues, previousCheckpoint, checkpoint, duration) {
    const chunkText = window.FocusFlow.captions.textBetween(cues, previousCheckpoint, checkpoint);
    const otherChunksText = outsideText(cues, previousCheckpoint, checkpoint, duration);
    const question = validatedQuestion(
      window.FocusFlow.questions.generate(chunkText, otherChunksText, videoId),
      videoId
    );
    // Offline questions get no timestamp from a model. When the correct answer is
    // a phrase lifted straight from the captions (the multiple-choice case), the
    // cue that first says it is an honest "Show me where" target; otherwise we
    // leave it null and the overlay falls back to rewatching the whole section.
    const answerSeconds = offlineAnswerSeconds(question, cues, previousCheckpoint, checkpoint);
    return answerSeconds === null ? question : { ...question, answerSeconds };
  }

  // Only claim a timestamp we can stand behind: the correct multiple-choice
  // answer is a phrase taken verbatim from this section, so the first cue that
  // contains it genuinely says the answer. True/false statements span several
  // cues, so there is no single honest cue to point at and we return null.
  function offlineAnswerSeconds(question, cues, fromSeconds, toSeconds) {
    if (!question || question.type !== 'mc') return null;
    const answer = question.choices?.[question.answerIndex];
    if (!answer) return null;
    const needle = String(answer).toLowerCase();
    const cue = (cues || []).find(
      (c) =>
        c.start >= fromSeconds &&
        c.start < toSeconds &&
        String(c.text || '').toLowerCase().includes(needle)
    );
    return cue ? Math.max(0, Math.round(cue.start)) : null;
  }

  async function writeStatus(status) {
    try {
      await storageSet('local', { lastStatus: { updatedAt: Date.now(), ...status } });
    } catch (error) {
      log('Could not write status:', error);
    }
  }

  function teardown() {
    if (!state) return;
    state.token.cancelled = true;
    if (state.video && state.onTimeUpdate) {
      state.video.removeEventListener('timeupdate', state.onTimeUpdate);
    }
    if (state.pausedByFocusFlow && state.video?.paused) safePlay(state.video);
    window.FocusFlow.overlay?.destroy();
    window.FocusFlow.markers?.destroy();
    state = null;
  }

  function setupTimeListener(videoId, video, checkpoints, transcript, settings, token, aiQuestions, sectionTitles, durationSeconds) {
    const answered = new Set();
    let lastTime = 0;
    let overlayOpen = false;

    // True whenever the media element is not playing the video we planned for:
    // an ad, or metadata not loaded yet. Mirrors markers.js's isOffPlan so the
    // dots and the checkpoint watcher agree about when an ad is on screen.
    function isOffPlan() {
      const playing = Number(video?.duration);
      if (!Number.isFinite(playing) || playing <= 0) return true;
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return false;
      return Math.abs(playing - durationSeconds) > 2;
    }

    // Seed from the element only when it is really our video: setting up during
    // a pre-roll would otherwise seed the ad's clock as the starting point.
    lastTime = isOffPlan() ? 0 : (video.currentTime || 0);

    async function showCheckpoint(index, { manual = false } = {}) {
      if (token.cancelled || overlayOpen || index < 0 || index >= checkpoints.length) return false;

      overlayOpen = true;
      answered.add(index);
      const checkpoint = checkpoints[index];
      const previousCheckpoint = index === 0 ? 0 : checkpoints[index - 1];

      try {
        if (settings.autoPause) {
          video.pause();
          if (state && state.token === token) state.pausedByFocusFlow = true;
        }

        const cues = transcript.cues || [];
        // With AI on, an absent question means something failed; showing an
        // offline one here would hide that. Skip the checkpoint instead.
        const question = aiEnabled(settings)
          ? aiQuestions?.[index]
          : aiQuestions?.[index] ||
            offlineQuestion(videoId, cues, previousCheckpoint, checkpoint, durationSeconds || video.duration);
        if (!question) {
          if (state && state.token === token) state.pausedByFocusFlow = false;
          safePlay(video);
          return false;
        }
        const meta = { index: index + 1, total: checkpoints.length };
        if (sectionTitles?.[index]) meta.sectionTitle = sectionTitles[index];
        const result = await window.FocusFlow.overlay.show(question, meta);
        if (token.cancelled) return false;

        if (result === 'rewatch') {
          answered.delete(index);
          window.FocusFlow.markers?.markPending(index);
          video.currentTime = previousCheckpoint;
          lastTime = previousCheckpoint;
        } else if (result === 'replay' && Number.isFinite(question.answerSeconds)) {
          // "Show me where": jump back to just before the answer was stated,
          // with ~5s of lead-in for context, but never before this section's
          // start. Unlike "rewatch", the checkpoint stays SATISFIED — we keep
          // `index` in `answered` and mark the dot done, so passing the
          // checkpoint again does not re-ask. Setting `lastTime` to the seek
          // target (which sits below the checkpoint) is what stops onTimeUpdate
          // from reading this backward jump as a rewind and re-arming the
          // checkpoint we just cleared.
          const replayStart = Math.max(0, previousCheckpoint, question.answerSeconds - 5);
          window.FocusFlow.markers?.markDone(index);
          video.currentTime = replayStart;
          lastTime = replayStart;
        } else if (manual) {
          answered.delete(index);
          window.FocusFlow.markers?.markPending(index);
        } else {
          // Answered, skipped or passed through — either way this checkpoint is
          // behind the viewer now, so fill the dot in.
          window.FocusFlow.markers?.markDone(index);
        }
        window.FocusFlow.markers?.setCurrentTime(video.currentTime || 0);
        if (state && state.token === token) state.pausedByFocusFlow = false;
        safePlay(video);
        return true;
      } catch (error) {
        log('Checkpoint failed:', error);
        if (state && state.token === token) state.pausedByFocusFlow = false;
        safePlay(video);
        return false;
      } finally {
        overlayOpen = false;
      }
    }

    const onTimeUpdate = () => {
      if (token.cancelled || overlayOpen || !checkpoints.length) return;

      // While an ad plays it uses this same media element, so `currentTime` is
      // the ad's clock counting up from zero. Left unguarded that clock walks
      // straight through the early checkpoints and fires a question over the
      // ad, and a mid-roll drop back to zero reads as a rewind and re-arms
      // every question already answered.
      //
      // Detect it by duration, not by YouTube's `ad-showing` class: markers.js
      // documents that the class and the ad overlay elements both go stale and
      // linger after the ad ends, which would suppress real checkpoints. The
      // element's duration is honest — during an ad it reports the ad's length.
      if (isOffPlan()) return;

      const currentTime = video.currentTime || 0;
      window.FocusFlow.markers?.setCurrentTime(currentTime);
      if (currentTime < lastTime) {
        // Rewinding means the viewer is watching that stretch again, so any
        // checkpoint now ahead of them should ask again — the same reasoning as
        // the "Rewatch this section" button, which already clears its own
        // checkpoint. A 1s tolerance keeps ordinary playback jitter from
        // counting as a rewind.
        if (currentTime < lastTime - 1) {
          for (const index of [...answered]) {
            if (checkpoints[index] > currentTime) {
              answered.delete(index);
              window.FocusFlow.markers?.markPending(index);
            }
          }
        }
        lastTime = currentTime;
        return;
      }

      const index = checkpoints.findIndex(
        (time, i) => !answered.has(i) && lastTime < time && currentTime >= time
      );
      lastTime = currentTime;
      if (index !== -1) showCheckpoint(index);
    };

    video.addEventListener('timeupdate', onTimeUpdate);
    return {
      onTimeUpdate,
      triggerNow: () => {
        const currentTime = video.currentTime || 0;
        let index = checkpoints.findIndex((time) => currentTime <= time);
        if (index === -1) index = checkpoints.length - 1;
        return showCheckpoint(index, { manual: true });
      },
    };
  }

  function pageTitle() {
    return (document.querySelector('h1.ytd-watch-metadata')?.textContent || document.title || '')
      .replace(/\s+-\s+YouTube$/, '')
      .trim();
  }

  async function initialise() {
    teardown();
    // The panel outlives individual videos: it re-mounts itself rather than
    // being rebuilt, and removes itself when you leave a watch page.
    window.FocusFlow.panel.init();

    const videoId = currentVideoId();
    if (!videoId) {
      await writeStatus({ ready: false, reason: 'Not a YouTube watch page' });
      return;
    }

    const token = { cancelled: false };
    state = {
      token,
      video: null,
      videoId,
      title: '',
      checkpoints: [],
      transcript: null,
      durationSeconds: null,
      onTimeUpdate: null,
      triggerNow: null,
      pausedByFocusFlow: false,
    };

    try {
      const settings = await getSettings();
      if (token.cancelled || !settings.enabled) {
        await writeStatus({ ready: false, videoId, reason: 'FocusFlow is disabled' });
        return;
      }

      const video = await waitForVideo(token);
      if (token.cancelled || !video) return;
      state.video = video;

      // Issue #1: fetch the transcript first so the AI can decide the section
      // breaks before we fall back to a fixed timer.
      const transcript = await loadTranscript(videoId);
      if (token.cancelled) return;
      state.transcript = transcript;
      state.title = pageTitle();

      // Bug fix: the shared <video> element reports the pre-roll ad's duration
      // (or NaN) until real playback starts, so resolve a trustworthy duration
      // before planning anything against it.
      const durationInfo = await resolveDuration(video, videoId, token);
      if (token.cancelled) return;
      const durationSeconds = durationInfo ? durationInfo.seconds : null;
      if (durationInfo) {
        if (durationInfo.source === 'lengthSeconds-after-disagreement') {
          log(
            'Using authoritative video length',
            Math.round(durationSeconds),
            's; <video> element reported',
            durationInfo.elementDuration,
            's (pre-roll ad likely inflating it)'
          );
        } else if (durationInfo.source === 'video-element-timeout') {
          log('No page-world lengthSeconds; fell back to <video> element length', Math.round(durationSeconds), 's');
        } else {
          console.debug?.('[FocusFlow] video length', Math.round(durationSeconds), 'via', durationInfo.source);
        }
      }

      const cues = transcript.cues || [];
      const transcriptChars = cues.reduce((sum, cue) => sum + String(cue.text || '').length, 0);
      if (transcript.source === 'none') {
        traceWarn(1, 'no captions available for this video');
      } else {
        trace(1, 'Transcript acquired', {
          source: transcript.source,
          cues: cues.length,
          chars: transcriptChars,
          durationSeconds: durationSeconds != null ? Math.round(durationSeconds) : 'unknown',
        });
      }

      const baseStatus = {
        ready: false,
        videoId,
        title: state.title,
        durationSeconds: durationSeconds != null ? Math.round(durationSeconds) : 0,
        chunkMinutes: settings.chunkMinutes,
        minVideoMinutes: settings.minVideoMinutes,
        checkpointCount: 0,
        captionsSource: transcript.source,
        transcriptCueCount: cues.length,
        questionSource: 'offline',
        aiActive: false,
      };

      // Without a reliable duration we cannot place checkpoints at all; log it
      // loudly instead of silently planning against an ad or NaN.
      if (durationSeconds == null) {
        traceWarn(1, 'could not determine a reliable video length (ad still playing or metadata never loaded); skipping checkpoints');
        await writeStatus({ ...baseStatus, reason: 'Could not determine the video length' });
        return;
      }

      if (durationSeconds < settings.minVideoMinutes * 60) {
        await writeStatus({ ...baseStatus, reason: 'Video is shorter than the minimum' });
        return;
      }

      state.durationSeconds = durationSeconds;

      let checkpoints = null;
      let aiQuestions = null;
      let sectionTitles = null;
      let aiReason = '';
      let usedSegmentation = false;

      const canSegment =
        aiEnabled(settings) &&
        settings.aiCheckpoints &&
        transcript.source !== 'none' &&
        wordCount(cues.map((cue) => cue.text).join(' ')) > MIN_AI_WORDS;

      if (canSegment) {
        const endpoint = resolveEndpoint(settings.proxyUrl);
        const onRequestSent = (info) => traceRequestSent(endpoint, info);
        const heartbeat = startHeartbeat();
        let chapterPlan = null;
        try {
          chapterPlan = await planChapterSections(
            videoId,
            state.title,
            transcript,
            durationSeconds,
            settings,
            onRequestSent
          );
        } catch (error) {
          traceWarn(2, 'chapter planning failed: ' + String(error?.message || error));
        } finally {
          clearInterval(heartbeat);
        }
        if (token.cancelled) return;

        if (chapterPlan) {
          chapterPlan.skipped.forEach((chapter) => {
            trace(4, `skipped chapter "${chapter.title}" (${chapter.reason})`, {
              startSeconds: chapter.startSeconds,
            });
          });
          if (chapterPlan.splitFailures) {
            traceWarn(2, `${chapterPlan.splitFailures} long chapter(s) could not be split further`);
          }
          if (chapterPlan.dropped) {
            traceWarn(2, `${chapterPlan.dropped} chapter section(s) had no AI question and were dropped`);
          }

          if (chapterPlan.sections.length) {
            const plan = planFromSections(chapterPlan.sections, [], durationSeconds, settings.chunkMinutes);
            if (plan.checkpoints.length) {
              checkpoints = plan.checkpoints;
              aiQuestions = plan.aiQuestions;
              sectionTitles = plan.sectionTitles;
              usedSegmentation = true;
              aiReason = 'ok';
              trace(4, 'checkpoints follow the video\'s own chapters', {
                chapters: chapterPlan.chapters.length,
                skipped: chapterPlan.skipped.length,
                checkpoints: plan.checkpoints.length,
              });
            }
          } else {
            traceWarn(2, 'chapter plan produced no usable sections; falling back to AI segmentation');
          }
        }
      }

      if (canSegment && !usedSegmentation) {
        const endpoint = resolveEndpoint(settings.proxyUrl);
        const onRequestSent = (info) => traceRequestSent(endpoint, info);
        const heartbeat = startHeartbeat();
        const startedAt = Date.now();
        let segResult;
        try {
          segResult = await loadAISections(videoId, state.title, transcript, durationSeconds, settings, onRequestSent);
        } finally {
          clearInterval(heartbeat);
        }
        if (token.cancelled) return;
        const roundTripMs = Date.now() - startedAt;

        if (segResult.sections) {
          if (segResult.cached) {
            trace(4, 'AI sections restored from cache (no API call)', {
              sections: segResult.sections.length,
            });
          } else {
            traceResponseSteps(segResult.trace, segResult.sections.length, roundTripMs);
          }
          if (segResult.failedWindows && segResult.failedWindows.length) {
            traceWarn(
              2,
              `${segResult.failedWindows.length} of ${segResult.totalWindows} windows failed (${describeReason(segResult.reason)}); covering those ranges with timed offline checkpoints`
            );
          }

          const plan = planFromSections(
            segResult.sections,
            segResult.failedWindows,
            durationSeconds,
            settings.chunkMinutes
          );
          if (plan.checkpoints.length) {
            checkpoints = plan.checkpoints;
            aiQuestions = plan.aiQuestions;
            sectionTitles = plan.sectionTitles;
            usedSegmentation = true;
            aiReason = segResult.reason;
          } else {
            traceWarn(2, 'AI sections all fell inside the end buffer; using timed checkpoints');
          }
        } else {
          traceWarn(2, 'AI segmentation failed: ' + describeReason(segResult.reason));
          if (segResult.trace) traceResponseSteps(segResult.trace, 0, roundTripMs);
        }
      }

      // Fallback chain: timed checkpoints with per-chunk AI questions. Offline
      // questions are only used when the viewer has deliberately turned AI off.
      if (!usedSegmentation) {
        checkpoints = makeCheckpoints(durationSeconds, settings.chunkMinutes);
        if (!checkpoints.length) {
          // Very short video: still emit STEP 5 so the pipeline never ends
          // silently, then report why there are no checkpoints.
          trace(5, 'Questions loaded', {
            mode: 'offline',
            checkpoints: 0,
            aiQuestions: 0,
            offlineQuestions: 0,
            timestamps: [],
          });
          await writeStatus({ ...baseStatus, reason: 'No checkpoints fit before the end' });
          return;
        }
        const chunks = buildChunks(cues, checkpoints);
        const endpoint = resolveEndpoint(settings.proxyUrl);
        const onRequestSent = (info) => traceRequestSent(endpoint, info);
        const heartbeat = startHeartbeat();
        const startedAt = Date.now();
        let aiResult;
        try {
          aiResult = await loadAIQuestions(videoId, state.title, chunks, transcript, settings, onRequestSent);
        } finally {
          clearInterval(heartbeat);
        }
        if (token.cancelled) return;
        const roundTripMs = Date.now() - startedAt;

        aiQuestions = aiResult.questions;
        aiReason = aiResult.reason;
        if (aiResult.trace) {
          traceResponseSteps(aiResult.trace, (aiQuestions || []).filter(Boolean).length, roundTripMs);
        }
        if (!aiQuestions) traceWarn(2, 'AI questions unavailable: ' + describeReason(aiResult.reason));
      }

      // When AI questions are switched on, never quietly stand in offline
      // questions for them. A viewer who asked for AI and silently got
      // template questions has no way to tell that anything went wrong, and
      // neither does anyone trying to debug it. Say so instead.
      if (aiEnabled(settings)) {
        const usableCount = (aiQuestions || []).filter(Boolean).length;

        if (!usableCount) {
          trace(5, 'Questions loaded', {
            mode: 'none',
            checkpoints: 0,
            aiQuestions: 0,
            offlineQuestions: 0,
            timestamps: [],
          });
          const why = describeReason(aiReason);
          await writeStatus({
            ...baseStatus,
            checkpointCount: 0,
            questionSource: 'none',
            aiActive: false,
            aiReason,
            segmentMode: usedSegmentation,
            reason: `No AI questions: ${why}`,
          });
          // Longer than the usual toast: this one explains why nothing is
          // going to happen, so it is worth making hard to miss.
          window.FocusFlow.overlay.toast(`FocusFlow: no questions - ${why}`, 12000);
          return;
        }

        // A partial result padded the gaps with question-less checkpoints.
        // Drop those rather than filling them in offline, and report the gap.
        if (usableCount < checkpoints.length) {
          const kept = [];
          const keptQuestions = [];
          const keptTitles = [];
          checkpoints.forEach((time, i) => {
            if (!aiQuestions?.[i]) return;
            kept.push(time);
            keptQuestions.push(aiQuestions[i]);
            keptTitles.push(sectionTitles?.[i] || '');
          });
          traceWarn(
            2,
            `${checkpoints.length - usableCount} of ${checkpoints.length} checkpoints had no AI question and were dropped (${describeReason(aiReason)})`
          );
          checkpoints = kept;
          aiQuestions = keptQuestions;
          sectionTitles = usedSegmentation ? keptTitles : null;
        }
      }

      state.checkpoints = checkpoints;
      state.aiQuestions = aiQuestions;
      state.sectionTitles = sectionTitles;

      window.FocusFlow.markers.attach({ checkpoints, durationSeconds, video });
      window.FocusFlow.markers.setCurrentTime(video.currentTime || 0);

      const listener = setupTimeListener(
        videoId,
        video,
        checkpoints,
        transcript,
        settings,
        token,
        aiQuestions,
        sectionTitles,
        durationSeconds
      );
      state.onTimeUpdate = listener.onTimeUpdate;
      state.triggerNow = listener.triggerNow;

      const aiCount = (aiQuestions || []).filter(Boolean).length;
      const aiActive = aiCount > 0;
      const offlineCount = checkpoints.length - aiCount;

      trace(5, 'Questions loaded', {
        mode: usedSegmentation ? 'AI sections' : aiActive ? 'timed + AI questions' : 'offline',
        checkpoints: checkpoints.length,
        aiQuestions: aiCount,
        offlineQuestions: offlineCount,
        timestamps: checkpoints,
      });

      const questionSource = usedSegmentation
        ? aiReason === 'ok'
          ? 'AI sections ready'
          : aiReason
        : aiActive
        ? aiReason === 'ok'
          ? 'AI questions ready'
          : aiReason
        : `offline questions - ${aiReason}`;
      await writeStatus({
        ...baseStatus,
        checkpointCount: checkpoints.length,
        questionSource: aiActive ? 'AI' : 'offline',
        aiActive,
        aiReason,
        segmentMode: usedSegmentation,
        ready: true,
      });
      window.FocusFlow.overlay.toast(`FocusFlow: ${checkpoints.length} checkpoints - ${questionSource}`);
    } catch (error) {
      log('Setup failed:', error);
      await writeStatus({ ready: false, videoId, reason: 'Setup failed' });
      if (state?.video?.paused && state.pausedByFocusFlow) safePlay(state.video);
    }
  }

  function scheduleInitialise() {
    clearTimeout(navTimer);
    navTimer = setTimeout(initialise, 150);
  }

  function checkForNavigation() {
    const videoId = currentVideoId();
    if (videoId === lastKnownVideoId) return;
    lastKnownVideoId = videoId;
    scheduleInitialise();
  }

  function notReady(sendResponse) {
    sendResponse({ ok: false, error: 'not_ready' });
  }

  function progressSnapshot() {
    if (!state?.video) return null;
    const video = state.video;
    const resolved = Number.isFinite(state.durationSeconds) && state.durationSeconds > 0 ? state.durationSeconds : 0;
    const duration = resolved || (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0);
    const current = Math.min(duration, Math.max(0, video.currentTime || 0));
    const checkpoints = state.checkpoints || [];
    const nextIndex = checkpoints.findIndex((time) => current < time);
    const chunkIndex = checkpoints.length ? (nextIndex === -1 ? checkpoints.length : nextIndex + 1) : 1;
    const chunkTotal = Math.max(1, checkpoints.length || 1);
    const chunkStartSeconds = chunkIndex <= 1 ? 0 : checkpoints[chunkIndex - 2];
    const chunkEndSeconds =
      nextIndex === -1 ? duration : checkpoints[Math.max(0, chunkIndex - 1)] || duration;
    const nextCheckpointSeconds = nextIndex === -1 ? null : checkpoints[nextIndex];
    return {
      ok: true,
      currentSeconds: current,
      durationSeconds: duration,
      percent: duration ? Math.round((current / duration) * 1000) / 10 : 0,
      chunkIndex,
      chunkTotal,
      chunkStartSeconds,
      chunkEndSeconds,
      secondsUntilNextCheckpoint:
        nextCheckpointSeconds === null ? null : Math.max(0, nextCheckpointSeconds - current),
      nextCheckpointSeconds,
      paused: Boolean(video.paused),
      checkpoints,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'focusflow:test-checkpoint') {
      if (!state?.triggerNow) {
        window.FocusFlow.overlay?.toast('FocusFlow is not ready on this video yet.');
        notReady(sendResponse);
        return false;
      }
      state
        .triggerNow()
        .then((ok) => sendResponse({ ok }))
        .catch((error) => {
          log('Manual checkpoint failed:', error);
          sendResponse({ ok: false, error: 'failed' });
        });
      return true;
    }

    if (message?.type === 'focusflow:get-transcript') {
      if (!state?.video || !state?.transcript) {
        notReady(sendResponse);
        return false;
      }
      sendResponse({
        ok: true,
        videoId: state.videoId,
        title: state.title || pageTitle(),
        source: state.transcript.source,
        cues: state.transcript.cues || [],
        checkpoints: state.checkpoints || [],
        durationSeconds: state.durationSeconds || state.video.duration || 0,
      });
      return false;
    }

    if (message?.type === 'focusflow:seek') {
      if (!state?.video) {
        notReady(sendResponse);
        return false;
      }
      const duration = Number.isFinite(state.durationSeconds) && state.durationSeconds > 0
        ? state.durationSeconds
        : Number.isFinite(state.video.duration)
        ? state.video.duration
        : 0;
      const seconds = Math.min(duration, Math.max(0, Number(message.seconds) || 0));
      state.video.currentTime = seconds;
      safePlay(state.video);
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === 'focusflow:get-progress') {
      const progress = progressSnapshot();
      if (!progress) notReady(sendResponse);
      else sendResponse(progress);
      return false;
    }

    return false;
  });

  document.addEventListener('yt-navigate-finish', checkForNavigation);
  setInterval(checkForNavigation, 1000);
  const observer = new MutationObserver(checkForNavigation);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Read-only handles for the in-page panel, which lives in this same content
  // script world and so cannot message itself the way the popup does.
  window.FocusFlow.session = {
    progress: progressSnapshot,
    hasCheckpoints: () => Boolean(state?.triggerNow && state.checkpoints?.length),
    triggerNow: () => (state?.triggerNow ? state.triggerNow() : Promise.resolve(false)),
    // Read-only view of the current plan, so a checkpoint that landed in an odd
    // place can be inspected from the page console without adding logging.
    plan: () =>
      state
        ? {
            videoId: state.videoId,
            durationSeconds: state.durationSeconds,
            checkpoints: state.checkpoints || [],
            questions: state.aiQuestions || [],
            titles: state.sectionTitles || [],
          }
        : null,
  };

  window.FocusFlow.panel.init();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    // Re-plan when anonymous settings change...
    if (areaName === 'sync' && Object.keys(changes).some((key) => key in DEFAULT_SETTINGS)) {
      scheduleInitialise();
      return;
    }
    // ...when a signed-in account's namespaced settings change...
    if (areaName === 'sync' && Object.keys(changes).some((key) => /^account:.+:settings$/.test(key))) {
      scheduleInitialise();
      return;
    }
    // ...and when the active account itself switches, so the new person's
    // settings and progress take effect immediately.
    if (areaName === 'local' && 'activeAccount' in changes) {
      scheduleInitialise();
    }
  });

  scheduleInitialise();
})();

