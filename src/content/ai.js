window.FocusFlow = window.FocusFlow || {};

window.FocusFlow.ai = (() => {
  const AI_PROXY_ENABLED_IN_THIS_BUILD = true;
  const DEFAULT_PROXY_URL = 'https://func-checkpoint-yt-pb5kh8.azurewebsites.net/api/generate';

  // The backend caps each request at 24 chunks and 50k transcript characters.
  // We stay under both by splitting long videos into several requests, so the
  // chunk length setting can never silently disable AI questions.
  const MAX_CHUNKS_PER_REQUEST = 12;
  const MAX_CHARS_PER_REQUEST = 40000;

  // Segment mode limits. Keep each window well under the backend's 1200-line /
  // 50k-char caps so a long video is split into several contiguous requests.
  const MAX_LINES_PER_WINDOW = 900;
  const MAX_CHARS_PER_WINDOW = 35000;

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

  // Returns { questions, reason }. `questions` is a sparse array indexed by
  // chunk index so a partial result still improves the checkpoints it covers.
  async function generateForVideo({ videoId, title, chunks }) {
    if (!AI_PROXY_ENABLED_IN_THIS_BUILD) return { questions: null, reason: 'disabled_in_build' };
    if (!videoId || !Array.isArray(chunks) || !chunks.length) {
      return { questions: null, reason: 'no_chunks' };
    }

    const batches = batchChunks(chunks);
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

    for (const batch of batches) {
      charsSent += batch.reduce((sum, chunk) => sum + String(chunk.text || '').length, 0);
      const result = await askBackground({ videoId, title, chunks: batch });
      if (result?.endpoint) endpoint = result.endpoint;
      if (!result?.ok) {
        lastError = result?.error || 'unknown';
        console.warn('[FocusFlow] AI batch failed:', lastError);
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
        lastError = 'invalid_output';
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
  // the per-request line and character caps. Windows tile the whole video: the
  // first starts at 0, each following one starts where the previous ended, and
  // the last runs to durationSeconds so nothing is left uncovered.
  function buildWindows(lines, durationSeconds) {
    const groups = [];
    let current = [];
    let chars = 0;

    for (const line of lines) {
      const size = line.text.length;
      const tooManyLines = current.length >= MAX_LINES_PER_WINDOW;
      const tooManyChars = current.length > 0 && chars + size > MAX_CHARS_PER_WINDOW;
      if (tooManyLines || tooManyChars) {
        groups.push(current);
        current = [];
        chars = 0;
      }
      current.push(line);
      chars += size;
    }
    if (current.length) groups.push(current);

    return groups.map((group, i) => ({
      lines: group,
      windowStart: i === 0 ? 0 : group[0].t,
      windowEnd: i === groups.length - 1 ? durationSeconds : groups[i + 1][0].t,
    }));
  }

  // Returns { sections, reason, diagnostics, trace }. `sections` is null when no
  // window produced usable output. Sections are concatenated across windows in
  // time order and their question index is renumbered sequentially (1-based).
  async function segmentVideo({ videoId, title, cues, durationSeconds, settings }) {
    if (!AI_PROXY_ENABLED_IN_THIS_BUILD) return { sections: null, reason: 'disabled_in_build' };
    if (!videoId || !Array.isArray(cues) || !cues.length) {
      return { sections: null, reason: 'no_transcript' };
    }

    const lines = cues
      .map((cue) => ({
        t: Math.max(0, Math.round(Number(cue.start) || 0)),
        text: String(cue.text || '').trim(),
      }))
      .filter((line) => line.text);
    if (!lines.length) return { sections: null, reason: 'no_transcript' };

    const total = Math.max(Number(durationSeconds) || 0, lines[lines.length - 1].t + 1);
    const target = ((settings && settings.chunkMinutes) || 3) * 60;
    const minSectionSeconds = Math.max(45, Math.round(target * 0.6));
    const maxSectionSeconds = Math.max(minSectionSeconds + 60, Math.round(target * 2));

    const windows = buildWindows(lines, total);
    const collected = [];
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

    for (const win of windows) {
      if (win.windowEnd <= win.windowStart) continue;
      charsSent += win.lines.reduce((sum, line) => sum + line.text.length, 0);
      const result = await askSegment({
        videoId,
        title,
        windowStart: win.windowStart,
        windowEnd: win.windowEnd,
        minSectionSeconds,
        maxSectionSeconds,
        lines: win.lines,
      });
      if (result?.endpoint) endpoint = result.endpoint;
      if (!result?.ok) {
        lastError = result?.error || 'unknown';
        console.warn('[FocusFlow] segment window failed:', lastError);
        continue;
      }

      if (result.diagnostics) {
        diagnostics.receivedLines += result.diagnostics.receivedLines || 0;
        diagnostics.receivedChars += result.diagnostics.receivedChars || 0;
        diagnostics.deployment = result.diagnostics.deployment || diagnostics.deployment;
        diagnostics.modelLatencyMs += result.diagnostics.modelLatencyMs || 0;
        diagnostics.windows += 1;
      }

      const validated = window.FocusFlow.validate.sections(result.sections);
      if (!validated) {
        lastError = 'invalid_output';
        continue;
      }
      collected.push(...validated);
    }

    const trace = {
      mode: 'segment',
      endpoint,
      requests: windows.length,
      charsSent,
      diagnostics,
      returned: collected.length,
    };

    if (!collected.length) return { sections: null, reason: lastError || 'no_sections', trace };

    const sections = collected.map((section, i) => ({
      ...section,
      question: { ...section.question, index: i + 1 },
    }));
    return { sections, reason: 'ok', diagnostics, trace };
  }

  return { generateForVideo, segmentVideo, DEFAULT_PROXY_URL };
})();
