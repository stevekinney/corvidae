/**
 * The elements that mark a field as having a problem: a control whose error is set (`aria-invalid`),
 * a custom control that reports the same through `data-cinder-invalid`, and the message a
 * schema-driven form draws for a value that has no single control.
 */
export const PROBLEM_SELECTOR =
  '[aria-invalid="true"], [data-cinder-invalid="true"], .cinder-schema-form__error';

/**
 * Moves focus to the first problem in a form, in document order, and returns it, or returns
 * `undefined` when the form has none. The control is scrolled into view when it is outside the
 * viewport.
 *
 * A form keeps its Save enabled while it is invalid, so pressing it is how a person learns what is
 * wrong; this is where that press lands them. A disabled control is skipped because it cannot take
 * focus.
 */
export function focusFirstProblem(form: HTMLElement): HTMLElement | undefined {
  for (const candidate of form.querySelectorAll<HTMLElement>(PROBLEM_SELECTOR)) {
    if (candidate.matches(':disabled')) continue;
    candidate.focus();
    if (typeof candidate.scrollIntoView === 'function') {
      candidate.scrollIntoView({ block: 'nearest' });
    }
    return candidate;
  }
  return undefined;
}
