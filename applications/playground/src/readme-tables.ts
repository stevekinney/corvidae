/**
 * README tables scroll inside their own focusable region.
 *
 * Rendered Markdown tables are as wide as their widest cell. On a phone the landing README's
 * workspace table is wider than the viewport, and with nothing to contain it the whole page
 * scrolled sideways. Each table is wrapped in a region that owns its horizontal overflow and takes
 * keyboard focus, so a keyboard user can scroll it too (axe `scrollable-region-focusable`).
 *
 * Each region is a landmark, so each needs a name a screen-reader user can tell apart from the
 * others: the table's caption, or else the nearest preceding heading ("Props table"), or else its
 * position ("Table 2"). A name that would repeat gets an ordinal suffix.
 */
export const README_TABLE_SCROLL_CLASS = 'readme-table-scroll';

const ELEMENT_PATTERN = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>|<table\b[\s\S]*?<\/table>/g;

function textContent(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

/** The name each table's region gets, in document order. */
export function readmeTableNames(html: string): string[] {
  const names: string[] = [];
  const seen = new Map<string, number>();
  let heading: string | undefined;
  for (const match of html.matchAll(ELEMENT_PATTERN)) {
    if (match[1] !== undefined) {
      heading = textContent(match[1]) || undefined;
      continue;
    }
    const caption = /<caption\b[^>]*>([\s\S]*?)<\/caption>/i.exec(match[0])?.[1];
    const base =
      (caption === undefined ? '' : textContent(caption)) ||
      (heading === undefined ? '' : `${heading} table`) ||
      `Table ${names.length + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    names.push(count === 1 ? base : `${base} (${count})`);
  }
  return names;
}

/** Wrap every `<table>` in rendered README HTML in a focusable, distinctly named scroll region. */
export function wrapReadmeTables(html: string): string {
  const names = readmeTableNames(html);
  let index = 0;
  return html.replace(/<table\b[\s\S]*?<\/table>/g, (table) => {
    const name = names[index++] ?? `Table ${index}`;
    return `<div class="${README_TABLE_SCROLL_CLASS}" role="region" aria-label="${escapeAttribute(name)}" tabindex="0">${table}</div>`;
  });
}
