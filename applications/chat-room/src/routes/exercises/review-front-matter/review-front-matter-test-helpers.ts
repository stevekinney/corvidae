import type { Browser, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { applyPatchInTempRepo } from '../git-apply';
import { gotoHydrated } from '../hydration';

export { applyPatchInTempRepo, gotoHydrated };
export type { Browser, Page };

export // Pins how `ReviewEditor` detects YAML front matter, what controls it generates
// from it, and what a single-field edit costs the rest of the document.
//
// Front matter is not a cosmetic extra here: `parseFrontMatter` splits the
// document, the inner editor is handed only the BODY, and every position the
// component publishes is therefore shifted by `bodyOffset` (the character
// length of the block plus delimiters). Recognition, the field controls, the
// rewrite-on-edit, the anchor remap, and the unified diff's handling of the
// block are the same mechanism at four distances, which is why they share a
// route.
//
// Values are read from `data-value` attributes carrying `JSON.stringify(value)`
// rather than from element text. Playwright's text matchers collapse whitespace
// runs (hiding `  owner: maya`'s indentation) and the HTML parser rewrites
// `\r\n` to `\n` inside element text (silently "fixing" the CRLF fixture);
// `toHaveAttribute` on a JSON-escaped string compares byte-for-byte.

// Eleven ReviewEditor fixtures live on the route. Waiting for every one to
// report `data-ready` matters: the front-matter controls render during SSR,
// before the inner Milkdown editor exists, so an interaction issued earlier
// could race the editor's own mount-time change handling.
const EDITOR_COUNT = 11;

export const FULL_DOCUMENT = [
  '---',
  'title: Release Plan',
  'draft: true',
  'priority: 3',
  'tags:',
  '  - alpha',
  '  - beta',
  'meta:',
  '  owner: maya',
  '---',
  '',
  '# Release Plan',
  '',
  'Alpha line.',
].join('\n');

export // What a SINGLE edit to `title` turns the block above into. Nothing else was
// touched, yet: keys are alphabetized, the block sequence under `tags` has
// collapsed to flow style, and the two-space indent under `meta` is the
// serializer's, not the author's. The body is untouched and reattached.
const REWRITTEN_FULL_DOCUMENT = [
  '---',
  'draft: true',
  'meta:',
  '  owner: maya',
  'priority: 3',
  'tags: [alpha, beta]',
  'title: Release Plan v2',
  '---',
  '',
  '# Release Plan',
  '',
  'Alpha line.',
].join('\n');

export async function newPageWithPermissions(
  browser: Browser,
  permissions: string[],
): Promise<Page> {
  const context = await browser.newContext({ permissions });
  return context.newPage();
}

/**
 * `permissions` builds an explicit context instead of using `test.use`, which
 * configures the `page` FIXTURE — a describe-shared page from
 * `browser.newPage()` would not inherit it, and the clipboard read in the export
 * describe would fail on permission. Granting it per-describe rather than
 * file-wide also keeps the other nine describes free of a clipboard grant that
 * Firefox and WebKit do not both map.
 */
export async function openFixture(browser: Browser, permissions?: string[]): Promise<Page> {
  const page = permissions
    ? await newPageWithPermissions(browser, permissions)
    : await browser.newPage();
  await gotoHydrated(page, '/exercises/review-front-matter');
  await expect(page.locator('[data-testid="review-editor"][data-ready="true"]')).toHaveCount(
    EDITOR_COUNT,
  );
  return page;
}

export const frontMatterSection = (page: Page, editorId: string) =>
  page.locator(`section[aria-labelledby="${editorId}-front-matter-heading"]`);

// A line of eight or more dashes carrying a diff marker exists in neither input document,
// so anything matching it was invented by a normalization pass.
export const INVENTED_UNDERLINE_IN_SUMMARY = /^[-+]-{8,}$/m;
