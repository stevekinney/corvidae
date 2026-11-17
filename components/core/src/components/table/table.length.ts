const PIXEL_LENGTH = /^(\d+|\d*\.\d+)(px|rem|em)$/;
const DEFAULT_FONT_SIZE_PIXELS = 16;

function fontSizeOf(element: Element | null | undefined): number {
  if (!element) return DEFAULT_FONT_SIZE_PIXELS;
  const size = Number.parseFloat(
    element.ownerDocument.defaultView?.getComputedStyle(element).fontSize ?? '',
  );
  return Number.isFinite(size) && size > 0 ? size : DEFAULT_FONT_SIZE_PIXELS;
}

/**
 * Converts a simple CSS length to pixels, for comparing it with a measured width. A unitless zero,
 * `px`, `rem` (against the root's font size) and `em` (against `element`'s) convert; any other unit
 * (`vw`, `ch`, `cqw`) depends on something this cannot measure, so the result is `undefined`.
 */
export function lengthToPixels(length: string, element: Element): number | undefined {
  const text = length.trim();
  if (text === '0') return 0;
  const match = PIXEL_LENGTH.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === 'px') return value;
  if (unit === 'rem') return value * fontSizeOf(element.ownerDocument.documentElement);
  return value * fontSizeOf(element);
}
