/**
 * Offline question generation. Transcript questions are built locally with no AI,
 * API key, or non-YouTube network call. If captions are unavailable, a hardcoded
 * ADHD-friendly check-in bank keeps checkpoints useful.
 */
window.FocusFlow = window.FocusFlow || {};

window.FocusFlow.questions = (() => {
  const STOP_WORDS = new Set(
    `a about actually after all also am an and any are as at back be because been before
     being but by can cause come could did do does doing done down each even every first
     for from get gets getting go going good got had has have having he her here hers him
     his how i if in into is it its just kind know let like little look lot make many maybe
     me might more most much my need no not now of off ok on one only or other our out over
     really right said same say says see she should so some something start still such take
     than that the their them then there these they thing things think this those through
     time to too two up us use used using very want was way we well went were what when
     where which while who why will with would yeah yes yet you your video section`.split(/\s+/)
  );

  function fallback(videoId) {
    return window.FocusFlow.questionBank?.next(videoId) || {
      type: 'tf',
      prompt: 'True or false: I can summarise the last section before continuing.',
      choices: ['True', 'False'],
      answerIndex: 0,
      note: 'If not, rewatching a short piece is better than zoning out.',
    };
  }

  function cleanText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function sentences(text) {
    return cleanText(text)
      .split(/(?<=[.!?])\s+|\s{2,}/)
      .map((s) => s.trim())
      .filter((s) => {
        const words = s.split(/\s+/).filter(Boolean);
        return words.length >= 10 && words.length <= 32 && s.length >= 50;
      });
  }

  function normalisePhrase(word) {
    return word.toLowerCase().replace(/['’]s$/, '').replace(/s$/, '');
  }

  function tooSimilar(a, b) {
    const left = normalisePhrase(a);
    const right = normalisePhrase(b);
    return left === right || left.includes(right) || right.includes(left);
  }

  /** Pulls out the words a section is actually about. */
  function keyPhrases(text, limit = 6) {
    const counts = new Map();
    for (const raw of cleanText(text).split(/[^A-Za-z0-9'-]+/)) {
      const word = raw.trim();
      if (word.length < 4 || /^\d+$/.test(word)) continue;
      const key = word.toLowerCase();
      if (STOP_WORDS.has(key)) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }

    const selected = [];
    for (const [word] of [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || b[0].length - a[0].length
    )) {
      if (selected.some((existing) => tooSimilar(existing, word))) continue;
      selected.push(word);
      if (selected.length >= limit) break;
    }
    return selected;
  }

  function shuffleWithAnswer(correct, distractors) {
    const options = [correct, ...distractors];
    for (let i = options.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [options[i], options[j]] = [options[j], options[i]];
    }
    return { choices: options, answerIndex: options.indexOf(correct) };
  }

  function negate(sentence) {
    const swaps = [
      [/\bis\b/i, 'is not'],
      [/\bare\b/i, 'are not'],
      [/\bwas\b/i, 'was not'],
      [/\bwere\b/i, 'were not'],
      [/\bwill\b/i, 'will not'],
      [/\bcan\b/i, 'cannot'],
      [/\bshould\b/i, 'should not'],
      [/\balways\b/i, 'never'],
      [/\bmore\b/i, 'less'],
      [/\bincrease(s|d)?\b/i, 'decreases'],
    ];
    for (const [pattern, replacement] of swaps) {
      if (pattern.test(sentence)) return sentence.replace(pattern, replacement);
    }
    return null;
  }

  function buildTrueFalse(chunkText) {
    const candidates = sentences(chunkText).sort(() => Math.random() - 0.5);
    for (const sentence of candidates) {
      const flipped = negate(sentence);
      const useFalse = Boolean(flipped && Math.random() < 0.5);
      const statement = useFalse ? flipped : sentence;
      if (statement.length < 50) continue;
      return {
        type: 'tf',
        prompt: `True or false - the video just said: "${statement}"`,
        choices: ['True', 'False'],
        answerIndex: useFalse ? 1 : 0,
        note: useFalse ? `The video actually said: "${sentence}"` : '',
      };
    }
    return null;
  }

  function buildMultipleChoice(chunkText, otherChunksText) {
    const correct = keyPhrases(chunkText, 5)[0];
    if (!correct) return null;

    const chunkLower = chunkText.toLowerCase();
    const distractors = [];
    for (const word of keyPhrases(otherChunksText, 24)) {
      if (chunkLower.includes(word.toLowerCase())) continue;
      if (tooSimilar(correct, word)) continue;
      if (distractors.some((existing) => tooSimilar(existing, word))) continue;
      distractors.push(word);
      if (distractors.length === 3) break;
    }

    if (distractors.length < 3) return null;

    const { choices, answerIndex } = shuffleWithAnswer(correct, distractors);
    return {
      type: 'mc',
      prompt: 'Which of these was actually talked about in the section you just watched?',
      choices,
      answerIndex,
      note: '',
    };
  }

  /**
   * @param {string} chunkText        transcript for the section just watched
   * @param {string} otherChunksText  transcript for the rest of the video
   * @param {string=} videoId         used only to rotate the no-caption bank
   */
  function generate(chunkText, otherChunksText = '', videoId) {
    const text = cleanText(chunkText);
    if (!text || text.split(/\s+/).length < 25) return fallback(videoId);

    const builders = [
      () => buildMultipleChoice(text, otherChunksText),
      () => buildTrueFalse(text),
    ];
    if (Math.random() < 0.5) builders.reverse();

    for (const build of builders) {
      const question = build();
      if (question) return question;
    }
    return fallback(videoId);
  }

  return { generate, keyPhrases };
})();
