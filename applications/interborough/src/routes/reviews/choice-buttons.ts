/**
 * The choices of an open question that the number keys pick. `ChatQuestion` (the chat package)
 * draws a choice as a grid of radio cards (`role="radio"`) and offers no handle to pick one from
 * outside, so the keys click the cards it drew. A choice question, a pick-one-or-something-else
 * question and a yes-or-no question are drawn as radio cards; the others (text, several picks, a
 * rating, a form) have no single press that answers them, so no key picks anything there. The field
 * below a pick-one-or-something-else question is not a choice, so it takes no number. Once a choice
 * is picked the question is held for its Undo window, and no key picks another.
 */

/** The question kinds `ChatQuestion` answers with one click of a radio card. */
const CHOICE_KINDS = new Set(['choice', 'choice-other', 'boolean']);

/** The radio cards a number key can pick in `root`, in the order they are drawn. */
export function choiceButtons(root: ParentNode | null | undefined): HTMLElement[] {
  const question = root?.querySelector('.chat-question');
  if (question === null || question === undefined) return [];
  const kind = question.getAttribute('data-question-kind');
  if (kind === null || !CHOICE_KINDS.has(kind)) return [];
  return [...question.querySelectorAll<HTMLElement>('.chat-question-choices [role="radio"]')];
}

/**
 * Picks the choice at `position` (counting from 1), when there is one and it can be picked.
 * Returns whether it picked one, so the caller can tell a key that did nothing.
 */
export function pickChoice(root: ParentNode | null | undefined, position: number): boolean {
  const choice = choiceButtons(root)[position - 1];
  if (choice === undefined || choice.getAttribute('aria-disabled') === 'true') return false;
  // A choice already picked is held; the question is not open for another pick.
  const phase = choice.closest('.chat-question')?.getAttribute('data-question-phase');
  if (phase !== undefined && phase !== null && phase !== 'open') return false;
  choice.click();
  return true;
}
