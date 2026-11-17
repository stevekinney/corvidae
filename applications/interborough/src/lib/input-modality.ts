/**
 * Which kind of input the person used last, written to the document as `data-input-modality`
 * (`keyboard` or `pointer`; absent until the first input). The browser's own `:focus-visible` also
 * matches a script focus when the element focused before it showed a ring, or when nothing was
 * touched yet, so a tap or a mouse press followed by a focus the page moves (the approval a chat
 * opens on) can still draw a ring there. A focus the page moves by script is drawn with a ring
 * only after the keyboard was the last input (`decisions.css`).
 */
const KEYBOARD = 'keyboard';
const POINTER = 'pointer';

/** The modifier keys alone move nothing, so they do not say the keyboard is in use. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/** Starts tracking on `target`'s document and returns the function that stops it. */
export function trackInputModality(target: Document = document): () => void {
  const root = target.documentElement;
  const onKeyDown = (event: KeyboardEvent): void => {
    if (MODIFIER_KEYS.has(event.key)) return;
    root.dataset['inputModality'] = KEYBOARD;
  };
  const onPointer = (): void => {
    root.dataset['inputModality'] = POINTER;
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
    delete root.dataset['inputModality'];
  };
}
