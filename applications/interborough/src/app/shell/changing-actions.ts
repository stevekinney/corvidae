/**
 * Holds back the controls that change something while the server does not answer, for every page
 * at once, without touching what the page decided about them. A control changes something when it
 * submits a form or carries `data-changes`; a page that has a changing control which is neither
 * marks it, and `changing-controls.guard.test.ts` fails when one that calls a write does not. The
 * request itself is refused too (`../../lib/write-guard.ts`), so this is the visible half.
 *
 * Nothing here writes the `disabled` property, so the page's own state is never read or changed: a
 * Save the page keeps disabled until the form is edited stays that way, and one the page enables
 * on the first keystroke is still held. What changes is three things, all undone when the server
 * answers:
 *
 * - the shell's `data-connection="unreachable"` attribute, which one rule in `foundation.css`
 *   reads to dim `CHANGING_ACTION_SELECTOR`;
 * - a capture-phase `click` and `submit` handler on the document, which stops the activation
 *   before the page's own handler sees it, from a pointer, from Enter, and from Space alike;
 * - `aria-disabled="true"` and the reason as the title on a control that carries neither, so a
 *   screen reader says it is off and the control stays focusable and reachable. A control that
 *   already has either keeps the page's value, which is also what is put back.
 */

/** The controls that change something: a marked one, and a submit button. */
export const CHANGING_ACTION_SELECTOR =
  '[data-changes], button[type="submit"], input[type="submit"]';

/** What a click can land on: the nearest of these decides, so a marked container never holds its children. */
const ACTIVATABLE = 'button, input, select, a, summary, [role="button"], [role="menuitem"]';

/** What this module added to a control, so it removes that and nothing else. */
interface Added {
  readonly aria: boolean;
  readonly title: boolean;
}

function isChanging(element: Element | null): element is HTMLElement {
  return element instanceof HTMLElement && element.matches(CHANGING_ACTION_SELECTOR);
}

/** The changing control a click landed on, or `null` when it landed on anything else. */
function changingTarget(event: Event): HTMLElement | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const activatable = target.closest(ACTIVATABLE);
  return isChanging(activatable) ? activatable : null;
}

/**
 * Holds every changing control under `root` (and any rendered later) until the returned function
 * is called. `reason` is the title a held control shows.
 */
export function holdChangingActions(root: HTMLElement, reason: string): () => void {
  const held = new Map<HTMLElement, Added>();

  function hold(control: HTMLElement): void {
    if (held.has(control)) return;
    const aria = !control.hasAttribute('aria-disabled');
    const title = !control.hasAttribute('title');
    if (aria) control.setAttribute('aria-disabled', 'true');
    if (title) control.setAttribute('title', reason);
    held.set(control, { aria, title });
  }

  function holdWithin(parent: Element): void {
    if (isChanging(parent)) hold(parent);
    for (const control of parent.querySelectorAll<HTMLElement>(CHANGING_ACTION_SELECTOR)) {
      hold(control);
    }
  }

  const refuse = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onClick = (event: Event): void => {
    if (changingTarget(event) !== null) refuse(event);
  };
  const onSubmit = (event: Event): void => {
    const submitter = event instanceof SubmitEvent ? event.submitter : null;
    if (
      isChanging(submitter) ||
      isChanging(event.target instanceof Element ? event.target : null)
    ) {
      refuse(event);
    }
  };

  const ownerDocument = root.ownerDocument;
  ownerDocument.addEventListener('click', onClick, true);
  ownerDocument.addEventListener('submit', onSubmit, true);
  holdWithin(root);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const added of record.addedNodes) {
        if (added instanceof Element) holdWithin(added);
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });

  return () => {
    observer.disconnect();
    ownerDocument.removeEventListener('click', onClick, true);
    ownerDocument.removeEventListener('submit', onSubmit, true);
    for (const [control, added] of held) {
      if (added.aria && control.getAttribute('aria-disabled') === 'true') {
        control.removeAttribute('aria-disabled');
      }
      if (added.title && control.getAttribute('title') === reason) {
        control.removeAttribute('title');
      }
    }
    held.clear();
  };
}
