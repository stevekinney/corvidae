import type { Attachment } from 'svelte/attachments';

/** The attribute a stem carries once its text was shortened to fit, which turns its own clip off. */
export const FITTED_ATTRIBUTE = 'data-fitted';

const ELLIPSIS = '…';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** A name's characters as a person counts them, so a cut never lands inside a combined one. */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/**
 * The longest start of a file name's stem that fits a width with an ellipsis after it, or the whole
 * stem when that fits. A stem that cannot fit even one character keeps one, so a name is never
 * only an ellipsis.
 */
export function fitStem(
  stem: string,
  measure: (text: string) => number,
  available: number,
): string {
  if (measure(stem) <= available) return stem;
  const characters = graphemes(stem);
  let low = 1;
  let high = characters.length - 1;
  let best = 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (measure(characters.slice(0, middle).join('') + ELLIPSIS) <= available) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return characters.slice(0, best).join('').trimEnd() + ELLIPSIS;
}

/**
 * Attached to a chip's name, which holds the stem and then the extension. A clipped box ends where
 * the last whole letter does, which leaves a gap before the extension ("up… .pdf"); this shortens
 * the stem's own text to what fits instead, so the ellipsis and the extension touch
 * ("quarterly-rec….pdf"). The full name stays in the chip's title and accessible name. Without a
 * canvas to measure with (a test document, a server render) the stylesheet's clip is left in place.
 */
export function fitFileName(stem: string): Attachment<HTMLElement> {
  return (name) => {
    const stemElement = name.querySelector<HTMLElement>('.chat-attachment-preview-stem');
    const extensionElement = name.querySelector<HTMLElement>('.chat-attachment-preview-extension');
    const text = stemElement?.firstChild;
    if (stemElement === null || stemElement === undefined || !(text instanceof Text)) {
      return undefined;
    }
    const context =
      typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
    if (context === null) return undefined;

    const update = (): void => {
      // The whole stem goes back first, so the room is measured as the stylesheet lays it out and
      // the result does not depend on what was shown before.
      text.data = stem;
      stemElement.removeAttribute(FITTED_ATTRIBUTE);
      if (stemElement.scrollWidth <= stemElement.clientWidth) return;
      const style = getComputedStyle(stemElement);
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const extensionWidth = extensionElement?.getBoundingClientRect().width ?? 0;
      const available = name.getBoundingClientRect().width - extensionWidth;
      text.data = fitStem(stem, (candidate) => context.measureText(candidate).width, available);
      stemElement.setAttribute(FITTED_ATTRIBUTE, '');
    };

    update();
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) update();
      return undefined;
    });
    if (typeof ResizeObserver === 'undefined') {
      return () => {
        cancelled = true;
      };
    }
    // The chip's own width is capped by the strip, so the strip's list is what changes size.
    const observed = name.closest<HTMLElement>('.chat-input-attachments') ?? name;
    const observer = new ResizeObserver(update);
    observer.observe(observed);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  };
}
