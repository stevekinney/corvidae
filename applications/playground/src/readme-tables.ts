/**
 * README tables scroll inside their own focusable region.
 *
 * Rendered Markdown tables are as wide as their widest cell. On a phone the landing README's
 * workspace table is wider than the viewport, and with nothing to contain it the whole page
 * scrolled sideways. Each table is wrapped in a region that owns its horizontal overflow and takes
 * keyboard focus, so a keyboard user can scroll it too (axe `scrollable-region-focusable`).
 */
export const README_TABLE_SCROLL_CLASS = 'readme-table-scroll';

/** Wrap every `<table>` in rendered README HTML in a focusable, labelled scroll region. */
export function wrapReadmeTables(html: string): string {
  return html.replace(
    /<table\b[\s\S]*?<\/table>/g,
    (table) =>
      `<div class="${README_TABLE_SCROLL_CLASS}" role="region" aria-label="Scrollable table" tabindex="0">${table}</div>`,
  );
}
