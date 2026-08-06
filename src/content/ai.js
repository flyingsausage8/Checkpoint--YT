window.FocusFlow = window.FocusFlow || {};

window.FocusFlow.ai = (() => {
  const AI_PROXY_ENABLED_IN_THIS_BUILD = true;
  const DEFAULT_PROXY_URL = 'https://func-checkpoint-yt-pb5kh8.azurewebsites.net/api/generate';

  // The backend caps each request at 24 chunks and 50k transcript characters.
  // We stay under both by splitting long videos into several requests, so the
  // chunk length setting can never silently disable AI questions.
  const MAX_CHUNKS_PER_REQUEST = 12;
  const MAX_CHARS_PER_REQUEST = 40000;

  // Segment mode limits. Small windows keep each request fast (a single large
  // window took ~22s of model time); we then run windows in parallel and stitch
  // the results back together in time order.
  const MAX_LINES_PER_WINDOW = 400;
  const MAX_CHARS_PER_WINDOW = 10000;
  const MAX_WINDOW_SECONDS = 600;
  const MAX_CONCURRENT_WINDOWS = 4;

  // A trailing window shorter than a section minimum can never yield a valid
  // section, so the backend would reject it. We fold such a runt window into the
  // previous one as long as the merge stays within reasonable slack of the cap.
  const RUNT_MIN_CHARS = 2000;
  const RUNT_MERGE_SLACK = 1.5;

  // Enough of a chapter's opening for the model to recognise a sponsor read or a
  // channel intro, without turning classification into a second transcript
  // upload. The backend caps this at 600 too.
  const CHAPTER_SAMPLE_CHARS = 600;

  // True/false statements skew heavily towards True unless the answer is asked
  // for explicitly, so each section is handed a required polarity and they
  // alternate. Sections are numbered across the whole video, so the alternation
  // survives being split into parallel windows.
  const tfAnswerFor = (position) => (position % 2 === 0 ? 'True' : 'False');

  // Failures worth one more attempt: they are about the trip, not the request.
  // A 400/403/413 will be rejected identically, and retrying a 429 rate limit
  // only pushes the limit further out of reach.
  const RETRYABLE_ERRORS = new Set(['timeout', 'network', 'http_500', 'http_502', 'http_503', 'http_504']);

  // Turns an internal reason/error code into a short, human-readable sentence so
  // console warnings tell the owner what actually happened instead of `http_502`.
  function describeError(code) {
    const map = {
      http_429: 'too many requests, try again later',
      model_rate_limited: 'too many requests, try again later',
      rate_limited: 'too many requests, try again later',
      http_502: 'the server hit an unexpected error',
      http_500: 'the server hit an unexpected error',
      server_error: 'the server hit an unexpected error',
      model_error: 'the server hit an unexpected error',
      timeout: 'the request timed out',
      model_timeout: 'the request timed out',
      network: 'a network error occurred',
      no_response: 'the extension worker did not respond',
      no_valid_sections: 'the model could not segment this part of the video',
      no_valid_questions: 'the model returned no usable questions',
      invalid_output: 'the model output could not be used',
      no_transcript: 'no transcript was available',
      no_chunks: 'no transcript was available',
      unauthorized: 'your sign-in has expired — please sign in again',
    };
    return map[code] ? `${map[code]} (${code})` : String(code || 'unknown error');
  }

  // The network call is delegated to the background service worker. Fetching
  // from here would carry YouTube's origin and be blocked by CORS.
  function askBackground(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'focusflow:generate-questions', payload },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: 'no_response' });
        }
      );
    });
  }

  function askSegment(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'focusflow:segment-video', payload },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: 'no_response' });
        }
      );
    });
  }

  function askChapters(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'focusflow:classify-chapters', payload },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: 'no_response' });
        }
      );
    });
  }

  /**
   * Asks which chapters are not part of the video's actual material — a sponsor
   * read, a channel intro, a channel outro — so those get no checkpoint.
   *
   * Every failure path keeps every chapter. Being made to answer a question
   * about an advert is a small annoyance; silently dropping five minutes of real
   * material is a bug nobody would ever spot.
   */
  async function classifyChapters({ videoId, title, chapters, cues }) {
    const keepAll = (reason) => ({
      verdicts: chapters.map((chapter) => ({ index: chapter.index, skip: false, reason: 'content' })),
      reason,
    });
    if (!AI_PROXY_ENABLED_IN_THIS_BUILD) return keepAll('disabled_in_build');
    if (!Array.isArray(chapters) || !chapters.length) return keepAll('no_chapters');

    const payload = {
      videoId,
      title,
      chapters: chapters.map((chapter) => ({
        index: chapter.index,
        startSeconds: chapter.startSeconds,
        endSeconds: chapter.endSeconds,
        title: chapter.title,
        // The opening of a chapter is where a sponsor read announces itself, so
        // a sample from the start is worth more than one from the middle.
        sample: window.FocusFlow.captions
          .textBetween(cues || [], chapter.startSeconds, chapter.endSeconds)
          .slice(0, CHAPTER_SAMPLE_CHARS),
      })),
    };

    const result = await askChapters(payload);
    if (!result?.ok || !Array.isArray(result.chapters)) {
      const error = result?.error || result?.reason || 'unknown';
      console.warn('[FocusFlow] chapter classification failed:', describeError(error));
      return keepAll(error);
    }

    const byIndex = new Map(result.chapters.map((verdict) => [verdict.index, verdict]));
    return {
      verdicts: chapters.map((chapter) => {
        const verdict = byIndex.get(chapter.index);
        return {
          index: chapter.index,
          skip: verdict?.skip === true,
          reason: verdict?.reason || 'content',
        };
      }),
      reason: result.reason || 'ok',
      endpoint: result.endpoint,
      diagnostics: result.diagnostics,
    };
  }

  function batchChunks(chunks) {
    const batches = [];
    let current = [];
    let chars = 0;

    for (const chunk of chunks) {
      const size = String(chunk.text || '').length;
      const tooManyChunks = current.length >= MAX_CHUNKS_PER_REQUEST;
      const tooManyChars = current.length > 0 && chars + size > MAX_CHARS_PER_REQUEST;
      if (tooManyChunks || tooManyChars) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(chunk);
      chars += size;
    }

    if (current.length) batches.push(current);
    return batches;
  }

  // Runs `worker` over items with at most `limit` in flight at once, returning
  // results in the original item order regardless of completion order.
  async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    async function run() {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    }
    const runners = [];
    for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(run());
    await Promise.all(runners);
    return results;
  }

  // Returns { questions, reason }. `questions` is a sparse array indexed by
  // chunk index so a partial result still improves the checkpoints it covers.
  // `onRequestSent` (optional) fires synchronously just before each request is
  // dispatched, so callers can log the request at send time, not on resolution.
  async function generateForVideo({ videoId, title, chunks, onRequestSent }) {
    if (!AI_PROXY_ENABLED_IN_THIS_BUILD) return { questions: null, reason: 'disabled_in_build' };
    if (!videoId || !Array.isArray(chunks) || !chunks.length) {
      return { questions: null, reason: 'no_chunks' };
    }

    const batches = batchChunks(
      // Each chunk carries the answer its true/false statement must have, if the
      // model chooses to write one. Assigned here rather than server-side so the
      // alternation is continuous across separate requests.
      chunks.map((chunk, position) => ({ ...chunk, tfAnswer: tfAnswerFor(position) }))
    );
    const bySlot = new Array(chunks.length).fill(null);
    let covered = 0;
    let lastError = null;

    let endpoint = null;
    let charsSent = 0;
    const diagnostics = {
      mode: 'questions',
      receivedChunks: 0,
      receivedChars: 0,
      deployment: null,
      modelLatencyMs: 0,
      requests: 0,
    };

    let batchIndex = 0;
    for (const batch of batches) {
      batchIndex += 1;
      const chars = batch.reduce((sum, chunk) => sum + String(chunk.text || '').length, 0);
      charsSent += chars;
      if (typeof onRequestSent === 'function') {
        onRequestSent({ mode: 'questions', windowIndex: batchIndex, totalWindows: batches.length, chars });
      }
      const result = await askBackground({ videoId, title, chunks: batch });
      if (result?.endpoint) endpoint = result.endpoint;
      if (!result?.ok) {
        if (RETRYABLE_ERRORS.has(result?.error)) {
          console.warn('[FocusFlow] retrying question batch after ' + describeError(result.error));
          const retry = await askBackground({ videoId, title, chunks: batch });
          if (retry?.ok) {
            Object.assign(result, retry);
          }
        }
      }
      if (!result?.ok) {
        lastError = result?.error || 'unknown';
        console.warn('[FocusFlow] AI batch failed:', describeError(lastError));
        continue;
      }

      if (result.diagnostics) {
        diagnostics.receivedChunks += result.diagnostics.receivedChunks || 0;
        diagnostics.receivedChars += result.diagnostics.receivedChars || 0;
        diagnostics.deployment = result.diagnostics.deployment || diagnostics.deployment;
        diagnostics.modelLatencyMs += result.diagnostics.modelLatencyMs || 0;
        diagnostics.requests += 1;
      }

      const validated = window.FocusFlow.validate.questions(result.questions, batch.length);
      if (!validated) {
        lastError = result.reason || 'invalid_output';
        console.warn('[FocusFlow] AI batch unusable:', describeError(lastError));
        continue;
      }

      validated.forEach((question, position) => {
        // Prefer the chunk index the backend tagged; fall back to batch order.
        const chunkIndex = Number.isInteger(question.index)
          ? question.index
          : batch[position]?.index;
        const slot = chunks.findIndex((chunk) => chunk.index === chunkIndex);
        if (slot === -1 || bySlot[slot]) return;
        bySlot[slot] = question;
        covered += 1;
      });
    }

    const trace = {
      mode: 'questions',
      endpoint,
      requests: batches.length,
      charsSent,
      diagnostics,
      returned: covered,
    };

    if (!covered) return { questions: null, reason: lastError || 'no_questions', trace };
    return {
      questions: bySlot,
      reason: covered < chunks.length ? 'partial' : 'ok',
      covered,
      total: chunks.length,
      trace,
    };
  }

  // Groups transcript lines into contiguous time windows that each stay under
  // the per-request line, character, and duration caps. Windows tile the whole
  // video: the first starts at 0, each following one starts where the previous
  // ended, and the last runs to durationSeconds so nothing is left uncovered.
  function buildWindows(lines, durationSeconds, minSectionSeconds, startSeconds = 0) {
    const groups = [];
    let current = [];
    let chars = 0;

    for (const line of lines) {
      const size = line.text.length;
      const windowStartT = current.length ? current[0].t : line.t;
      const tooManyLines = current.length >= MAX_LINES_PER_WINDOW;
      const tooManyChars = current.length > 0 && chars + size > MAX_CHARS_PER_WINDOW;
      const tooLong = current.length > 0 && line.t - windowStartT > MAX_WINDOW_SECONDS;
      if (tooManyLines || tooManyChars || tooLong) {
        groups.push(current);
        current = [];
        chars = 0;
      }
      current.push(line);
      chars += size;
    }
    if (current.length) groups.push(current);

    // Bug fix: a short trailing window (e.g. the last ~80s of a video) is shorter
    // than minSectionSeconds and would be rejected by the backend, so merge it
    // back into the previous window unless that would blow past the char cap.
    if (groups.length >= 2) {
      const last = groups[groups.length - 1];
      const prev = groups[groups.length - 2];
      const lastChars = last.reduce((sum, line) => sum + line.text.length, 0);
      const prevChars = prev.reduce((sum, line) => sum + line.text.length, 0);
      const lastSpan = durationSeconds - last[0].t;
      const tooSmall = lastChars < RUNT_MIN_CHARS || lastSpan < (minSectionSeconds || 0);
      if (tooSmall && prevChars + lastChars <= MAX_CHARS_PER_WINDOW * RUNT_MERGE_SLACK) {
        groups[groups.length - 2] = prev.concat(last);
        groups.pop();
      }
    }

    return groups.map((group, i) => ({
      lines: group,
      windowStart: i === 0 ? startSeconds : group[0].t,
      windowEnd: i === groups.length - 1 ? durationSeconds : groups[i + 1][0].t,
    }));
  }

  // Returns { sections, reason, diagnostics, trace, failedWindows, totalWindows,
  // succeededWindows }. `sections` is null when no window produced usable output.
  // Windows are dispatched in parallel (capped) and their sections are stitched
  // back in time order, with question index renumbered sequentially (1-based).
  // `onRequestSent` (optional) fires just before each window is dispatched.
  async function segmentVideo({ videoId, title, cues, durationSeconds, settings, range, onRequestSent }) {
    if (!AI_PROXY_ENABLED_IN_THIS_BUILD) return { sections: null, reason: 'disabled_in_build' };
    if (!videoId || !Array.isArray(cues) || !cues.length) {
      return { sections: null, reason: 'no_transcript' };
    }

    // A range confines segmentation to part of the video. Used for a chapter
    // that is longer than the maximum section length: its own boundary still
    // stands, but the AI is asked to find extra breaks inside it.
    const rangeStart = range ? Math.max(0, Math.round(range.start)) : 0;
    const rangeEnd = range ? Math.round(range.end) : null;

    const lines = cues
      .map((cue) => ({
        t: Math.max(0, Math.round(Number(cue.start) || 0)),
        text: String(cue.text || '').trim(),
      }))
      .filter((line) => line.text)
      .filter((line) => (rangeEnd === null ? true : line.t >= rangeStart && line.t < rangeEnd));
    if (!lines.length) return { sections: null, reason: 'no_transcript' };

    const total =
      rangeEnd === null
        ? Math.max(Number(durationSeconds) || 0, lines[lines.length - 1].t + 1)
        : rangeEnd;
    const bounds = window.FocusFlowSettings.sectionBounds(settings);
    const minSectionSeconds = bounds.min;
    const maxSectionSeconds = bounds.max;

    const windows = buildWindows(lines, total, minSectionSeconds, rangeStart).filter(
      (win) => win.windowEnd > win.windowStart
    );
    const totalWindows = windows.length;

    const results = await mapLimit(windows, MAX_CONCURRENT_WINDOWS, async (win, i) => {
      const chars = win.lines.reduce((sum, line) => sum + line.text.length, 0);
      const request = {
        videoId,
        title,
        windowStart: win.windowStart,
        windowEnd: win.windowEnd,
        minSectionSeconds,
        maxSectionSeconds,
        // Windows run in parallel, so each is told which polarity to start on
        // rather than being left to alternate in ignorance of its neighbours.
        tfStart: tfAnswerFor(i),
        lines: win.lines,
      };
      if (typeof onRequestSent === 'function') {
        onRequestSent({ mode: 'segment', windowIndex: i + 1, totalWindows, chars });
      }
      let result = await askSegment(request);

      // A window that fails takes its whole time range down with it — several
      // minutes of video left with no checkpoints — and timeouts and transient
      // 5xx are common enough to be worth one more go. Only retry failures that
      // could plausibly succeed on a second attempt: a rejected payload or a
      // rate limit will fail identically, and retrying a 429 makes it worse.
      if (!result?.ok && RETRYABLE_ERRORS.has(result?.error)) {
        console.warn('[FocusFlow] retrying segment window after ' + describeError(result.error));
        result = await askSegment(request);
      }
      return { win, chars, result };
    });

    const collected = [];
    const failedWindows = [];
    let endpoint = null;
    let charsSent = 0;
    let lastError = null;
    const diagnostics = {
      mode: 'segment',
      receivedLines: 0,
      receivedChars: 0,
      deployment: null,
      modelLatencyMs: 0,
      windows: 0,
    };

    for (const { win, chars, result } of results) {
      charsSent += chars;
      if (result?.endpoint) endpoint = result.endpoint;
      if (!result?.ok) {
        lastError = result?.error || 'unknown';
        console.warn('[FocusFlow] segment window failed:', describeError(lastError));
        failedWindows.push({ windowStart: win.windowStart, windowEnd: win.windowEnd });
        continue;
      }

      if (result.diagnostics) {
        diagnostics.receivedLines += result.diagnostics.receivedLines || 0;
        diagnostics.receivedChars += result.diagnostics.receivedChars || 0;
        diagnostics.deployment = result.diagnostics.deployment || diagnostics.deployment;
        diagnostics.modelLatencyMs = Math.max(diagnostics.modelLatencyMs, result.diagnostics.modelLatencyMs || 0);
        diagnostics.windows += 1;
      }

      const validated = window.FocusFlow.validate.sections(result.sections);
      if (!validated) {
        lastError = result.reason || 'invalid_output';
        console.warn('[FocusFlow] segment window unusable:', describeError(lastError));
        failedWindows.push({ windowStart: win.windowStart, windowEnd: win.windowEnd });
        continue;
      }
      collected.push(...validated);
    }

    const trace = {
      mode: 'segment',
      endpoint,
      requests: totalWindows,
      charsSent,
      diagnostics,
      returned: collected.length,
    };

    if (!collected.length) {
      return { sections: null, reason: lastError || 'no_sections', trace, failedWindows, totalWindows };
    }

    const sections = collected
      .slice()
      .sort((a, b) => a.startSeconds - b.startSeconds)
      .map((section, i) => ({ ...section, question: { ...section.question, index: i + 1 } }));

    return {
      sections,
      reason: failedWindows.length ? 'partial' : 'ok',
      diagnostics,
      trace,
      failedWindows,
      totalWindows,
      succeededWindows: totalWindows - failedWindows.length,
    };
  }

  return { generateForVideo, segmentVideo, classifyChapters, describeError, DEFAULT_PROXY_URL };
})();
