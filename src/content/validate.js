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

  function normaliseItem(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (item.type !== 'mc' && item.type !== 'tf') return null;

    const prompt = cleanString(item.prompt || '');
    if (prompt.length < 10 || prompt.length > 400) return null;

    let choices = Array.isArray(item.choices) ? item.choices.map(cleanString) : [];
    if (item.type === 'tf') {
      if (choices.length !== 2 || choices[0] !== 'True' || choices[1] !== 'False') return null;
      choices = ['True', 'False'];
    }

    if (choices.length < 2 || choices.length > 4) return null;
    if (choices.some((choice) => choice.length < 1 || choice.length > 200)) return null;
    if (!uniqueStrings(choices)) return null;

    const answerIndex = item.answerIndex;
    if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= choices.length) {
      return null;
    }

    const note = cleanString(item.note || '');
    if (note.length > 300) return null;
    if (containsDangerousString([prompt, note, ...choices])) return null;

    return { type: item.type, prompt, choices, answerIndex, note };
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

  return { questions };
})();
