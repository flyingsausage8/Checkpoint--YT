window.FocusFlow = window.FocusFlow || {};

window.FocusFlow.questionBank = (() => {
  const QUESTIONS = [
    {
      type: 'mc',
      prompt: 'Quick recall: what would you tell a friend the last section was mostly about?',
      choices: ['I can explain the main point', 'Only a few words', 'I am not sure', 'I was not watching'],
      answerIndex: 0,
      note: 'If you cannot explain it simply, rewatching a short piece can help.',
    },
    {
      type: 'tf',
      prompt: 'True or false: I am still watching for the reason I opened this video.',
      choices: ['True', 'False'],
      answerIndex: 0,
      note: 'If the goal changed, pause and decide whether this video still deserves your time.',
    },
    {
      type: 'mc',
      prompt: 'Which best describes your attention during the last few minutes?',
      choices: ['Focused', 'Mostly focused', 'Drifting', 'Doing something else'],
      answerIndex: 0,
      note: 'Honest answers are useful; this is a focus check, not a grade.',
    },
    {
      type: 'mc',
      prompt: 'What is one useful next action right now?',
      choices: ['Keep watching', 'Rewatch the last section', 'Take one note', 'Close the video'],
      answerIndex: 0,
      note: 'Choose intentionally before continuing.',
    },
    {
      type: 'tf',
      prompt: 'True or false: I could write one sentence summarising what just happened.',
      choices: ['True', 'False'],
      answerIndex: 0,
      note: 'A one-sentence summary is a strong sign you were following.',
    },
    {
      type: 'mc',
      prompt: 'If this section had one key idea, how clear is it to you?',
      choices: ['Very clear', 'Somewhat clear', 'Vague', 'Not clear at all'],
      answerIndex: 0,
      note: 'If it feels vague, rewind a minute instead of pushing through.',
    },
    {
      type: 'tf',
      prompt: 'True or false: my eyes were on the video for most of that section.',
      choices: ['True', 'False'],
      answerIndex: 0,
      note: 'If not, this checkpoint did its job. Rewatch or reset your environment.',
    },
    {
      type: 'mc',
      prompt: 'What would help you absorb the next section better?',
      choices: ['Stay as I am', 'Remove a distraction', 'Take notes', 'Speed down the video'],
      answerIndex: 0,
      note: 'Small adjustments can save a lot of rewatching.',
    },
    {
      type: 'tf',
      prompt: 'True or false: I know why this video matters to my current task.',
      choices: ['True', 'False'],
      answerIndex: 0,
      note: 'Reconnecting to the task makes it easier to stay engaged.',
    },
    {
      type: 'mc',
      prompt: 'Pick the most honest summary of the last section.',
      choices: ['I understood it', 'I understood part of it', 'I missed the main point', 'I need a break'],
      answerIndex: 0,
      note: 'Use this as a quick reset before continuing.',
    },
    {
      type: 'mc',
      prompt: 'What is the best way to prove you followed that section?',
      choices: ['Say the main point out loud', 'Keep watching without checking', 'Open another tab', 'Skip ahead'],
      answerIndex: 0,
      note: 'Saying it out loud makes passive watching more active.',
    },
    {
      type: 'tf',
      prompt: 'True or false: I avoided opening unrelated tabs during that section.',
      choices: ['True', 'False'],
      answerIndex: 0,
      note: 'If false, close the extra tab before continuing.',
    },
    {
      type: 'mc',
      prompt: 'How much of the last section could you recall without replaying it?',
      choices: ['Most of it', 'About half', 'A little', 'Almost none'],
      answerIndex: 0,
      note: 'Recall is the point; choose rewatch if needed.',
    },
    {
      type: 'tf',
      prompt: 'True or false: continuing this video is still the best use of the next few minutes.',
      choices: ['True', 'False'],
      answerIndex: 0,
      note: 'It is okay to stop if the video is no longer useful.',
    },
    {
      type: 'mc',
      prompt: 'Before continuing, what should your brain hold onto from this section?',
      choices: ['One main idea', 'A small detail', 'Nothing yet', 'I need to rewind'],
      answerIndex: 0,
      note: 'Anchor one idea before moving on.',
    },
  ];

  const positions = new Map();

  function currentVideoKey() {
    try {
      if (location?.pathname === '/watch') {
        return new URLSearchParams(location.search).get('v') || 'default';
      }
    } catch (_) {}
    return 'default';
  }

  function clone(question) {
    return { ...question, choices: [...question.choices] };
  }

  function next(videoId = currentVideoKey()) {
    const key = videoId || 'default';
    const index = positions.get(key) || 0;
    positions.set(key, (index + 1) % QUESTIONS.length);
    return clone(QUESTIONS[index]);
  }

  return { next, QUESTIONS };
})();
