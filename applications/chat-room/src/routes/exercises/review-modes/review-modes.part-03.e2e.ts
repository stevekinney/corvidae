import { expect, test } from '@playwright/test';
import type { Locator, Page } from './review-modes-test-helpers';
import {
  bodyParagraph,
  clearSelection,
  frame,
  openReviewModes,
  selectText,
  surface,
} from './review-modes-test-helpers';

function readStyles(scope: Locator) {
  return scope.evaluate((container) => {
    function selectValue(element: Element): string {
      const computed = getComputedStyle(element);
      return (
        computed.getPropertyValue('user-select') || computed.getPropertyValue('-webkit-user-select')
      );
    }

    const editor = container.querySelector('.ProseMirror');
    const wrapper = container.querySelector('.markdown-editor-wrapper');
    if (editor === null || wrapper === null) throw new Error('review editor nodes are missing');
    return {
      containerSelect: selectValue(container),
      containerCaret: getComputedStyle(container).caretColor,
      wrapperSelect: selectValue(wrapper),
      editorCaret: getComputedStyle(editor).caretColor,
    };
  });
}

function quoted(text: string): string {
  return test.info().project.name.startsWith('webkit-') ? `"${text}"` : `'${text}'`;
}

function classesOf(scope: Locator): Promise<string[]> {
  return scope.evaluate((element) => [...element.classList]);
}

test.describe('review-modes: snapshotMode, placeholder, and class', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await openReviewModes(page, ['modes-edit', 'modes-snapshot', 'modes-plain']);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('snapshotMode stamps `data-snapshot-mode` on the container AND the inner editor wrapper', async () => {
    await expect(surface(frame(page, 'modes-snapshot'))).toHaveAttribute(
      'data-snapshot-mode',
      'true',
    );
    // ReviewEditor forwards the prop to its MarkdownEditor, which stamps its
    // own wrapper: two elements, one prop.
    await expect(frame(page, 'modes-snapshot').locator('.markdown-editor-wrapper')).toHaveAttribute(
      'data-snapshot-mode',
      'true',
    );

    // `data-snapshot-mode={snapshotMode || undefined}`: with the prop false
    // the attribute is ABSENT rather than `"false"`, so an attribute
    // selector matches nothing instead of matching a falsy value.
    await expect(surface(frame(page, 'modes-plain'))).not.toHaveAttribute('data-snapshot-mode');
    await expect(
      frame(page, 'modes-plain').locator('.markdown-editor-wrapper'),
    ).not.toHaveAttribute('data-snapshot-mode');
  });

  test('snapshotMode suppresses the caret and the selection highlight on the container and every descendant', async () => {
    // The authored rule is `[data-snapshot-mode], [data-snapshot-mode] *` — but
    // the descendant half does NOT reach the ProseMirror, and never has, in any
    // engine. This test used to claim it did, and passed in Chromium for an
    // unrelated reason. Firefox is what noticed.
    //
    // Inside a Svelte `<style>` the `*` compiles to `:where(.svelte-…)`, so the
    // descendant half can only match elements the component itself rendered.
    // `.milkdown` and `.ProseMirror` are created at runtime by Milkdown and
    // carry no scope class, so `element.matches(<compiled selector>)` is false
    // for them — verified in Chromium too, not just Firefox. What Chromium was
    // showing is Blink INHERITING `user-select`, which css-ui-4 defines as
    // non-inherited and which Gecko implements as such. So Firefox's `auto`
    // there is the spec-correct value.
    //
    // `caret-color` is genuinely inherited, which is why only the `user-select`
    // key diverged — and it is why the caret half of these assertions really
    // was measuring what it claimed. Those stay exactly as they were.
    //
    // What replaces the false key pins strictly more: `.markdown-editor-wrapper`
    // is the last scope-classed ancestor, i.e. the true boundary of the rule.
    // Asserting `none` there catches a regression that broke the container rule,
    // which the old `.ProseMirror` read could not distinguish from inheritance.
    //
    // `user-select` is read under BOTH spellings, and that is not defensive
    // padding: WebKit does not implement the unprefixed property at all
    // (`CSS.supports('user-select', 'none')` is false there), so the
    // unprefixed read returns `''` and only `-webkit-user-select` carries the
    // value. Reading one name and getting `''` would have looked exactly like
    // "the rule does not reach this element", which is the claim this test
    // exists to make — a false negative dressed as a finding. The expected
    // value stays exactly `'none'`: the suppression genuinely happens in
    // WebKit, it is just spelled differently.
    expect(await readStyles(surface(frame(page, 'modes-snapshot')))).toEqual({
      containerSelect: 'none',
      containerCaret: 'rgba(0, 0, 0, 0)',
      wrapperSelect: 'none',
      editorCaret: 'rgba(0, 0, 0, 0)',
    });

    // The control: without the attribute nothing is suppressed, and the
    // caret keeps a real, opaque color.
    //
    // A SET rather than a literal, because `auto` and `text` are the same
    // answer spelled two ways — the initial value's used value chains from the
    // parent, and the engines serialize that differently. Naming both keeps the
    // claim exact ("selectable"); `not.toBe('none')` would have been vaguer,
    // and a bare `'auto'` was asserting a Chromium spelling.
    const plain = await readStyles(surface(frame(page, 'modes-plain')));
    expect(['auto', 'text']).toContain(plain.containerSelect);
    expect(['auto', 'text']).toContain(plain.wrapperSelect);
    expect(plain.containerCaret).not.toBe('rgba(0, 0, 0, 0)');
    expect(plain.editorCaret).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('snapshotMode really is purely visual: the editor still takes typed input and still creates comments', async () => {
    // The prop's own doc says it "does NOT affect editability, ProseMirror
    // state, or any prop controlled by readonly / mode". `user-select: none`
    // on a contenteditable makes that non-obvious — but a real click still
    // places a caret and the keystrokes still land.
    const value = page.getByTestId('modes-snapshot-value-json');
    const before = ((await value.textContent()) ?? '').trim();

    await bodyParagraph(page, 'modes-snapshot').click();
    await expect(page.locator('#modes-snapshot .ProseMirror')).toBeFocused();
    await page.keyboard.type('SNAPSHOT');

    await expect(page.locator('#modes-snapshot .ProseMirror')).toContainText('SNAPSHOT');
    await expect.poll(async () => ((await value.textContent()) ?? '').trim()).not.toBe(before);
    // `onchange` fired with a document length, so ProseMirror state genuinely
    // moved rather than the DOM merely repainting.
    await expect(
      page.getByTestId('modes-snapshot-event-log').getByRole('listitem').last(),
    ).toHaveText(/^change:\d+$/);

    // The mount-time blur is exactly that: a `$effect` whose only reactive
    // dependencies are `snapshotMode` and the container element. It runs
    // once and never again, so focus acquired afterwards is left alone.
    await expect(page.locator('#modes-snapshot .ProseMirror')).toBeFocused();

    // Comment creation is untouched too — the selection popover appears here
    // exactly as it does in a non-snapshot edit instance.
    expect(await selectText(page, 'modes-snapshot', 'Checklist')).toBe('Checklist');
    await expect(page.locator('#modes-snapshot-selection-popover')).toHaveCount(1);
    await clearSelection(page);
    await expect(page.locator('#modes-snapshot-selection-popover')).toHaveCount(0);
  });

  test('`placeholder` paints when the editor is empty, through a decoration that now actually arrives', async () => {
    const inlinePlaceholder = (editorId: string) =>
      page
        .locator(`#${editorId}`)
        .evaluate((element) => element.style.getPropertyValue('--editor-placeholder'));

    // The prop is still written straight onto the markdown-editor host as
    // `style:--editor-placeholder="'{escaped}'"` with no emptiness check —
    // an earlier draft of the cinder#1306 fix DID gate this on `value`, but
    // that gate was itself reverted in review: `value` is this component's
    // own debounced `$bindable`, so for a few hundred ms after deleting the
    // last character the synchronous ProseMirror decoration below had
    // already cleared while `value` still reported old content, and the
    // CSS's own fallback (`var(--editor-placeholder, 'Start writing...')`)
    // painted the wrong text during that window. Unconditional-but-inert
    // beats gated-but-briefly-wrong, so the property is present on a fully
    // populated document too, arriving as a QUOTED CSS string ready for
    // `content:`, not as a bare value.
    //
    // The quote CHARACTER is engine serialization, not component behavior:
    // Chromium and Firefox hand back the author's original token text, while
    // WebKit re-serializes string tokens with double quotes. The component
    // writes `'…'` in all three. Pinning the engine's spelling keeps the real
    // claim — that it is quoted at all, and therefore usable by `content:` —
    // exact, rather than weakening it to a substring match.
    //
    // `test.info().project.name` rather than the `browserName` fixture: this
    // callback takes no arguments (the suite shares a module-level `page`), so
    // the fixture is not destructurable here. WebKit is split into bounded
    // projects so its browser process never crosses its context lifetime limit.
    expect(await inlinePlaceholder('modes-plain')).toBe(quoted('Start reviewing…'));
    expect(await inlinePlaceholder('modes-edit')).toBe(quoted('Start writing...'));

    // FIXED (cinder#1306). The stylesheet paints the placeholder through
    // `.ProseMirror p.is-editor-empty:first-child::before`, and Milkdown's
    // `placeholderPlugin` decorates the first paragraph with that class
    // whenever the document is empty — the decoration itself was never the
    // bug. What raced was its REGISTRATION: the lazy plugin that installs it
    // used to import `@milkdown/kit/core` inside an async handler, so
    // `EditorState.create()`'s one-time plugin snapshot usually ran before
    // that import resolved and silently excluded it for the editor's whole
    // life. Registering the timer synchronously (mirroring Milkdown's own
    // `$proseAsync` pattern) wins that race every time, so `modes-plain`'s
    // empty document now carries the class with no interaction needed.
    await expect(page.getByTestId('modes-plain-value-length')).toHaveText('value length: 0');
    const emptyParagraph = page.locator('#modes-plain .ProseMirror p');
    await expect(emptyParagraph).toHaveCount(1);
    await expect(emptyParagraph).toHaveClass(/is-editor-empty/);

    // Read the pseudo-element the class unlocks without forcing anything —
    // this is what a real paint pass resolves, not a simulated one. The
    // browser's CSS-OM serialization of a resolved `content` value is
    // double-quoted regardless of engine (unlike the raw custom-property
    // text above, which preserves the author's own quote character), so
    // this is a literal rather than `quoted()`.
    const painted = await emptyParagraph.evaluate((paragraph) => {
      const before = getComputedStyle(paragraph, '::before');
      return { content: before.content, color: before.color };
    });
    expect(painted.content).toBe('"Start reviewing…"');
    // A `content` string alone would still be the old bug one layer down —
    // present but invisible. `color: transparent` (or an alpha-zero rgba)
    // would mean exactly that, so pin genuine visibility, not merely a
    // populated string.
    expect(painted.color).not.toBe('rgba(0, 0, 0, 0)');
    expect(painted.color).not.toBe('transparent');

    // The decoration is a live ProseMirror computation, not a mount-time
    // snapshot, so it hides the moment the document stops being empty —
    // the same gesture a real reviewer would use.
    await emptyParagraph.click();
    await expect(page.locator('#modes-plain .ProseMirror')).toBeFocused();
    await page.keyboard.type('No longer empty');
    await expect(emptyParagraph).not.toHaveClass(/is-editor-empty/);
    const afterTyping = await emptyParagraph.evaluate(
      (paragraph) => getComputedStyle(paragraph, '::before').content,
    );
    expect(afterTyping).toBe('none');

    // Either way the placeholder is decoration and not content: a
    // pseudo-element is invisible to the accessibility tree, and nothing
    // carries a `placeholder` attribute for a locator to find.
    await expect(page.getByPlaceholder('Start reviewing…')).toHaveCount(0);
  });

  test('`class` is merged onto the container after `review-editor-container`, not substituted for it', async () => {
    const merged = await classesOf(surface(frame(page, 'modes-plain')));
    // `classNames('review-editor-container', className)` puts the
    // component's own class first; the Svelte compiler then appends its
    // scoping hash. That trailing hash is why this is a membership plus
    // index check rather than a string comparison.
    expect(merged[0]).toBe('review-editor-container');
    expect(merged).toContain('exercise-frame');
    expect(merged.some((name) => name.startsWith('svelte-'))).toBe(true);

    // An instance that passes no `class` still gets the base class, so the
    // merge added `exercise-frame` rather than replacing anything.
    const bare = await classesOf(surface(frame(page, 'modes-edit')));
    expect(bare[0]).toBe('review-editor-container');
    expect(bare).not.toContain('exercise-frame');
  });
});
