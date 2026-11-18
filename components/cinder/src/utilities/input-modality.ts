/**
 * Which kind of input the person used last, written to the document element as
 * `data-cinder-input-modality`: `keyboard` or `pointer`, and absent until the first input.
 *
 * The browser's `:focus-visible` also matches a focus the page moves by script when the element
 * focused before it showed a ring, or when nothing has been touched yet, so a tap or a cold load
 * followed by a script focus (a page that opens on the thing waiting for an answer) can draw a ring
 * round a landing target nobody tabbed to. The foundation stylesheet draws the ring on a script
 * focus target (`[tabindex='-1']`) only while this says `keyboard`
 * (`documentation/focus-ring-policy.md`, "Script focus targets").
 */

/** The attribute on the document element that carries the last input's kind. */
export const INPUT_MODALITY_ATTRIBUTE = 'data-cinder-input-modality';

/** The modifier keys alone move nothing, so they do not say the keyboard is in use. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/**
 * Starts tracking input on `target` (the document by default) and returns the function that stops
 * it and removes the attribute.
 */
export function trackInputModality(target: Document = document): () => void {
  const root = target.documentElement;
  const onKeyDown = (event: KeyboardEvent): void => {
    if (MODIFIER_KEYS.has(event.key)) return;
    root.setAttribute(INPUT_MODALITY_ATTRIBUTE, 'keyboard');
  };
  const onPointer = (): void => {
    root.setAttribute(INPUT_MODALITY_ATTRIBUTE, 'pointer');
  };
  const options = { capture: true, passive: true } as const;
  target.addEventListener('keydown', onKeyDown, options);
  target.addEventListener('pointerdown', onPointer, options);
  target.addEventListener('mousedown', onPointer, options);
  target.addEventListener('touchstart', onPointer, options);
  return () => {
    target.removeEventListener('keydown', onKeyDown, options);
    target.removeEventListener('pointerdown', onPointer, options);
    target.removeEventListener('mousedown', onPointer, options);
    target.removeEventListener('touchstart', onPointer, options);
    root.removeAttribute(INPUT_MODALITY_ATTRIBUTE);
  };
}
