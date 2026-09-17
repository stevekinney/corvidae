import { expect, test } from '@playwright/test';
import type { Page } from './review-form-and-exports-test-helpers';
import { gotoReady, submitAndRead, valueOf } from './review-form-and-exports-test-helpers';

function threadAnchors(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error('Expected threads to be an array.');
  return value.map((thread) => {
    if (typeof thread !== 'object' || thread === null || Array.isArray(thread)) {
      throw new Error('Expected thread to be an object.');
    }
    const anchor = Reflect.get(thread, 'anchor');
    if (typeof anchor !== 'object' || anchor === null || Array.isArray(anchor)) {
      throw new Error('Expected thread anchor to be an object.');
    }
    return anchor;
  });
}

test.describe('the pure export functions', () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await gotoReady(page);
  });
  test.afterAll(async () => {
    await page.close();
  });
  test('buildFormDataFromValues reproduces all five hidden inputs, including live anchor positions', async () => {
    await submitAndRead(page, 'submit-named', 'named-submit-count');
    for (const [moduleTestId, submittedTestId] of [
      ['module-original', 'submitted-original'],
      ['module-current', 'submitted-current'],
      ['module-diff', 'submitted-diff'],
      ['module-summary', 'submitted-summary'],
    ] as const) {
      expect(await valueOf(page.getByTestId(moduleTestId))).toBe(
        await valueOf(page.getByTestId(submittedTestId)),
      );
    }
    // Both helpers reproduce the live form payload. Persisted getState()
    // exports have a separate contract that omits transient editor positions.
    const submitted = await valueOf(page.getByTestId('submitted-comments'));
    expect(await valueOf(page.getByTestId('module-comments-from-state'))).toBe(submitted);
    const fromValues = await valueOf(page.getByTestId('module-comments-from-values'));
    expect(fromValues).toBe(submitted);
    const [fromValuesAnchor] = threadAnchors(JSON.parse(fromValues));
    expect(fromValuesAnchor).toHaveProperty('from', 1);
    expect(fromValuesAnchor).toHaveProperty('to', 13);
    expect(JSON.parse(fromValues)).toEqual(JSON.parse(submitted));
  });
  test('the review-editor export helpers match the underlying export functions', async () => {
    // `exportMarkdownSummary(state)` is
    // documented as a "stateless wrapper" around `generateMarkdownSummary`,
    // and this is where that stops being a docstring: same state in, byte
    // identical markdown out.
    expect(await valueOf(page.getByTestId('module-summary'))).toBe(
      await valueOf(page.getByTestId('core-summary')),
    );
  });
  test('getSummaryContentWithoutHeading is an identity function', async () => {
    const summary = await valueOf(page.getByTestId('module-summary'));
    // PINNED KNOWN BUG (dead code). The helper strips a leading
    // `# Review Summary` heading so UI previews can skip it — but
    // `generateMarkdownSummary` never emits that heading. Its sections start
    // at `## Changes Made`, so the regex matches nothing and the function
    // returns its input for every state that can be constructed.
    expect(summary).not.toContain('# Review Summary');
    expect(await valueOf(page.getByTestId('module-summary-without-heading'))).toBe(summary);
  });
  test('generateUnifiedDiff normalizes both sides, so a formatting-only edit produces no diff at all', async () => {
    // `- item one` vs `* item one`: the same list, two bullet characters.
    await expect(page.getByTestId('normalized-diff')).toHaveValue('');
    await expect(page.getByTestId('normalized-stats')).toHaveText(
      'additions:0 deletions:0 hunks:0',
    );
    // `normalizeInputs: false` compares the raw strings and finds the change.
    const raw = await valueOf(page.getByTestId('raw-diff'));
    expect(raw).toBe(
      [
        '--- a/document.md',
        '+++ b/document.md',
        '@@ -1,1 +1,1 @@',
        '-- item one',
        '+* item one',
        '',
      ].join('\n'),
    );
    await expect(page.getByTestId('raw-stats')).toHaveText('additions:1 deletions:1 hunks:1');
    // PINNED DEVIATION: the hunk header spells out a count of 1
    // (`@@ -1,1 +1,1 @@`). Git omits `,1` and writes `@@ -1 +1 @@`. Both are
    // accepted by `git apply`, so this is cosmetic — but it means the output
    // is not byte-identical to what git would produce for the same change.
    expect(raw).toContain('@@ -1,1 +1,1 @@');
  });
  test('the summary now normalizes too, so the same state yields an empty diff and an empty-changes summary', async () => {
    // Same `ReviewState`, two exports, now the same answer. `generateUnifiedDiff`
    // runs both sides through the markdown pipeline before comparing;
    // `generateMarkdownSummary` used to call `computeLineDiff` on the raw
    // strings with no normalization step and no option to add one, so the diff
    // said "nothing changed" while the summary reported a modified line — for a
    // document whose only difference was which bullet character it used.
    //
    // Fixed in `@repo/editor@0.11.0`: `generateMarkdownSummary` gained
    // its own `normalizeInputs` option, defaulting to `true`, routed through the
    // same shared `normalizeDocument` as `generateUnifiedDiff` (cinder#1307,
    // cinder#1318). Both exports now agree that a `-`-vs-`*` bullet is not a
    // change.
    await expect(page.getByTestId('normalized-diff')).toHaveValue('');
    const summary = await valueOf(page.getByTestId('formatting-only-summary'));
    expect(summary).toBe('No changes or feedback to report.');
    expect(summary).not.toContain('## Changes Made');
    await expect(page.getByTestId('formatting-only-summary-stats')).toHaveText(
      'changeCount:0 threadCount:0',
    );
    // And no Feedback section, because the state carries no threads — the two
    // sections are independent.
    expect(summary).not.toContain('## Feedback');
  });
  test('the comments export falls through three location formats and two headings', async () => {
    // `originalPosition` wins when present, and adds a `*Position: …*` line.
    const withPosition = await valueOf(page.getByTestId('location-position'));
    expect(withPosition).toContain('### Comment at Line 3:1');
    expect(withPosition).toContain('*Position: Line 3, Column 1 (offset 4)*');
    // Without it, the textBetween offset is the next-best address...
    expect(await valueOf(page.getByTestId('location-offset'))).toContain('### Comment at offset 4');
    // ...and with neither, the comment is printed with no location at all
    // rather than being dropped.
    expect(await valueOf(page.getByTestId('location-unknown'))).toContain(
      '### Comment (location unknown)',
    );
    // `formatTimestamp` calls `toISOString()` on an Invalid Date, which
    // throws, and swallows it — so an unparseable `createdAt` costs the
    // parenthetical, not the comment.
    const unparseable = await valueOf(page.getByTestId('unparseable-timestamp'));
    expect(unparseable).toContain('**maya**:');
    expect(unparseable).not.toContain('(');
    // The empty path uses a DIFFERENT top-level heading from the populated
    // one (`# Comments` vs `# Review Comments`) — a real inconsistency, not
    // a typo in this test.
    expect(await valueOf(page.getByTestId('empty-comments-export'))).toBe(
      '# Comments\n\nNo comments to export.',
    );
    // A thread whose every comment is soft-deleted is filtered before the
    // heading is chosen, so it takes the empty path even though
    // `state.threads` is non-empty.
    expect(await valueOf(page.getByTestId('all-soft-deleted-export'))).toBe(
      '# Comments\n\nNo comments to export.',
    );
  });
});
