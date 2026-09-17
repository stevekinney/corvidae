import { expect, test } from '@playwright/test';
import type { Page } from './review-form-and-exports-test-helpers';
import {
  EXPECTED_DIFF,
  EXPECTED_SUMMARY,
  IMPERATIVE_METHODS,
  REVIEW_FIELDS,
  ROUTE,
  bareEditor,
  defined,
  gotoReady,
  namedEditor,
  submitAndRead,
  valueOf,
} from './review-form-and-exports-test-helpers';

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected form data to be an object.');
  }
  const entries = Object.entries(value).map(([key, entry]) => {
    if (typeof entry !== 'string') throw new Error(`Expected ${key} to be a string.`);
    return [key, entry] as const;
  });
  return Object.fromEntries(entries);
}

function submittedComments(value: unknown): Array<{ anchor: Record<string, unknown> }> {
  if (!Array.isArray(value)) throw new Error('Expected submitted comments to be an array.');
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('Expected submitted comment to be an object.');
    }
    const anchor = Reflect.get(entry, 'anchor');
    if (typeof anchor !== 'object' || anchor === null || Array.isArray(anchor)) {
      throw new Error('Expected submitted comment anchor to be an object.');
    }
    return { anchor };
  });
}

test.describe('review form participation', () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await gotoReady(page);
  });
  test.afterAll(async () => {
    await page.close();
  });
  test('`name` emits exactly five prefixed hidden inputs, server-rendered, and nothing unprefixed', async ({
    request,
  }) => {
    // Fetched as raw HTML rather than read from the hydrated page: the claim
    // is that the inputs exist in the SSR payload, so a form posted before
    // hydration still carries the review. A DOM read cannot tell the two
    // apart.
    const response = await request.get(ROUTE);
    const html = await response.text();
    for (const field of REVIEW_FIELDS) {
      expect(html).toContain(`name="${field}"`);
    }
    expect(html.match(/name="review-/g)).toHaveLength(5);
    // The third editor sets `name="bare"` and the fourth `name="orphan"`, so
    // the page's full hidden-input census is 5 + 0 + 5 + 5.
    expect(html.match(/name="bare-/g)).toHaveLength(5);
    expect(html.match(/name="orphan-/g)).toHaveLength(5);
    expect(html.match(/type="hidden"/g)).toHaveLength(15);
    // PINNED KNOWN BUG. `getFieldName()` reads
    // `name ? \`${name}-${field}\` : field`, and the prop is documented as a
    // "form field name prefix" — which reads as though omitting it yields
    // bare `original` / `current` / … inputs. It does not: the whole block is
    // wrapped in `{#if name}`, so the fallback branch is dead code and an
    // editor without `name` contributes nothing to its form at all. The
    // second editor on this page proves the DOM half; this proves no bare
    // names leak into the SSR payload either.
    for (const bare of ['original', 'current', 'comments', 'diff', 'summary']) {
      expect(html).not.toContain(`name="${bare}"`);
    }
  });
  test('submitting the surrounding form yields exactly those five keys, carrying the live props', async () => {
    await submitAndRead(page, 'submit-named', 'named-submit-count');
    await expect(page.getByTestId('named-form-keys')).toHaveText(REVIEW_FIELDS.join(','));
    // `review-current` is the live `value` verbatim...
    expect(await valueOf(page.getByTestId('submitted-current'))).toBe(
      await valueOf(page.getByTestId('live-value')),
    );
    // ...and `review-comments` is `JSON.stringify(threads)` on the RUNTIME
    // array, ProseMirror positions included. That is a different shape from
    // what `getState()` persists (below), which drops `from`/`to`.
    const comments = await valueOf(page.getByTestId('submitted-comments'));
    expect(comments).toBe(await valueOf(page.getByTestId('live-threads-json')));
    const parsed = submittedComments(JSON.parse(comments));
    expect(defined(parsed[0], 'submitted comment').anchor).toMatchObject({
      from: 1,
      to: 13,
      lastKnownOffset: 0,
    });
    // The diff and summary are the module functions' output, unmodified.
    expect(await valueOf(page.getByTestId('submitted-diff'))).toBe(EXPECTED_DIFF);
    expect(await valueOf(page.getByTestId('submitted-summary'))).toBe(
      await valueOf(page.getByTestId('module-summary')),
    );
  });
  test('the submitted summary is structured for an LLM and drops soft-deleted comments', async () => {
    await submitAndRead(page, 'submit-named', 'named-submit-count');
    const summary = await valueOf(page.getByTestId('submitted-summary'));
    // RE-2: the anchored thread's export, pinned byte for byte rather than by
    // `toContain`, so a future change to the orphan branch cannot silently
    // alter what an anchored thread produces. The looser assertions below are
    // kept because they say what each byte MEANS — a diff on the literal alone
    // would not tell a reader which part regressed.
    expect(summary).toBe(EXPECTED_SUMMARY);
    expect(summary.startsWith('## Changes Made')).toBe(true);
    expect(summary).toContain('## Feedback');
    expect(summary).toContain('### On "Release Plan"');
    expect(summary).toContain('Title reads well — keep it.');
    // The heading shape for an ANCHORED thread carries no parenthetical. That
    // is the discriminator the orphan tests below turn on.
    expect(summary).not.toContain('(no longer in the document)');
    // The thread's second comment carries `deletedAt`. It is still in
    // `threads` (and still in the hidden `review-comments` JSON), but every
    // export filters it.
    expect(summary).not.toContain('Retracted: ignore this one.');
  });
  test('typing changes `review-current` and `review-diff` — and rewrites list markers nobody touched', async ({
    page: ownPage,
  }) => {
    // Its own page: this test mutates the document, which would invalidate
    // the byte-exact fixtures every other test in the file depends on.
    await gotoReady(ownPage);
    const before = await valueOf(ownPage.getByTestId('live-value'));
    // Clicking the editor's centre lands the caret at an arbitrary offset.
    // Target the first paragraph and press End instead, so the insertion
    // point is the same on every run.
    const paragraph = namedEditor(ownPage)
      .getByRole('textbox', { name: 'Markdown editor' })
      .locator('p')
      .first();
    await paragraph.click();
    await ownPage.keyboard.press('End');
    await ownPage.keyboard.type(' ZZTOP');
    await expect(ownPage.getByTestId('live-value')).not.toHaveValue(before);
    await submitAndRead(ownPage, 'submit-named', 'named-submit-count');
    const current = await valueOf(ownPage.getByTestId('submitted-current'));
    expect(current).toBe(await valueOf(ownPage.getByTestId('live-value')));
    expect(current).toContain('inline review. ZZTOP');
    expect(await valueOf(ownPage.getByTestId('submitted-diff'))).toContain(
      '+The first release includes a dashboard, export actions, and inline review. ZZTOP',
    );
    // PINNED QUIRK, and the reason `generateUnifiedDiff` normalizes by
    // default. One keystroke re-serializes the WHOLE document through
    // Milkdown, whose Markdown serializer prefers `*` bullets and terminates
    // the file with a newline. So `review-current` comes back changed in
    // three places the reviewer never touched...
    expect(before).toContain('- Finalize the component API');
    expect(current).toContain('* Finalize the component API');
    expect(current.endsWith('\n')).toBe(true);
    // ...while `review-diff` shows none of it, because the diff normalizes
    // both sides back to `-` before comparing. The two fields disagree about
    // what the document says, and the diff is the one telling the truth.
    expect(await valueOf(ownPage.getByTestId('submitted-diff'))).toContain(
      ' - Finalize the component API',
    );
  });
  test('omitting `name` emits no hidden inputs at all and contributes nothing to its form', async () => {
    await expect(page.locator('#exports-unnamed-form input[type="hidden"]')).toHaveCount(0);
    await submitAndRead(page, 'submit-unnamed', 'unnamed-submit-count');
    await expect(page.getByTestId('unnamed-form-keys')).toHaveText('');
  });
  test('without `original` the toolbar reports no changes while the form claims the whole document was added', async () => {
    // Half one: the control bar. `showDiffTabs={!!original}` hides the Diff
    // and Summary tabs, and `diffStats` short-circuits to all zeroes, so the
    // DiffStatistics group is not rendered at all.
    await expect(bareEditor(page).getByRole('tab')).toHaveText(['Editor']);
    await expect(bareEditor(page).getByRole('group', { name: /lines? changed/ })).toHaveCount(0);
    // The seeded editor, for contrast: three tabs and a live count.
    await expect(namedEditor(page).getByRole('tab')).toHaveText(['Editor', 'Diff', 'Summary']);
    await expect(namedEditor(page).getByRole('group', { name: '2 lines changed' })).toBeVisible();
    // Half two: the same instance's hidden inputs. `generateUnifiedDiff`
    // reads a missing original as an empty left-hand side, which is
    // indistinguishable from "this file is new".
    await submitAndRead(page, 'submit-bare', 'bare-submit-count');
    await expect(page.getByTestId('bare-form-keys')).toHaveText(
      'bare-original,bare-current,bare-comments,bare-diff,bare-summary',
    );
    expect(await valueOf(page.getByTestId('bare-submitted-original'))).toBe('');
    const diff = await valueOf(page.getByTestId('bare-submitted-diff'));
    // PINNED KNOWN BUG: two answers to "what changed?" from one component.
    // The toolbar says nothing; the form says every line is an addition.
    // `@@ -0,0 +…` is the git convention for an empty original side, so the
    // output is well-formed — it just contradicts the chrome next to it.
    expect(diff).toContain('@@ -0,0 +1,3 @@');
    const addedLines = diff
      .split('\n')
      .filter((line) => line.startsWith('+') && line !== '+++ b/document.md');
    const bareLineCountText = await page.getByTestId('bare-line-count').textContent();
    const lineCount = Number(bareLineCountText?.replace(/\D/g, ''));
    expect(addedLines).toHaveLength(lineCount);
    expect(
      diff.split('\n').some((line) => line.startsWith('-') && line !== '--- a/document.md'),
    ).toBe(false);
  });
});
test.describe('the imperative surface behind bind:this', () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await gotoReady(page);
  });
  test.afterAll(async () => {
    await page.close();
  });
  test('`bind:this` exposes the documented methods', async () => {
    const instanceKeysText = await page.getByTestId('instance-keys').textContent();
    const keys = instanceKeysText?.split(',') ?? [];
    // Not an exact-list assertion: a DEV build also hangs `$destroy`, `$on`
    // and `$set` on the instance (Svelte's legacy-API stubs, which only
    // throw a "the component API changed" error), and this suite runs
    // against a production preview where those are compiled out.
    for (const method of IMPERATIVE_METHODS) {
      expect(keys).toContain(method);
    }
  });
  test('getFormData() returns the same five values the hidden inputs carry', async () => {
    await page.getByTestId('read-form-data').click();
    await expect(page.getByTestId('imperative-form-data')).not.toHaveValue('');
    const data = stringRecord(JSON.parse(await valueOf(page.getByTestId('imperative-form-data'))));
    expect(Object.keys(data)).toEqual(['original', 'current', 'comments', 'diff', 'summary']);
    // The hidden inputs and getFormData() read the same `$derived`s, and
    // this is where that stops being a claim in the README.
    for (const [field, key] of [
      ['review-original', 'original'],
      ['review-current', 'current'],
      ['review-comments', 'comments'],
      ['review-diff', 'diff'],
      ['review-summary', 'summary'],
    ] as const) {
      expect(data[key]).toBe(
        await page.locator(`#exports-form input[name="${field}"]`).inputValue(),
      );
    }
    expect(data['diff']).toBe(EXPECTED_DIFF);
  });
  test('getState() carries a `reviewSession` key that JSON.stringify silently drops', async () => {
    await page.getByTestId('read-state-keys').click();
    // The object literal always sets `reviewSession: undefined`, so the key
    // EXISTS on the returned state...
    await expect(page.getByTestId('imperative-state-keys')).toHaveText(
      'schemaVersion,content,original,threads,reviewSession,frontMatter,frontMatterRaw,updatedAt',
    );
    // ...but `JSON.stringify` omits undefined-valued keys, which is why the
    // JSON export below has seven keys and not eight. Two different answers
    // to "what shape is ReviewState?" depending on how you look at it.
  });
});
