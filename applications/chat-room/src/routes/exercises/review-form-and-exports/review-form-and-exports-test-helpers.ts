import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { applyPatchInTempRepo } from '../git-apply';
import { gotoHydrated } from '../hydration';

export { applyPatchInTempRepo, gotoHydrated };
export type { Locator, Page };

export // ReviewEditor's form participation and its export menu are two renderings of
// the same five derivations, so this file pins them together, plus the pure
// functions (`@repo/editor/review-editor` and `.../export`) that are
// supposed to reproduce them outside the component.
//
// Everything asserted here was checked against the running component; where a
// behavior is WRONG but real it is pinned as such, with a comment saying so,
// rather than softened into something that passes.
const ROUTE = '/exercises/review-form-and-exports';

export function defined<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} was not produced.`);
  return value;
}
export // The five hidden inputs, in DOM order. `name` is a PREFIX: the component
// joins it to each field with a hyphen.
const REVIEW_FIELDS = [
  'review-original',
  'review-current',
  'review-comments',
  'review-diff',
  'review-summary',
];
export // The unified diff for the seeded fixture, byte for byte. One modified line and
// one added line, three lines of context, merged into a single hunk. Written
// out rather than derived so a change in the diff algorithm shows up as a
// failure here instead of being absorbed by a self-referential comparison.
const EXPECTED_DIFF = [
  '--- a/document.md',
  '+++ b/document.md',
  '@@ -1,8 +1,9 @@',
  ' # Release Plan',
  ' ',
  '-The first release includes a dashboard and export actions.',
  '+The first release includes a dashboard, export actions, and inline review.',
  ' ',
  ' ## Checklist',
  ' ',
  ' - Finalize the component API',
  ' - Add playground coverage',
  '+- Document review export behavior',
  '',
].join('\n');
export // `generateMarkdownSummary` output for the same fixture, byte for byte. RE-2
// asks for an anchored thread's export to be pinned exactly, so a change to the
// orphan branch — or to any of the three heading shapes — cannot quietly alter
// what an anchored thread produces.
//
// The fixture is never typed into on the shared page (the one test that types
// has its own). `generateMarkdownSummary` now normalizes by default too
// (`@repo/editor@0.11.0`, cinder#1307/#1318), through the same
// `normalizeDocument` `generateUnifiedDiff` uses — which is what keeps the
// `- ` bullets below stable even though Milkdown's own serializer prefers `*`:
// normalization canonicalizes back to `-` for this fixture (see "typing
// changes `review-current` and `review-diff`" below), so both exports agree.
const EXPECTED_SUMMARY = [
  '## Changes Made',
  '',
  'The following edits were made to the document:',
  '',
  '### Lines 1-5',
  '',
  '```diff',
  ' # Release Plan',
  ' ',
  '-The first release includes a dashboard and export actions.',
  '+The first release includes a dashboard, export actions, and inline review.',
  ' ',
  ' ## Checklist',
  '```',
  '',
  '### Lines 7-8',
  '',
  '```diff',
  ' - Finalize the component API',
  ' - Add playground coverage',
  '+- Document review export behavior',
  '```',
  '',
  '## Feedback',
  '',
  'The following comments were made and may require action:',
  '',
  '### On "Release Plan"',
  '',
  '> Title reads well — keep it.',
  '',
].join('\n');
export // The fourth editor's summary at rest, byte for byte. Its `original` equals its
// initial `value`, so there is no `## Changes Made` section at all and the whole
// document is the Feedback section RE-2 is about.
//
// Read it as the strongest available statement of "never prints a coordinate it
// does not have": there is not a single DIGIT in it. Three threads — one
// anchored to a quote, one anchored to the heading, one document-level — and the
// export prints quotes and comment bodies and nothing else. No `from`, no `to`,
// no `lastKnownOffset`, no line number.
const EXPECTED_ORPHAN_SUMMARY_AT_REST = [
  '## Feedback',
  '',
  'The following comments were made and may require action:',
  '',
  '### On "beta rollout"',
  '',
  '> Which teams, exactly?',
  '',
  '### On "Beta Notes"',
  '',
  '> Heading reads fine.',
  '',
  '### Document-level feedback',
  '',
  '> Overall: ready to ship.',
  '',
].join('\n');
export // `generateCommentsExport` output for the same fixture. Note `**Total
// comments:** 1` against a thread that holds TWO comments — the second carries
// `deletedAt`, and every comments export filters soft-deleted comments out.
const EXPECTED_COMMENTS_MARKDOWN = [
  '# Review Comments\n',
  'Comments on specific text selections:\n',
  '### Comment at offset 0\n',
  '> Release Plan',
  '',
  '**maya** (2026-08-11):',
  'Title reads well — keep it.',
  '',
  '---\n',
  '---\n',
  '**Total threads:** 1',
  '**Total comments:** 1',
].join('\n');
export // Everything the published wrapper must forward through `bind:this`. An earlier
// build forwarded NONE of it — `bind:this` handed back an object with no
// methods — so this list is the regression guard, not decoration.
const IMPERATIVE_METHODS = [
  'clearAllThreads',
  'createBlockThread',
  'createComment',
  'createDocumentThread',
  'createThread',
  'deleteComment',
  'deleteThread',
  'exportMarkdownSummary',
  'exportUnifiedDiff',
  'focus',
  'getAst',
  'getEditor',
  'getFormData',
  'getMarkdown',
  'getSelection',
  'getState',
  'getView',
  'reset',
  'scrollToThread',
  'setMarkdown',
  'setState',
  'updateComment',
];
export const namedEditor = (page: Page) => page.getByTestId('named-editor');
export const bareEditor = (page: Page) => page.getByTestId('bare-editor');
export // The fourth instance, which carries the orphan / anchored / document-level
// thread trio. Its five hidden inputs sit outside any form on purpose — `name`
// is what emits them, not a surrounding <form> — so they are read directly.
const orphanField = (page: Page, field: string) => page.locator(`input[name="orphan-${field}"]`);
export const exportTrigger = (page: Page) =>
  namedEditor(page).getByRole('button', { name: 'Copy to clipboard' });
export const exportMenu = (page: Page) => page.locator('#exports-editor-export-menu');
export // The copy announcer is `cinder-sr-only` — clipped, not hidden — so it has text
// but is never visible. Assert on it through the DOM, never through a
// visible-text locator.
const copyAnnouncer = (page: Page) =>
  namedEditor(page).locator('.export-actions .cinder-sr-only[aria-live="polite"]');
/**
 * Navigate and wait until all four ReviewEditor instances have a live
 * ProseMirror view. `data-ready` is set once the view exists and no pending
 * state is queued; without it, an early click can land on markup whose editor
 * has not mounted.
 */
export async function gotoReady(page: Page) {
  await gotoHydrated(page, ROUTE);
  // Four Milkdown instances mount here (~360ms locally). The generous
  // timeout is headroom for parallel-worker CPU contention, not an
  // expectation that it is ever slow.
  await expect(page.locator('[data-testid="review-editor"][data-ready="true"]')).toHaveCount(4, {
    timeout: 15000,
  });
}
/**
 * Open the export menu, click one item, and return what landed on the
 * clipboard.
 *
 * The clipboard read is gated on the copy announcement rather than issued
 * straight after the click: `createCopyState.trigger()` awaits
 * `copyToClipboard(text)` and only then writes `copiedKey`, so the announcement
 * strictly follows the write. Waiting for it with an auto-retrying matcher is
 * what makes the `evaluate` below deterministic.
 */
export async function copyFromExportMenu(
  page: Page,
  itemName: string | RegExp,
  announcement: string,
): Promise<string> {
  await exportTrigger(page).click();
  await expect(exportMenu(page)).toBeVisible();
  await exportMenu(page).getByRole('menuitem', { name: itemName }).click();
  await expect(copyAnnouncer(page)).toHaveText(announcement);
  return page.evaluate(() => navigator.clipboard.readText());
}
export async function submitAndRead(page: Page, submitTestId: string, countTestId: string) {
  const countText = await page.getByTestId(countTestId).textContent();
  const count = Number(countText?.replace(/\D/g, '') ?? 0);
  await page.getByTestId(submitTestId).click();
  await expect(page.getByTestId(countTestId)).toHaveText(`submits: ${count + 1}`);
}
export const valueOf = (locator: Locator) => locator.inputValue();
