/**
 * How long a one-click answer to an agent's question is held before the run continues with it.
 * Every place that asks the question (the chat, the Reviews inbox, the run page) uses this one
 * window, so Undo is the same five seconds wherever the person picked.
 */

/** The window, in milliseconds, a person has to take a one-click answer back. */
export const ANSWER_UNDO_MILLISECONDS = 5_000;

let current = ANSWER_UNDO_MILLISECONDS;

/** The window now in force: {@link ANSWER_UNDO_MILLISECONDS} unless a test has shortened it. */
export function answerUndoMilliseconds(): number {
  return current;
}

/**
 * Sets the window and returns a function that puts the previous one back. A test that picks an
 * answer and waits for the run to continue sets it to `0`, so it does not spend five seconds on a
 * count it is not about; a test of the count itself sets the real window under fake timers.
 */
export function setAnswerUndoMilliseconds(milliseconds: number): () => void {
  const previous = current;
  current = milliseconds;
  return () => {
    current = previous;
  };
}
