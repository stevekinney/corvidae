/**
 * Anchors for the headings of a component README rendered into a documentation page.
 *
 * READMEs are authored for GitHub, so their links name sections the way GitHub does:
 * `../table/README.md#usage` from a compose-only leaf, `#layout-and-sizing` inside Chat's README.
 * The renderer emits headings without ids, so those fragments named nothing on the page, and the
 * playground used to drop them. This module gives every README heading an id built from GitHub's
 * slug of its text and points the fragments that name those headings at the ids.
 *
 * The ids live in their own namespace. The component page owns `#overview`, `#guidance`,
 * `#examples`, `#props`, `#accessibility`, and `#related` (the sections its scroll spy follows),
 * and about fifty READMEs carry a heading with one of those names, so an unprefixed id would be a
 * duplicate id in the same document. The prefix is part of every README fragment this module and
 * the link rewriter in `component-documentation.ts` produce, so both ends agree.
 */

export const README_ANCHOR_PREFIX = 'readme-';

/** The id of the README heading a README fragment names. */
export function readmeAnchorId(fragment: string): string {
  return `${README_ANCHOR_PREFIX}${fragment}`;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function codePointText(codePoint: number): string {
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : '';
}

/** Decode the references the renderer escapes text with; any other named reference stays as is. */
function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi,
    (match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (decimal !== undefined) return codePointText(Number(decimal));
      if (hex !== undefined) return codePointText(Number.parseInt(hex, 16));
      return NAMED_ENTITIES[(name ?? '').toLowerCase()] ?? match;
    },
  );
}

/**
 * GitHub's slug of a heading's text: lowercase, every character that is not a letter, a mark, a
 * number, an underscore, a hyphen, or a space removed, and each space turned into a hyphen. A
 * removed character between two spaces leaves two hyphens (`Props & events` is `props--events`).
 */
export function slugifyHeadingText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replaceAll(' ', '-');
}

const headingPattern = /<h([1-6])((?:\s[^>]*)?)>([\s\S]*?)<\/h\1>/g;
const idAttributePattern = /\sid="([^"]*)"/i;

/**
 * Give each heading of rendered README HTML that has no id one in the README namespace, from the
 * slug of its text. A heading whose slug an earlier heading took is numbered the way GitHub
 * numbers it (`usage`, `usage-1`, `usage-2`), skipping any id already in the document. A heading
 * with no slug (its text is only symbols) and a heading that already has an id are left alone.
 */
export function addReadmeHeadingAnchors(html: string): string {
  const takenIds = new Set(Array.from(html.matchAll(/\sid="([^"]*)"/gi), (match) => match[1]));

  return html.replace(
    headingPattern,
    (heading, level: string, attributes: string, inner: string) => {
      if (idAttributePattern.test(attributes)) return heading;

      const slug = slugifyHeadingText(decodeEntities(inner.replace(/<[^>]*>/g, '')));
      if (slug === '') return heading;

      let id = readmeAnchorId(slug);
      for (let repeat = 1; takenIds.has(id); repeat += 1) id = readmeAnchorId(`${slug}-${repeat}`);
      takenIds.add(id);

      return `<h${level}${attributes} id="${id}">${inner}</h${level}>`;
    },
  );
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/**
 * Point each link that names a heading of the README (`href="#editing"`) at that heading's README
 * id. Run it on HTML that {@link addReadmeHeadingAnchors} has processed. A fragment that names no
 * such heading (a footnote, an id the page or the renderer owns) is left as it is.
 */
export function rewriteReadmeFragmentLinks(html: string): string {
  const headingIds = new Set(
    Array.from(html.matchAll(/<h[1-6]\b[^>]*\sid="([^"]+)"/gi), (match) => match[1]),
  );

  return html.replace(
    /<a\b([^>]*?)\shref="#([^"]+)"([^>]*)>/gi,
    (link, before: string, fragment: string, after: string) => {
      const id = readmeAnchorId(decodeFragment(fragment));
      return headingIds.has(id) ? `<a${before} href="#${id}"${after}>` : link;
    },
  );
}
