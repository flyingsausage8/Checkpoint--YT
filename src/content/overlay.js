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
   * @returns {Promise<'continue'|'rewatch'|'replay'>} how the user wants to proceed
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

      // A true/false retry would just hand over the answer, so those stay
      // single-shot. We detect the shape rather than trusting question.type
      // alone because offline and AI questions do not populate it identically.
      const isTrueFalse = question.type === 'tf' || question.choices.length <= 2;
      let hadWrong = false;

      const reveal = (chosenButton, correct) => {
        list.dataset.revealed = 'true';
        list.children[question.answerIndex].classList.add('ff-correct');
        if (!correct) chosenButton.classList.add('ff-wrong');

        feedback.className = 'ff-feedback';
        if (correct) {
          feedback.textContent = 'Correct - you were following along.';
        } else if (question.note) {
          // Describe what the video covered rather than judge the viewer.
          feedback.textContent = `This part covered: ${question.note}`;
        } else {
          feedback.textContent = 'Here is the part that covered it.';
        }
        feedback.classList.add(correct ? 'ff-good' : 'ff-bad');

        actions.appendChild(primary(correct ? 'Keep watching' : 'Got it, keep watching'));
        if (!correct) {
          if (Number.isFinite(question.answerSeconds)) {
            actions.appendChild(replay('Show me where'));
          } else {
            actions.appendChild(secondary('Rewatch this section'));
          }
        }
      };

      question.choices.forEach((choice, i) => {
        const button = el('button', 'ff-choice', choice);
        button.addEventListener('click', () => {
          if (list.dataset.revealed) return;
          if (button.classList.contains('ff-retired')) return;

          const correct = i === question.answerIndex;
          if (correct) {
            reveal(button, true);
            return;
          }

          // The first wrong pick on a multiple-choice question earns another
          // look: retire the chosen button without revealing anything.
          if (!isTrueFalse && !hadWrong) {
            hadWrong = true;
            button.classList.add('ff-retired');
            button.setAttribute('aria-disabled', 'true');
            feedback.className = 'ff-feedback ff-hint';
            feedback.textContent = 'Not that one — have another look.';
            const next = Array.from(list.children).find(
              (child) => child !== button && !child.classList.contains('ff-retired')
            );
            next?.focus();
            return;
          }

          reveal(button, false);
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

      function replay(label) {
        const button = el('button', 'ff-btn', label);
        button.addEventListener('click', () => finish('replay'));
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
