/**
 * Turns off the controls that change something while the server does not answer, for every page
 * at once. A control changes something when it submits a form or carries `data-changes`; a page
 * that has a changing control which is neither marks it. The mutation cache refuses the change
 * itself (`guardChanges`, `../connection.svelte.ts`), so this is the visible half: the control is
 * `disabled`, with the reason as its title, and goes back exactly as it was when the server
 * answers. A control a page already disabled is left alone and stays disabled.
 */

/** The controls that change something. */
export const CHANGING_ACTION_SELECTOR =
  '[data-changes], button[type="submit"], input[type="submit"]';

/** Marks a control this module disabled, so it is the only one it enables again. */
const DISABLED_BY_US = 'data-connection-disabled';

type Control = HTMLButtonElement | HTMLInputElement;

function isControl(element: Element): element is Control {
  return element instanceof HTMLButtonElement || element instanceof HTMLInputElement;
}

function disable(control: Control, reason: string): void {
  if (control.disabled || control.hasAttribute('data-keeps-enabled')) return;
  control.disabled = true;
  control.setAttribute(DISABLED_BY_US, control.getAttribute('title') ?? '');
  if (!control.hasAttribute('title')) control.setAttribute('title', reason);
}

function restore(control: Control): void {
  const previousTitle = control.getAttribute(DISABLED_BY_US);
  if (previousTitle === null) return;
  control.disabled = false;
  control.removeAttribute(DISABLED_BY_US);
  if (previousTitle === '') control.removeAttribute('title');
  else control.setAttribute('title', previousTitle);
}

function changingControls(root: ParentNode): Control[] {
  return [...root.querySelectorAll(CHANGING_ACTION_SELECTOR)].filter(isControl);
}

/**
 * Disables every changing control under `root`, now and as the page renders more, until the
 * returned function is called. `reason` is the title a disabled control shows.
 */
export function disableChangingActions(root: HTMLElement, reason: string): () => void {
  for (const control of changingControls(root)) disable(control, reason);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const added of record.addedNodes) {
        if (!(added instanceof Element)) continue;
        if (added.matches(CHANGING_ACTION_SELECTOR) && isControl(added)) disable(added, reason);
        for (const control of changingControls(added)) disable(control, reason);
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    for (const control of root.querySelectorAll(`[${DISABLED_BY_US}]`)) {
      if (isControl(control)) restore(control);
    }
  };
}
