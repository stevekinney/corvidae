/**
 * The "Search components" shortcut and the DOM hooks it shares with the landing
 * entry.
 *
 * Kept apart from the palette's ranking and routing helpers so the landing entry,
 * which must answer Cmd/Ctrl+K before the shell hydrates, bundles only this.
 */

/** Accessible name and visible text of the palette trigger. */
export const COMPONENT_SEARCH_LABEL = 'Search components';

/** Data attribute on the trigger button; the landing entry finds it by this hook. */
export const COMPONENT_SEARCH_TRIGGER_ATTRIBUTE = 'data-component-search-trigger';

/**
 * Set on the trigger while the hydrated shortcut listener is attached. The
 * landing entry's pre-hydration listener handles presses until this appears, so
 * no press falls between hydration finishing and the real listener attaching.
 */
export const COMPONENT_SEARCH_LISTENING_ATTRIBUTE = 'data-component-search-listening';

/** Input types that take typed text; any other `<input>` is a button, toggle, or slider. */
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** The focused element, following focus into open shadow roots. */
function deepActiveElement(document: Document): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

function isEditable(element: Element | null): boolean {
  if (element === null) return false;
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(element.type);
  return element instanceof HTMLElement && element.isContentEditable;
}

/**
 * True when a keydown should open the palette: Cmd+K or Ctrl+K with no other
 * modifier, not a held-key repeat, not mid IME composition, not while a text
 * control has focus (including one inside a shadow root), and not while any
 * dialog is already open — a demo dialog, or the palette itself.
 */
export function isComponentSearchShortcut(event: KeyboardEvent, document: Document): boolean {
  if (event.defaultPrevented || event.repeat) return false;
  if (event.isComposing || event.key === 'Process') return false;
  if (event.key.toLowerCase() !== 'k') return false;
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false;
  if (isEditable(deepActiveElement(document))) return false;
  // A closed `<dialog aria-modal="true">` — the palette's own, kept mounted between
  // opens — is not an open dialog, so only an open `<dialog>` or a non-dialog
  // element declaring itself modal blocks the shortcut.
  return document.querySelector('dialog[open], [aria-modal="true"]:not(dialog)') === null;
}
