/**
 * The buttons of an open question that the number keys pick. `ChatQuestion` (the chat package)
 * draws a choice as a column of buttons and offers no handle to press one from outside, so the
 * keys press the buttons it drew. A choice question, a pick-one-or-something-else question and a
 * yes-or-no question are drawn as buttons; the others (text, several picks, a rating, a form) have
 * no single press that answers them, so no key picks anything there. "Something else…" is not a
 * choice: it opens a field, so it takes no number.
 */

/** The question kinds `ChatQuestion` answers with one press of a button. */
const BUTTON_KINDS = new Set(['choice', 'choice-other', 'boolean']);

/** The buttons a number key can press in `root`, in the order they are drawn. */
export function choiceButtons(root: ParentNode | null | undefined): HTMLButtonElement[] {
  const question = root?.querySelector('.chat-question');
  if (question === null || question === undefined) return [];
  const kind = question.getAttribute('data-question-kind');
  if (kind === null || !BUTTON_KINDS.has(kind)) return [];
  const buttons = [
    ...question.querySelectorAll<HTMLButtonElement>('.chat-question-choices button'),
  ];
  // Until the field of "Something else…" is open, the last button of a pick-or-other question is it.
  const otherOpen = question.querySelector('.chat-question-row') !== null;
  return kind === 'choice-other' && !otherOpen ? buttons.slice(0, -1) : buttons;
}

/**
 * Presses the choice at `position` (counting from 1), when there is one and it can be pressed.
 * Returns whether it pressed one, so the caller can tell a key that did nothing.
 */
export function pickChoice(root: ParentNode | null | undefined, position: number): boolean {
  const button = choiceButtons(root)[position - 1];
  if (button === undefined || button.disabled) return false;
  button.click();
  return true;
}
