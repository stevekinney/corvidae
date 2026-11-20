/**
 * What no page says in its own words (owner, 2026-11-19): a filesystem path or home directory in a
 * header, a description or a body sentence, a secret reference (`workspace:<ULID>/...`), or a ULID.
 * A path is shown only inside an explicit copy control (Cinder's `CopyableValue` or `CopyButton`)
 * or a details control a person opens; a secret reference and a ULID are never shown at all.
 *
 * The rules are plain data and pure functions, so the happy-dom page tests and the browser walk of
 * every route (`tests/e2e/visible-text.spec.ts`) read the same list.
 */

/** The places a host path starts with, on macOS, Linux and Windows. */
export const HOST_PATH_PREFIXES = [
  '/var/',
  '/Users/',
  '/home/',
  '~/',
  'C:\\',
  '/tmp/',
  '/private/',
] as const;

/** A Crockford base-32 ULID: 26 characters, no I, L, O or U, the first at most 7. */
const ULID = '[0-7][0-9A-HJKMNP-TV-Z]{25}';

/** The patterns, as sources, so a browser page can build them without importing this module. */
export const FORBIDDEN_TEXT_PATTERNS: Readonly<Record<string, string>> = {
  'secret reference': `workspace:${ULID}`,
  ULID: `(?<![0-9A-Za-z])${ULID}(?![0-9A-Za-z])`,
};

/** One thing a page said that no page may say, and the text it was found in. */
export interface ForbiddenText {
  readonly rule: string;
  readonly found: string;
}

/** Everything in `text` no page may say in its own words. */
export function forbiddenVisibleText(text: string): ForbiddenText[] {
  const findings: ForbiddenText[] = [];
  for (const prefix of HOST_PATH_PREFIXES) {
    const at = text.indexOf(prefix);
    if (at >= 0) findings.push({ rule: 'host path', found: text.slice(at, at + 60) });
  }
  for (const [rule, source] of Object.entries(FORBIDDEN_TEXT_PATTERNS)) {
    const match = new RegExp(source).exec(text);
    if (match !== null) findings.push({ rule, found: match[0] });
  }
  return findings;
}

/** The controls a path may sit inside: an explicit copy control. */
export const PATH_ALLOWED_SELECTOR = '.cinder-copyable-value, .cinder-copy-button';

/**
 * The text a person reads in `root`, leaving out what sits inside a copy control (a path may be
 * there), and what is hidden. It is self-contained, so a browser page can run it as it is.
 */
export function visibleTextOutsideCopyControls(root: Element, allowedSelector: string): string {
  const parts: string[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent === null || parent.closest(allowedSelector) !== null) continue;
    if (parent.closest('script, style, template, [hidden], [aria-hidden="true"]') !== null)
      continue;
    // A browser also leaves out what its styles hide, such as a closed tooltip or popover.
    if (typeof parent.checkVisibility === 'function' && !parent.checkVisibility()) continue;
    parts.push(node.textContent ?? '');
  }
  return parts.join(' ');
}
