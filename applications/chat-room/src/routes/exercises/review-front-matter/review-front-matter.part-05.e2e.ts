import { expect, test } from '@playwright/test';
import type { Page } from './review-front-matter-test-helpers';
import {
  INVENTED_UNDERLINE_IN_SUMMARY,
  applyPatchInTempRepo,
  openFixture,
} from './review-front-matter-test-helpers';

function renderedString(value: string | null): string {
  expect(value).not.toBeNull();
  const parsed: unknown = JSON.parse(value ?? 'null');
  if (typeof parsed !== 'string') throw new Error('Expected rendered value to be a string.');
  return parsed;
}

test.describe('review front matter: every export surface ships the same patch', () => {
  // The one-key change's summary, byte for byte. Worth pinning next to the diff
  // because the two functions used NOT to agree about normalization:
  // `generateUnifiedDiff` parses the front matter off and normalizes the body,
  // while `generateMarkdownSummary` used to run `computeLineDiff` on the raw
  // strings with no normalization step at all. The literal is here so that if
  // they stop agreeing again, it stops loudly.
  //
  // ROADMAP X-2's remaining acceptance criterion — construct an input where
  // the two actually disagree — used to be met below, in the "blank-line
  // normalization" describe: a fixture whose only difference is how many
  // blank lines separate front matter from body, where `generateUnifiedDiff`
  // reported zero changes and `generateMarkdownSummary` reported a real edit.
  // Fixed in `@repo/editor@0.11.0`, which gave `generateMarkdownSummary`
  // its own `normalizeInputs` option (defaulting to `true`) routed through the
  // same shared `normalizeDocument` as `generateUnifiedDiff` — both functions
  // now agree on that fixture too. Fixed and verified in
  // https://github.com/stevekinney/cinder/issues/1318.
  const EXPECTED_SUMMARY = [
    '## Changes Made',
    '',
    'The following edits were made to the document:',
    '',
    '### Lines 1-5',
    '',
    '```diff',
    ' ---',
    '+draft: false',
    ' title: Release Plan',
    '-draft: true',
    ' ---',
    ' ',
    '```',
    '',
  ].join('\n');

  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await openFixture(browser, ['clipboard-read', 'clipboard-write']);
  });

  test.afterAll(async () => {
    await page.context().close();
  });

  test('the hidden input, exportUnifiedDiff(), and the Git Diff menu item are one string that git applies', async () => {
    // RE-2 names the UI path as the "Copy Diff menu item". There is no such
    // label: the item is "Git Diff" and it sits behind a trigger whose
    // accessible name is "Copy to clipboard". Correcting the criterion's
    // wording rather than inventing a selector that does not exist.
    const wrapper = page.getByTestId('fm-diff-wrapper');

    // Surface one: what a surrounding <form> would POST.
    const hidden = await page.locator('input[name="fm-diff-diff"]').inputValue();
    expect(hidden).not.toBe('');

    // Surface two: the imperative method, driven through `bind:this`. Read
    // from a `data-value` attribute holding `JSON.stringify(...)` for the same
    // reason as everything else on this route — the diff's context lines
    // include a line that is a single space, and Playwright's text matchers
    // collapse whitespace runs.
    await page.getByTestId('fm-read-imperative-exports').click();
    // Polled off its empty initial value rather than read straight after the
    // click: the button assigns to `$state` and the attribute lands on the
    // next flush. `'""'` is `JSON.stringify('')`, i.e. the "never ran" state
    // the page deliberately leaves distinguishable from an empty export.
    await expect
      .poll(() => page.getByTestId('fm-imperative-diff').getAttribute('data-value'))
      .not.toBe('""');
    const imperativeRendered = await page
      .getByTestId('fm-imperative-diff')
      .getAttribute('data-value');
    const imperative = renderedString(imperativeRendered);

    // Surface three: the export menu. Gated on the copy ANNOUNCEMENT rather
    // than read straight after the click — the component awaits
    // `copyToClipboard(text)` before writing the announcement, so the
    // announcement strictly follows the clipboard write.
    await wrapper.getByRole('button', { name: 'Copy to clipboard' }).click();
    const menu = page.locator('#fm-diff-export-menu');
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: /^Git Diff/ }).click();
    await expect(wrapper.locator('.export-actions .cinder-sr-only[aria-live="polite"]')).toHaveText(
      'Copied Git Diff',
    );
    const copied = await page.evaluate(() => navigator.clipboard.readText());

    expect(imperative).toBe(hidden);
    expect(copied).toBe(hidden);

    // And the patch all three carry is one git will take, producing exactly
    // the document the component says it is holding.
    const original = await page.locator('input[name="fm-diff-original"]').inputValue();
    const current = await page.locator('input[name="fm-diff-current"]').inputValue();
    expect(current.endsWith('\n')).toBe(false);
    expect(applyPatchInTempRepo(original, copied)).toBe(`${current}\n`);
  });

  test('exportMarkdownSummary ships the same front-matter change, and prints no thread section for a fixture with no threads', async () => {
    await page.getByTestId('fm-read-imperative-exports').click();
    await expect
      .poll(() => page.getByTestId('fm-imperative-summary').getAttribute('data-value'))
      .not.toBe('""');
    const rendered = await page.getByTestId('fm-imperative-summary').getAttribute('data-value');
    const summary = renderedString(rendered);

    // The imperative method and the hidden input are the same `$derived`.
    expect(summary).toBe(await page.locator('input[name="fm-diff-summary"]').inputValue());
    expect(summary).toBe(EXPECTED_SUMMARY);

    // The YAML reaches the summary intact — no setext underline, no invented
    // dash line — which is the same regression tripwire the diff tests carry.
    expect(summary).not.toMatch(INVENTED_UNDERLINE_IN_SUMMARY);
    // No threads on this fixture, so the Feedback section is absent entirely
    // rather than present and empty.
    expect(summary).not.toContain('## Feedback');
  });
});

// ROADMAP X-2's remaining criterion was an input where `generateUnifiedDiff`
// and `generateMarkdownSummary` actually disagreed, not just documenting that
// they COULD. This fixture's original and current front matter and body text
// are byte-identical — the only difference is how many blank lines separate
// the closing `---` from the body (one vs. three) — and it used to be exactly
// such a case.
//
// `generateUnifiedDiff`'s `normalizeDocument` (`normalizeInputs` defaults to
// `true`) re-attaches front matter to the body with a single hardcoded `\n`
// separator, and runs the body through the markdown pipeline's `normalize()`,
// which strips every leading blank line before re-serializing — so ANY count
// of blank lines there collapses to the same normalized document.
// `generateMarkdownSummary`'s `computeLineDiff` used to run on the raw strings
// with no normalization step at all, so it saw the extra blank lines as real
// content: one function reported zero changes, the other reported an edit.
//
// Fixed in `@repo/editor@0.11.0`: `generateMarkdownSummary` gained its
// own `normalizeInputs` option, defaulting to `true`, and now goes through the
// same shared `normalizeDocument` as `generateUnifiedDiff`. Both functions
// collapse this fixture's blank-line difference the same way and now agree
// that nothing changed.
//
// This was reachable through the public surface even though no UI keystroke
// sequence could type it: ProseMirror collapses adjacent blank paragraphs, but
// `ReviewState.original` is consumer-supplied verbatim (it is never routed
// through the editor), and `setState` round-trips persisted content the same
// way — so any external tool or hand-edited save file that changed blank-line
// spacing near front matter used to produce exactly this pair.
//
// Fixed and verified in https://github.com/stevekinney/cinder/issues/1318.
test.describe('review front matter: blank-line normalization agreement (fixed)', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await openFixture(browser);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('generateUnifiedDiff and generateMarkdownSummary both report no change, on a blank-line-only edit', async () => {
    // generateUnifiedDiff: front matter and body normalize to the identical
    // string regardless of how many blank lines separated them, so original
    // and current collapse to the same document and no hunk is produced.
    await expect(page.getByTestId('fm-blank-line-diff')).toHaveAttribute('data-value', '""');

    // generateMarkdownSummary: now normalizes the same way by default, so it
    // also sees the identical normalized document and reports no change —
    // agreeing with generateUnifiedDiff instead of diverging from it.
    await expect(page.getByTestId('fm-blank-line-summary')).toHaveAttribute(
      'data-value',
      JSON.stringify('No changes or feedback to report.'),
    );
  });
});
