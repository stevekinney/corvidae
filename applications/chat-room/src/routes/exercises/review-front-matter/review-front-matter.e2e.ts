import { expect, test } from '@playwright/test';
import type { Page } from './review-front-matter-test-helpers';
import {
  EDITOR_COUNT,
  FULL_DOCUMENT,
  frontMatterSection,
  openFixture,
} from './review-front-matter-test-helpers';

test.describe('review front matter: recognition and generated controls', () => {
  // Read-only assertions share one page; the editing tests below get their own
  // so a rewrite here can never leak into an at-rest expectation there.
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await openFixture(browser);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('front matter is only an exact `---` opener at byte 0 closed by a line of exactly `---`', async () => {
    // `----` is not the closer: the closing pattern is `^---[ \t]*\r?$`, so a
    // fourth dash fails the end-of-line anchor and the whole block stays body.
    await expect(
      page.getByTestId('fm-four-dash-wrapper').locator('section.review-editor-front-matter'),
    ).toHaveCount(0);
    // Proof it was treated as CONTENT rather than silently dropped: the YAML
    // text is rendered inside the editor (as a setext heading, since `----`
    // underlines the line above it).
    await expect(page.getByTestId('fm-four-dash-wrapper').locator('.ProseMirror')).toContainText(
      'title: x',
    );

    // YAML's own `...` document terminator is not a front-matter closer.
    await expect(
      page.getByTestId('fm-dots-wrapper').locator('section.review-editor-front-matter'),
    ).toHaveCount(0);
    await expect(page.getByTestId('fm-dots-wrapper').locator('.ProseMirror')).toContainText(
      'title: x',
    );

    // A single leading blank line is enough: `markdown.startsWith('---')` is
    // checked at byte 0 with no trimming.
    await expect(
      page.getByTestId('fm-leading-blank-wrapper').locator('section.review-editor-front-matter'),
    ).toHaveCount(0);
    await expect(
      page.getByTestId('fm-leading-blank-wrapper').locator('.ProseMirror'),
    ).toContainText('title: x');

    // Seven of the eleven fixtures have front matter. The three above fail on
    // DELIMITER shape (a fourth dash, a `...` closer, an opener not at byte
    // 0). A fourth fixture, `fm-bad` (exercised below, in the next describe),
    // fails on CONTENT shape instead: its YAML has a genuine syntax error.
    // cinder#1325/#1330 folded that case into the identical `hasFrontMatter:
    // false` outcome as an unrecognized delimiter, rather than the
    // "recognized but invalid, show a raw editor" state it used to produce —
    // see "malformed YAML — a genuine syntax error — is not recognized as
    // front matter at all" below for the detail.
    await expect(page.locator('section.review-editor-front-matter')).toHaveCount(EDITOR_COUNT - 4);
  });

  test('a CRLF document is recognized and its data parsed, and the CRLF survives in `value`', async () => {
    await expect(
      page.getByTestId('fm-crlf-wrapper').locator('section.review-editor-front-matter'),
    ).toHaveCount(1);
    await expect(page.locator('#fm-crlf-front-matter-title')).toHaveValue('x');
    await expect(page.locator('#fm-crlf-front-matter-draft')).toBeChecked();
    // The body really was split off, not just parsed alongside.
    await expect(page.getByTestId('fm-crlf-wrapper').locator('.ProseMirror')).toHaveText('Body.');
    await expect(page.getByTestId('fm-crlf-value')).toHaveAttribute(
      'data-value',
      JSON.stringify(['---', 'title: x', 'draft: true', '---', '', 'Body.'].join('\r\n')),
    );
  });

  test('the section renders above the editor, labelled by its own `h3`', async () => {
    const wrapper = page.getByTestId('fm-full-wrapper');
    const section = frontMatterSection(page, 'fm-full');
    await expect(section).toHaveCount(1);
    await expect(section).toHaveClass(/review-editor-front-matter/);

    const heading = page.locator('h3#fm-full-front-matter-heading');
    await expect(heading).toHaveText('Front matter');

    // Document order, asserted through locators rather than a pixel compare:
    // the two children match in DOM order, and the first is the section.
    const parts = wrapper.locator('section.review-editor-front-matter, .ProseMirror');
    await expect(parts).toHaveCount(2);
    await expect(parts.nth(0)).toHaveClass(/review-editor-front-matter/);
  });

  test('one control per key, id `<editor-id>-front-matter-<key>`, label equal to the raw key name', async () => {
    const section = frontMatterSection(page, 'fm-full');
    const controls = section.locator('input, textarea');

    // Source order, NOT alphabetical — the initial render walks
    // `Object.entries(data)`, which preserves the YAML document's order. The
    // alphabetizing only happens on the first edit (see the editing describe).
    await expect(controls).toHaveCount(5);
    await expect(controls.nth(0)).toHaveAttribute('id', 'fm-full-front-matter-title');
    await expect(controls.nth(1)).toHaveAttribute('id', 'fm-full-front-matter-draft');
    await expect(controls.nth(2)).toHaveAttribute('id', 'fm-full-front-matter-priority');
    await expect(controls.nth(3)).toHaveAttribute('id', 'fm-full-front-matter-tags');
    await expect(controls.nth(4)).toHaveAttribute('id', 'fm-full-front-matter-meta');

    // The label is the key verbatim — no title-casing, no humanizing.
    await expect(section.locator('label')).toHaveText([
      'title',
      'draft',
      'priority',
      'tags',
      'meta',
    ]);
    // And it is a real accessible name, so role/label locators work. Scoping to
    // the wrapper is required: five fixtures each expose a `title` field.
    await expect(
      page.getByTestId('fm-full-wrapper').getByLabel('title', { exact: true }),
    ).toHaveAttribute('id', 'fm-full-front-matter-title');
  });

  test('controls are type-driven: boolean → checkbox, number and string → text input, array and object → textarea', async () => {
    const draft = page.locator('#fm-full-front-matter-draft');
    await expect(draft).toHaveAttribute('type', 'checkbox');
    await expect(draft).toBeChecked();

    // A number gets NO `type="number"` and no numeric affordances — it is an
    // ordinary text input whose value happens to be coerced back with
    // `Number()` on input.
    const priority = page.locator('#fm-full-front-matter-priority');
    await expect(priority).toHaveAttribute('type', 'text');
    await expect(priority).toHaveValue('3');

    const title = page.locator('#fm-full-front-matter-title');
    await expect(title).toHaveAttribute('type', 'text');
    await expect(title).toHaveValue('Release Plan');

    // The source YAML writes `tags` as a block sequence over three lines. The
    // textarea presents it in FLOW form, so what the author typed is already
    // gone from the UI before anyone edits anything.
    const tags = page.locator('textarea#fm-full-front-matter-tags');
    await expect(tags).toHaveValue('[alpha, beta]');

    // A nested mapping stays in block form, minus the parent key and its
    // indentation (`serializeYamlFieldValue` strips the synthetic `value:`).
    const meta = page.locator('textarea#fm-full-front-matter-meta');
    await expect(meta).toHaveValue('owner: maya');
  });

  test('with nothing edited the raw block round-trips byte-for-byte and `onchange` never fires', async () => {
    // Mounting the editor does not itself rewrite the document: the front
    // matter keeps its authored key order, block sequence, and spacing. This
    // is the baseline that makes the rewrite in the next describe legible as
    // damage rather than as normal churn.
    await expect(page.getByTestId('fm-full-value')).toHaveAttribute(
      'data-value',
      JSON.stringify(FULL_DOCUMENT),
    );
    await expect(page.getByTestId('fm-full-change-count')).toHaveText('0');
  });

  test('KNOWN BUG: empty front matter renders an empty raw YAML editor, never the empty-state paragraph', async () => {
    // `front-matter-fields.svelte` has a third branch that renders
    // `p.review-editor-front-matter__empty` ("No front matter fields.") when
    // there are no parsed fields AND `raw === null`. That branch is
    // unreachable: `parseReviewEditorFrontMatter` coerces a null `raw` to `''`
    // whenever `hasFrontMatter` is true (`parsed.raw ?? ''`), and the section
    // is only rendered when `hasFrontMatter` is true. So `raw` is never null
    // by the time the component sees it, `shouldShowRawYaml` is always taken
    // first, and the empty state is dead code. Pinned as-is; the paragraph
    // never appears anywhere on this route.
    await expect(page.locator('p.review-editor-front-matter__empty')).toHaveCount(0);

    const raw = page.locator('textarea#fm-empty-front-matter-raw');
    await expect(raw).toHaveValue('');
    // An empty string is valid YAML, so no error decoration accompanies it.
    await expect(raw).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('fm-empty-value')).toHaveAttribute(
      'data-value',
      JSON.stringify(['---', '---', '', 'Body.'].join('\n')),
    );
  });

  test('a YAML null renders as the literal four-character string `null` in a text input', async () => {
    // `empty:` (bare) and `nothing: null` (explicit) both parse to JS `null`,
    // so by the time the UI sees them the two spellings are indistinguishable
    // — and both are shown as the word "null" in a plain text box, which is
    // also exactly how the string "null" would be shown.
    const bare = page.locator('#fm-null-front-matter-empty');
    await expect(bare).toHaveAttribute('type', 'text');
    await expect(bare).toHaveValue('null');

    const explicit = page.locator('#fm-null-front-matter-nothing');
    await expect(explicit).toHaveAttribute('type', 'text');
    await expect(explicit).toHaveValue('null');
  });

  test('`mode="readonly"` disables every front-matter control', async () => {
    const controls = frontMatterSection(page, 'fm-readonly').locator('input, textarea');
    await expect(controls).toHaveCount(5);
    for (let index = 0; index < 5; index++) {
      await expect(controls.nth(index)).toBeDisabled();
    }
  });
});
