/**
 * The checkpoint card. Mounted inside the player element so it stays visible in
 * fullscreen and theatre mode.
 */
window.FocusFlow = window.FocusFlow || {};

window.FocusFlow.overlay = (() => {
  let root = null;

  function mountPoint() {
    return document.querySelector('#movie_player') || document.body;
  }

  function destroy() {
    root?.remove();
    root = null;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  /**
   * @returns {Promise<'continue'|'rewatch'>} how the user wants to proceed
   */
  function show(question, meta) {
    destroy();

    return new Promise((resolve) => {
      root = el('div', 'ff-backdrop');

      const card = el('div', 'ff-card');
      card.appendChild(
        el('div', 'ff-eyebrow', `Checkpoint ${meta.index} of ${meta.total}`)
      );
      if (meta.sectionTitle) card.appendChild(el('div', 'ff-section-title', meta.sectionTitle));
      card.appendChild(el('h2', 'ff-prompt', question.prompt));

      const list = el('div', 'ff-choices');
      const feedback = el('div', 'ff-feedback');
      const actions = el('div', 'ff-actions');

      const finish = (outcome) => {
        destroy();
        resolve(outcome);
      };

      question.choices.forEach((choice, i) => {
        const button = el('button', 'ff-choice', choice);
        button.addEventListener('click', () => {
          if (list.dataset.answered) return;
          list.dataset.answered = 'true';

          const correct = i === question.answerIndex;
          list.children[question.answerIndex].classList.add('ff-correct');
          if (!correct) button.classList.add('ff-wrong');

          feedback.textContent = correct
            ? 'Correct - you were following along.'
            : `Not quite. ${question.note || 'Worth a quick rewind.'}`;
          feedback.classList.add(correct ? 'ff-good' : 'ff-bad');

          actions.appendChild(primary(correct ? 'Keep watching' : 'Continue anyway'));
          if (!correct) actions.appendChild(secondary('Rewatch this section'));
        });
        list.appendChild(button);
      });

      function primary(label) {
        const button = el('button', 'ff-btn ff-btn-primary', label);
        button.addEventListener('click', () => finish('continue'));
        return button;
      }

      function secondary(label) {
        const button = el('button', 'ff-btn', label);
        button.addEventListener('click', () => finish('rewatch'));
        return button;
      }

      const skip = el('button', 'ff-skip', 'Skip this one');
      skip.addEventListener('click', () => finish('continue'));

      card.append(list, feedback, actions, skip);
      root.appendChild(card);
      mountPoint().appendChild(root);

      list.querySelector('.ff-choice')?.focus();
    });
  }

  function toast(message, durationMs = 4000) {
    const node = el('div', 'ff-toast', message);
    mountPoint().appendChild(node);
    setTimeout(() => node.remove(), durationMs);
  }

  return { show, destroy, toast };
})();
