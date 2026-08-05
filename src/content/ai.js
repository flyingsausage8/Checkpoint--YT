window.FocusFlow = window.FocusFlow || {};

window.FocusFlow.ai = (() => {
  const AI_PROXY_ENABLED_IN_THIS_BUILD = true;
  const DEFAULT_PROXY_URL = 'https://func-checkpoint-yt-pb5kh8.azurewebsites.net/api/generate';

  // The backend caps each request at 24 chunks and 50k transcript characters.
  // We stay under both by splitting long videos into several requests, so the
  // chunk length setting can never silently disable AI questions.
  const MAX_CHUNKS_PER_REQUEST = 12;
  const MAX_CHARS_PER_REQUEST = 40000;

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

    for (const batch of batches) {
      const result = await askBackground({ videoId, title, chunks: batch });
      if (!result?.ok) {
        lastError = result?.error || 'unknown';
        console.warn('[FocusFlow] AI batch failed:', lastError);
        continue;
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

    if (!covered) return { questions: null, reason: lastError || 'no_questions' };
    return {
      questions: bySlot,
      reason: covered < chunks.length ? 'partial' : 'ok',
      covered,
      total: chunks.length,
    };
  }

  return { generateForVideo, DEFAULT_PROXY_URL };
})();
