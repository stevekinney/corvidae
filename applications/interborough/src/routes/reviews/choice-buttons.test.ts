/**
 * The buttons the number keys press in an open question (`choice-buttons.ts`), over the markup
 * `ChatQuestion` draws for each kind of question.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { choiceButtons, pickChoice } from './choice-buttons.ts';

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  root.remove();
});

/** Markup shaped like `ChatQuestion`'s: a root with its kind, and a column of buttons. */
function question(kind: string, labels: readonly string[], extra = ''): void {
  root.innerHTML = `
    <div class="chat-question" data-question-kind="${kind}">
      <div class="chat-question-choices" role="group">
        ${labels.map((label) => `<button type="button" class="chat-question-choice">${label}</button>`).join('')}
      </div>
      ${extra}
    </div>`;
}

describe('the buttons a number key presses', () => {
  test('are the choices of a choice question, in the order they are drawn', () => {
    question('choice', ['staging', 'production']);
    expect(choiceButtons(root).map((button) => button.textContent)).toEqual([
      'staging',
      'production',
    ]);
  });

  test('leave out Something else… until its field is open, and then count the last button', () => {
    question('choice-other', ['staging', 'production', 'Something else…']);
    expect(choiceButtons(root).map((button) => button.textContent)).toEqual([
      'staging',
      'production',
    ]);
    // Its field is open: the button is gone and the last button is a choice again.
    question('choice-other', ['staging', 'production'], '<form class="chat-question-row"></form>');
    expect(choiceButtons(root)).toHaveLength(2);
  });

  test('are yes and no for a yes-or-no question', () => {
    question('boolean', ['Yes', 'No']);
    expect(choiceButtons(root).map((button) => button.textContent)).toEqual(['Yes', 'No']);
  });

  test('are none for the kinds that have no single press that answers them', () => {
    for (const kind of ['text', 'multiple', 'rating', 'number', 'secret', 'form']) {
      question(kind, ['a', 'b']);
      expect(choiceButtons(root)).toEqual([]);
    }
  });

  test('are none when nothing is drawn', () => {
    expect(choiceButtons(root)).toEqual([]);
    expect(choiceButtons(undefined)).toEqual([]);
    expect(choiceButtons(null)).toEqual([]);
  });
});

describe('picking a choice by its number', () => {
  test('presses the button at that position, counting from 1', () => {
    question('choice', ['staging', 'production']);
    const pressed: string[] = [];
    for (const button of choiceButtons(root)) {
      button.addEventListener('click', () => pressed.push(button.textContent ?? ''));
    }
    expect(pickChoice(root, 2)).toBe(true);
    expect(pressed).toEqual(['production']);
  });

  test('presses nothing for a position past the last choice, or for zero', () => {
    question('choice', ['staging']);
    expect(pickChoice(root, 2)).toBe(false);
    expect(pickChoice(root, 0)).toBe(false);
  });

  test('presses nothing while the choice is disabled, as while an answer is being sent', () => {
    question('choice', ['staging']);
    choiceButtons(root)[0]!.disabled = true;
    expect(pickChoice(root, 1)).toBe(false);
  });
});
