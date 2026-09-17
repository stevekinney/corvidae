import { expect, test } from '@playwright/test';
import type { Page } from './review-front-matter-test-helpers';
import {
  FULL_DOCUMENT,
  REWRITTEN_FULL_DOCUMENT,
  frontMatterSection,
  openFixture,
} from './review-front-matter-test-helpers';

test.describe('review front matter: what an edit rewrites', () => {
  // One page for the mutating tests. Order matters WITHIN a fixture: `fm-full`'s
  // two tests are a pair, and so are `fm-empty`'s two ("doubles as the way to
  // add a first field" must run before "the field controls cannot make the
  // YAML unparseable again", which relies on the `title` field the first test
  // creates). Playwright runs a file's tests serially in declaration order, so
  // the tests are ordered deliberately.
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await openFixture(browser);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('editing one field rewrites the whole block: keys alphabetize and block sequences collapse to flow', async () => {
    await page.locator('#fm-full-front-matter-title').fill('Release Plan v2');

    // `title` was the only field touched. Everything else moved anyway,
    // because `stringifyFrontMatter` can only preserve the original raw text
    // when the data is byte-identical; the moment any key differs it
    // re-serializes the whole object through `serializeYaml`, which sorts keys
    // and renders simple string arrays inline.
    await expect(page.getByTestId('fm-full-value')).toHaveAttribute(
      'data-value',
      JSON.stringify(REWRITTEN_FULL_DOCUMENT),
    );

    // The controls re-order to match, so the field you just typed into jumps
    // somewhere else in the form.
    const controls = frontMatterSection(page, 'fm-full').locator('input, textarea');
    await expect(controls.nth(0)).toHaveAttribute('id', 'fm-full-front-matter-draft');
    await expect(controls.nth(1)).toHaveAttribute('id', 'fm-full-front-matter-meta');
    await expect(controls.nth(2)).toHaveAttribute('id', 'fm-full-front-matter-priority');
    await expect(controls.nth(3)).toHaveAttribute('id', 'fm-full-front-matter-tags');
    await expect(controls.nth(4)).toHaveAttribute('id', 'fm-full-front-matter-title');
  });

  test('the edited value flows back as a FULL document, and `onchange` receives it once', async () => {
    // The component recombines body and front matter before publishing, so
    // consumers never see a body-only string — `value` and the `onchange`
    // argument are the same complete document, delimiters included.
    await expect(page.getByTestId('fm-full-change-count')).toHaveText('1');
    await expect(page.getByTestId('fm-full-last-change')).toHaveAttribute(
      'data-value',
      JSON.stringify(REWRITTEN_FULL_DOCUMENT),
    );
  });

  test('malformed YAML — a genuine syntax error — is not recognized as front matter at all', async () => {
    // `title: [unclosed` opens a flow sequence that never closes: a genuine
    // YAML syntax error, not merely "valid YAML that isn't a mapping". Before
    // cinder#1325/#1330 this fixture's document still reported
    // `hasFrontMatter: true` with `data: null`, which used to select a raw
    // YAML fallback editor (and log a console warning — "Failed to parse
    // front matter: YAMLException…"). The same PR that stopped counting
    // non-object-but-valid YAML as front matter also folded a genuine parse
    // failure into the identical `hasFrontMatter: false` branch as an
    // unrecognized delimiter — `parseFrontMatter`'s `catch` block, not its
    // `!isRecord` branch. Verified directly against the installed
    // `@repo/markdown`, calling `parseFrontMatter` on this fixture's
    // exact document: it now returns `{ hasFrontMatter: false, body: <the
    // whole document> }`. There is no longer a raw-editor-for-invalid-content
    // state reachable from this fixture at all, and no console warning fires
    // either — the `catch` block is silent.
    await expect(frontMatterSection(page, 'fm-bad')).toHaveCount(0);

    // Proof it's content, not silently dropped: the un-recognized `---`
    // lines vanish as thematic breaks — the same Markdown reading the
    // delimiter-matrix fixtures get above — while the YAML text inside them
    // survives as ordinary body text.
    await expect(page.getByTestId('fm-bad-wrapper').locator('.ProseMirror')).toContainText(
      'title: [unclosed',
    );

    // Nothing was edited, so the bound value round-trips byte-for-byte.
    await expect(page.getByTestId('fm-bad-value')).toHaveAttribute(
      'data-value',
      JSON.stringify(
        [
          '---',
          'title: [unclosed',
          '  - what',
          '---',
          '',
          '# Release Plan',
          '',
          'Alpha line.',
        ].join('\n'),
      ),
    );
  });

  test('touching a null field writes a quoted string, with no way back to null', async () => {
    // Retyping the exact four characters the input already displays is not a
    // no-op: the control's value is a string, so `null` becomes the STRING
    // "null", and `needsQuoting` then double-quotes it to keep it from
    // parsing back as a null. The input still reads `null` afterwards, so the
    // UI gives no sign that the document's meaning changed.
    const bare = page.locator('#fm-null-front-matter-empty');
    await bare.fill('null');

    await expect(page.getByTestId('fm-null-value')).toHaveAttribute(
      'data-value',
      JSON.stringify(['---', 'empty: "null"', 'nothing: null', '---', '', 'Body.'].join('\n')),
    );
    await expect(bare).toHaveValue('null');
  });

  test('the empty-front-matter raw editor doubles as the way to add a first field', async () => {
    // A side effect of the dead empty-state branch above: because empty front
    // matter falls into the RAW editor rather than an empty-state paragraph,
    // there IS a UI path to a first field — type YAML into it. There is no
    // dedicated "add field" affordance anywhere in the section; this is it.
    // Also note the serializer keeps `---\n---\n` documents alive
    // (`preserveEmptyFrontMatter`), so the delimiters were never at risk.
    //
    // There is also no debounce and no "apply" step — a single `.fill()`
    // commits immediately, with no separate step to confirm it. (This used
    // to have its own dedicated test, pinned on `fm-bad`'s raw editor and
    // filling just `'title:'` to land "mid-word." That fixture no longer
    // offers a raw editor at all — see the malformed-YAML test above — but
    // the "mid-word" framing was never actually exercising keystroke
    // granularity to begin with: Playwright's `.fill()` dispatches a single
    // `input` event carrying the final value, so a partial-looking string
    // like `'title:'` proves the same thing a complete one does. No coverage
    // is lost by retiring it; this test's single `.fill()` already pins the
    // same no-debounce commit.)
    await page.locator('textarea#fm-empty-front-matter-raw').fill('title: x');

    await expect(page.getByTestId('fm-empty-value')).toHaveAttribute(
      'data-value',
      JSON.stringify(['---', 'title: x', '---', '', 'Body.'].join('\n')),
    );
    await expect(page.locator('#fm-empty-front-matter-title')).toHaveValue('x');
  });

  test('once parseable, the field controls cannot make the YAML unparseable again', async () => {
    // This used to be pinned on `fm-bad`'s raw-editor-to-field transition:
    // type `[unclosed` into the `title` field that a parseable keystroke had
    // just created, and confirm it can't reproduce the syntax error that
    // broke the document originally. `fm-bad` no longer offers a raw editor
    // at all (a genuine YAML syntax error is never recognized as front
    // matter now — see above), so there is no reachable "recognized front
    // matter, still showing a raw editor" state left to re-break on that
    // fixture. `fm-empty`, converted to field controls by the test above, is
    // the only fixture left on this page that reaches field controls by way
    // of a raw editor, so the invariant now pins here instead: recovering
    // the raw editor requires `data` to be null again, which requires
    // unparseable YAML, and the field UI cannot produce that — a string
    // field always QUOTES anything YAML-significant, so typing the same
    // `[unclosed` that would break a raw editor round-trips as a perfectly
    // valid quoted scalar instead.
    await page.locator('#fm-empty-front-matter-title').fill('[unclosed');

    await expect(page.getByTestId('fm-empty-value')).toHaveAttribute(
      'data-value',
      JSON.stringify(['---', 'title: "[unclosed"', '---', '', 'Body.'].join('\n')),
    );
    await expect(page.locator('textarea#fm-empty-front-matter-raw')).toHaveCount(0);
  });

  test('readonly ignores a programmatic input event on a front-matter control', async () => {
    // `disabled` alone is only a UI affordance; this checks the guard behind
    // it. The event genuinely lands (the DOM value changes and stays changed,
    // since no re-render reverts it) but `patchField` returns early, so
    // nothing reaches the document.
    const title = page.locator('#fm-readonly-front-matter-title');
    await title.evaluate((element) => {
      if (!(element instanceof HTMLInputElement)) {
        throw new Error('Expected front matter title control to be an input.');
      }
      element.value = 'Tampered';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await expect(title).toHaveValue('Tampered');
    await expect(page.getByTestId('fm-readonly-value')).toHaveAttribute(
      'data-value',
      JSON.stringify(FULL_DOCUMENT),
    );
  });
});
