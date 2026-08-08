window.FocusFlow = window.FocusFlow || {};

window.FocusFlow.validate = (() => {
  const DANGEROUS = /<script|javascript:|data:text\/html/i;

  function cleanString(value) {
    return String(value)
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function uniqueStrings(values) {
    return new Set(values.map((value) => value.toLowerCase())).size === values.length;
  }

  function containsDangerousString(values) {
    return values.some((value) => DANGEROUS.test(value));
  }

  // A tiny seeded PRNG (xmur3 seed -> mulberry32-style generator). We shuffle in
  // code rather than trusting the model to randomise, but validation runs in more
  // than one place - on freshly generated questions, on cache restore, and on
  // later rebuilds - so a Math.random() shuffle would reorder the same question
  // between page loads and make the answer appear to move when a viewer rewatches.
  // Seeding from the question's stable identity keeps the order deterministic.
  function seededRandom(seedText) {
    let h = 1779033703 ^ seedText.length;
    for (let i = 0; i < seedText.length; i++) {
      h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function next() {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return h >>> 0;
    };
  }

  // Permutes multiple-choice options so the correct answer is not always first,
  // and remaps answerIndex to follow it. The permutation is applied to the choices
  // in sorted order rather than the order they arrived in, which makes this
  // idempotent: re-validating an already-shuffled question (which happens on every
  // cache restore) reproduces the same arrangement instead of shuffling it again.
  function shuffleChoices(prompt, choices, answerIndex) {
    const answerText = choices[answerIndex];
    const canonical = [...choices].sort();
    const seedText = `${prompt}\u0000${canonical.join('\u0001')}`;
    const rand = seededRandom(seedText);
    const order = canonical.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = rand() % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    return {
      choices: order.map((i) => canonical[i]),
      answerIndex: order.indexOf(canonical.indexOf(answerText)),
    };
  }

  function normaliseItem(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (item.type !== 'mc' && item.type !== 'tf') return null;

    const prompt = cleanString(item.prompt || '');
    if (prompt.length < 10 || prompt.length > 220) return null;

    let choices = Array.isArray(item.choices) ? item.choices.map(cleanString) : [];
    if (item.type === 'tf') {
      if (choices.length !== 2 || choices[0] !== 'True' || choices[1] !== 'False') return null;
      choices = ['True', 'False'];
    }

    if (choices.length < 2 || choices.length > 4) return null;
    if (choices.some((choice) => choice.length < 1 || choice.length > 120)) return null;
    if (!uniqueStrings(choices)) return null;

    const answerIndex = item.answerIndex;
    if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= choices.length) {
      return null;
    }

    const note = cleanString(item.note || '');
    if (note.length > 200) return null;
    if (containsDangerousString([prompt, note, ...choices])) return null;

    // True/false must read as "True" then "False"; a shuffled one looks broken.
    // Detect it robustly - offline and AI questions do not populate `type`
    // identically - and leave it untouched. Everything else is permuted so a
    // viewer cannot pass by blindly clicking the first option.
    let finalChoices = choices;
    let finalAnswerIndex = answerIndex;
    if (item.type !== 'tf' && choices.length > 2) {
      const shuffled = shuffleChoices(prompt, choices, answerIndex);
      finalChoices = shuffled.choices;
      finalAnswerIndex = shuffled.answerIndex;
    }

    const result = { type: item.type, prompt, choices: finalChoices, answerIndex: finalAnswerIndex, note };
    // Issue #9: the absolute second where the answer is stated, used by the
    // overlay's "Show me where" replay. Optional: old cached questions and
    // offline questions may not carry it, so it is only added when finite.
    if (Number.isFinite(Number(item.answerSeconds))) {
      result.answerSeconds = Number(item.answerSeconds);
    }
    return result;
  }

  function questions(raw, expectedCount) {
    if (!Array.isArray(raw)) return null;
    const valid = raw
      .map((item) => {
        const normalised = normaliseItem(item);
        if (!normalised) return null;
        // Keep the chunk index so callers can align questions to checkpoints.
        return Number.isInteger(item.index) ? { ...normalised, index: item.index } : normalised;
      })
      .filter(Boolean);
    const needed = Math.max(1, Math.ceil(Number(expectedCount || 0) / 2));
    return valid.length >= needed ? valid : null;
  }

  // AI-chosen sections. Mirrors the backend contract: strictly increasing time
  // ranges, each carrying one valid question. Used for fresh backend responses
  // and to re-validate anything restored from the section cache.
  function sections(raw) {
    if (!Array.isArray(raw) || !raw.length) return null;
    const valid = [];
    let cursor = -Infinity;
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const startSeconds = Number(item.startSeconds);
      const endSeconds = Number(item.endSeconds);
      if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) continue;
      if (endSeconds <= startSeconds || startSeconds < cursor) continue;
      const question = normaliseItem(item.question);
      if (!question) continue;
      const title = cleanString(item.title || '').slice(0, 80);
      if (containsDangerousString([title])) continue;
      cursor = endSeconds;
      valid.push({
        startSeconds,
        endSeconds,
        title,
        question: Number.isInteger(item.question.index)
          ? { ...question, index: item.question.index }
          : question,
      });
    }
    return valid.length ? valid : null;
  }

  return { questions, sections };
})();
