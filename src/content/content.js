(() => {
  const DEFAULT_PROXY_URL = 'https://focusflow-proxy.YOUR-SUBDOMAIN.workers.dev';
  const AI_PROXY_ENABLED_IN_THIS_BUILD = false;
  const DEFAULT_SETTINGS = {
    enabled: true,
    chunkMinutes: 3,
    minVideoMinutes: 4,
    autoPause: true,
    useAI: false,
    proxyUrl: DEFAULT_PROXY_URL,
  };
  const END_BUFFER_SECONDS = 30;
  const MIN_AI_WORDS = 100;
  const MAX_QUESTION_CACHE_VIDEOS = 50;
  const transcriptCache = new Map();
  const questionCache = new Map();

  let state = null;
  let lastKnownVideoId = currentVideoId();
  let navTimer = null;

  const log = (...args) => console.warn('[FocusFlow]', ...args);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const saved = await storageGet('sync', DEFAULT_SETTINGS);
    return {
      enabled: saved.enabled !== false,
      chunkMinutes: clampNumber(saved.chunkMinutes, 1, 20, DEFAULT_SETTINGS.chunkMinutes),
      minVideoMinutes: Math.max(
        0,
        Number.isFinite(Number(saved.minVideoMinutes))
          ? Number(saved.minVideoMinutes)
          : DEFAULT_SETTINGS.minVideoMinutes
      ),
      autoPause: saved.autoPause !== false,
      useAI: saved.useAI === true,
      proxyUrl: typeof saved.proxyUrl === 'string' ? saved.proxyUrl.trim() : DEFAULT_PROXY_URL,
    };
  }

  function aiEnabled(settings) {
    return Boolean(
      AI_PROXY_ENABLED_IN_THIS_BUILD &&
        settings.useAI &&
        settings.proxyUrl &&
        settings.proxyUrl.trim() !== DEFAULT_PROXY_URL
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
      if (saved[key]?.cues) {
        transcriptCache.set(videoId, saved[key]);
        return saved[key];
      }
    } catch (error) {
      log('Could not read cached transcript:', error);
    }

    const transcript = await window.FocusFlow.captions.fetchTranscript(videoId);
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
      };
    });
  }

  function wordCount(text) {
    return String(text || '').trim().split(/\s+/).filter(Boolean).length;
  }

  async function evictQuestionCache() {
    try {
      const all = await storageGet('local', null);
      const entries = Object.entries(all)
        .filter(([key, value]) => key.startsWith('questions:') && value?.createdAt)
        .sort((a, b) => Number(b[1].createdAt) - Number(a[1].createdAt));
      const stale = entries.slice(MAX_QUESTION_CACHE_VIDEOS).map(([key]) => key);
      if (stale.length) await storageRemove('local', stale);
    } catch (error) {
      log('Could not evict old AI question cache:', error);
    }
  }

  async function loadAIQuestions(videoId, title, chunks, transcript, settings) {
    if (!aiEnabled(settings)) return null;

    const key = `questions:${videoId}`;
    if (questionCache.has(videoId)) return questionCache.get(videoId);

    try {
      const saved = await storageGet('local', key);
      const cached = window.FocusFlow.validate.questions(saved[key]?.questions, chunks.length);
      if (cached) {
        questionCache.set(videoId, cached);
        return cached;
      }
    } catch (error) {
      log('Could not read AI question cache:', error);
    }

    const enoughTranscript = wordCount(chunks.map((chunk) => chunk.text).join(' ')) > MIN_AI_WORDS;
    if (transcript.source === 'none' || !enoughTranscript) return null;

    const questions = await window.FocusFlow.ai.generateForVideo({ videoId, title, chunks });
    if (!questions) return null;

    questionCache.set(videoId, questions);
    try {
      await storageSet('local', { [key]: { createdAt: Date.now(), questions } });
      await evictQuestionCache();
    } catch (error) {
      log('Could not cache AI questions:', error);
    }
    return questions;
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
    return validatedQuestion(
      window.FocusFlow.questions.generate(chunkText, otherChunksText, videoId),
      videoId
    );
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
    state = null;
  }

  function setupTimeListener(videoId, video, checkpoints, transcript, settings, token, aiQuestions) {
    const answered = new Set();
    let lastTime = video.currentTime || 0;
    let overlayOpen = false;

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
        const question =
          aiQuestions?.[index] ||
          offlineQuestion(videoId, cues, previousCheckpoint, checkpoint, video.duration);
        const result = await window.FocusFlow.overlay.show(question, {
          index: index + 1,
          total: checkpoints.length,
        });
        if (token.cancelled) return false;

        if (result === 'rewatch') {
          answered.delete(index);
          video.currentTime = previousCheckpoint;
          lastTime = previousCheckpoint;
        } else if (manual) {
          answered.delete(index);
        }
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

      const currentTime = video.currentTime || 0;
      if (currentTime < lastTime) {
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

      const checkpoints = makeCheckpoints(video.duration, settings.chunkMinutes);
      const transcript = await loadTranscript(videoId);
      if (token.cancelled) return;
      state.checkpoints = checkpoints;
      state.transcript = transcript;
      state.title = pageTitle();

      const baseStatus = {
        ready: video.duration >= settings.minVideoMinutes * 60 && checkpoints.length > 0,
        videoId,
        title: state.title,
        durationSeconds: Math.round(video.duration),
        chunkMinutes: settings.chunkMinutes,
        minVideoMinutes: settings.minVideoMinutes,
        checkpointCount: checkpoints.length,
        captionsSource: transcript.source,
        transcriptCueCount: transcript.cues?.length || 0,
        questionSource: 'offline',
        aiActive: false,
      };

      if (video.duration < settings.minVideoMinutes * 60) {
        await writeStatus({ ...baseStatus, ready: false, reason: 'Video is shorter than the minimum' });
        return;
      }
      if (!checkpoints.length) {
        await writeStatus({ ...baseStatus, ready: false, reason: 'No checkpoints fit before the end' });
        return;
      }

      const chunks = buildChunks(transcript.cues || [], checkpoints);
      const aiQuestions = await loadAIQuestions(videoId, baseStatus.title, chunks, transcript, settings);
      if (token.cancelled) return;

      const listener = setupTimeListener(
        videoId,
        video,
        checkpoints,
        transcript,
        settings,
        token,
        aiQuestions
      );
      state.onTimeUpdate = listener.onTimeUpdate;
      state.triggerNow = listener.triggerNow;

      const questionSource = aiQuestions ? 'AI questions ready' : 'offline questions';
      await writeStatus({
        ...baseStatus,
        questionSource: aiQuestions ? 'AI' : 'offline',
        aiActive: Boolean(aiQuestions),
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
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
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
        durationSeconds: state.video.duration || 0,
      });
      return false;
    }

    if (message?.type === 'focusflow:seek') {
      if (!state?.video) {
        notReady(sendResponse);
        return false;
      }
      const duration = Number.isFinite(state.video.duration) ? state.video.duration : 0;
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

    if (message?.type === 'focusflow:show-position') {
      const progress = progressSnapshot();
      if (!progress) {
        notReady(sendResponse);
        return false;
      }
      const next =
        progress.secondsUntilNextCheckpoint === null
          ? 'no more checkpoints'
          : `next checkpoint in ${formatTime(progress.secondsUntilNextCheckpoint)}`;
      window.FocusFlow.overlay.toast(
        `${formatTime(progress.currentSeconds)} / ${formatTime(progress.durationSeconds)} · section ${progress.chunkIndex} of ${progress.chunkTotal} · ${next}`
      );
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  document.addEventListener('yt-navigate-finish', checkForNavigation);
  setInterval(checkForNavigation, 1000);
  const observer = new MutationObserver(checkForNavigation);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;
    if (Object.keys(changes).some((key) => key in DEFAULT_SETTINGS)) scheduleInitialise();
  });

  scheduleInitialise();
})();
