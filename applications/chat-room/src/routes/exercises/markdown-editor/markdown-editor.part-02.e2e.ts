import { expect, test } from '@playwright/test';
import type { SelectionReadout } from './markdown-editor-test-helpers';
import {
  HEADING,
  HEADING_FROM,
  HEADING_TO,
  INITIAL,
  MAIN_ID,
  MARKER,
  PROBE_A,
  PROBE_B,
  QUOTE_FROM,
  QUOTE_OFFSET,
  QUOTE_TO,
  READONLY_ID,
  json,
  ready,
  selectionEvents,
} from './markdown-editor-test-helpers';

test.describe('markdown-editor: the two coordinate spaces', () => {
  test('getSelection reports ProseMirror positions, and the textBetween offset is a different number', async ({
    page,
  }) => {
    await ready(page);
    await page.getByTestId('select-quote').click();
    const quoted = await json<SelectionReadout>(page, 'selection-json');

    // SPACE ONE — ProseMirror positions, which is all `getSelection()` returns.
    expect(quoted.selection).toEqual({ from: QUOTE_FROM, to: QUOTE_TO, isCollapsed: false });

    // SPACE TWO — `doc.textBetween()` offsets, derived by the page because the
    // method returns none. For this selection they are 42 and 9 against positions
    // 44 and 53: the offset trails the position by the two block boundary tokens
    // the heading and paragraph-one nodes contribute, and the length is a
    // character count rather than a difference of positions.
    expect(quoted.derived).toEqual({ offset: QUOTE_OFFSET, length: MARKER.length, quote: MARKER });

    // Stated as inequalities as well as literals, so the pair cannot both drift
    // to one value and keep passing.
    expect(quoted.selection!.from).not.toBe(quoted.derived!.offset);
    expect(quoted.selection!.from).toBeGreaterThan(quoted.derived!.offset);
    expect(quoted.selection!.to - quoted.selection!.from).toBe(quoted.derived!.length);

    // `EditorSelection` declares `sourcePosition` as "mapped to mdast position
    // via bridge (when available)". MarkdownEditor never populates it — the
    // bridge that computes one is on no path this component takes — so a consumer
    // reading it gets `undefined` with nothing to warn them. Pinned as the
    // current behaviour, not endorsed as the right one.
    expect(quoted.sourcePosition).toBeNull();

    // The heading is the weaker demonstration and is here as the control: 1
    // against 0 and 13 against 12 differ by exactly one boundary token, small
    // enough that a coordinate-space mixup could pass unnoticed. It is the
    // paragraph-one selection above that separates the two spaces by 2.
    await page.getByTestId('select-heading').click();
    const heading = await json<SelectionReadout>(page, 'selection-json');
    expect(heading.selection).toEqual({ from: HEADING_FROM, to: HEADING_TO, isCollapsed: false });
    expect(heading.derived).toEqual({ offset: 0, length: HEADING.length, quote: HEADING });

    // A collapsed caret is the third shape the method reports, and the only one
    // where `from === to` carries meaning.
    await page.getByTestId('collapse-caret').click();
    const caret = await json<SelectionReadout>(page, 'selection-json');
    expect(caret.selection).toEqual({ from: QUOTE_FROM, to: QUOTE_FROM, isCollapsed: true });
    expect(caret.derived).toEqual({ offset: QUOTE_OFFSET, length: 0, quote: '' });
  });

  test('one dispatch is enough for onselectionchange to carry the live selection', async ({
    page,
  }) => {
    await ready(page);
    // REGRESSION PIN for cinder#1288/#1289, on the component that owns the code.
    // Milkdown's listener fires `selectionUpdated` from inside `state.apply(tr)`,
    // where `view.state` is still the PREVIOUS state — so a listener reading
    // `view.state.selection` reported the selection from one transaction ago.
    // `@repo/editor@0.9.1` hands the listener `tr.selection` instead.
    //
    // `getSelection()` was never affected, and is asserted alongside for exactly
    // that reason: it reads `view.state` at CALL time, by which point the view
    // has been updated. The two surfaces agreeing is the fix; assuming they
    // always did is the mistake this pins.
    await page.getByTestId('clear-selection-events').click();
    await expect(page.getByTestId('selection-events')).toHaveText('');

    // ONE selection-changing dispatch, through the page's `getView()` path.
    await page.getByTestId('select-quote').click();

    await expect
      .poll(async () => {
        const events = await selectionEvents(page);
        return events.at(-1);
      })
      .toBe(`${QUOTE_FROM}:${QUOTE_TO}:false`);

    const readback = await json<SelectionReadout>(page, 'selection-json');
    expect(readback.selection).toEqual({ from: QUOTE_FROM, to: QUOTE_TO, isCollapsed: false });
  });
});

test.describe('markdown-editor: the plugin seam', () => {
  test('a plugin passed through the plugins prop decorates the live document', async ({ page }) => {
    await ready(page);
    const probe = page.locator(`#${MAIN_ID} .ProseMirror .${PROBE_A}`);
    await expect(probe).toHaveCount(1);
    await expect(probe).toHaveText(MARKER);

    // The plugin found the marker by scanning `state.doc` itself, with no
    // knowledge of this file's arithmetic; the selection below reaches the same
    // text from hand-computed positions 44..53. Two independent derivations of
    // one range agreeing is what makes either of them credible.
    await page.getByTestId('select-quote').click();
    const selection = await json<SelectionReadout>(page, 'selection-json');
    expect(selection.derived!.quote).toBe(await probe.textContent());
  });

  test('reassigning the plugins prop is inert, and only a remount applies a new array', async ({
    page,
  }) => {
    await ready(page);
    // The genuinely surprising half of this seam. `plugins` is read once, inside
    // `untrack()`, when the editor attachment is created
    // (`dist/editor/attach.js`), so the prop looks reactive and is not. A consumer
    // swapping decorations at runtime gets silence.
    const original = page.locator(`#${MAIN_ID} .${PROBE_A}`);
    const replacement = page.locator(`#${MAIN_ID} .${PROBE_B}`);
    const readyCount = page.getByTestId('ready-count');

    await expect(original).toHaveCount(1);
    await expect(replacement).toHaveCount(0);
    await expect(readyCount).toHaveText('1');

    await page.getByTestId('swap-plugins').click();

    // The load-bearing assertion is that the ORIGINAL decoration survives, not
    // that the new one is missing. An implementation that re-created the editor
    // would tear the old ProseMirror DOM down synchronously and rebuild it
    // asynchronously, so "the new one is absent" is momentarily true even when
    // the swap did take effect.
    await expect(original).toHaveCount(1);
    await expect(original).toHaveText(MARKER);
    await expect(replacement).toHaveCount(0);
    // The second, independent observable: a re-created editor reports ready
    // again. This is what separates "the swap was ignored" from "the swap is
    // still in flight".
    await expect(readyCount).toHaveText('1');
    await expect(page.getByTestId('announcement')).toHaveText(
      /still shows 1 decoration from the original plugin and 0 decorations from the new one/,
    );

    // A remount re-runs the attachment, which re-reads the getter — so the array
    // that was inert a moment ago now applies in full.
    await page.getByTestId('remount-editor').click();
    await expect(readyCount).toHaveText('2');
    await expect(replacement).toHaveCount(1);
    await expect(replacement).toHaveText(MARKER);
    await expect(original).toHaveCount(0);
  });
});

test.describe('markdown-editor: mode and the toolbar context', () => {
  test('bind:mode swaps the surface in both directions and the document survives', async ({
    page,
  }) => {
    await ready(page);
    const wrapper = page.getByTestId('main-editor');
    await expect(wrapper).toHaveAttribute('data-mode', 'wysiwyg');

    await page.getByTestId('mode-source').click();
    await expect(wrapper).toHaveAttribute('data-mode', 'source');
    // The same `id` now belongs to a textarea rather than the application host —
    // the surface is genuinely replaced, not hidden.
    await expect(page.locator(`#${MAIN_ID} .ProseMirror`)).toHaveCount(0);
    // Trimmed: entering source mode canonicalises the document through the
    // markdown pipeline first, and the pipeline owns trailing whitespace.
    await expect
      .poll(async () => {
        const value = await page.locator(`textarea#${MAIN_ID}`).inputValue();
        return value.trim();
      })
      .toBe(INITIAL);
    await expect(page.getByTestId('mode-events')).toHaveText('source');

    await page.getByTestId('mode-wysiwyg').click();
    await expect(wrapper).toHaveAttribute('data-mode', 'wysiwyg');
    await expect(page.locator(`#${MAIN_ID} .ProseMirror h3`)).toHaveText(HEADING);
    await expect(page.getByTestId('mode-events')).toHaveText('source|wysiwyg');
    // Round-tripped through the raw-markdown surface and back unchanged.
    const resetValue = await json<string>(page, 'value-json');
    expect(resetValue.trim()).toBe(INITIAL);
  });

  test("the component's own mode toggle writes back through the binding", async ({ page }) => {
    await ready(page);
    // The other direction. The test above drives `mode` from the page and watches
    // the component follow; this one drives the component's shipped control and
    // watches the page's own `$state` follow, which is the half a one-way prop
    // would still satisfy.
    await expect(page.getByTestId('mode-readout')).toHaveText('wysiwyg');
    await page.locator(`#${MAIN_ID}-mode-toggle [aria-label="Raw Markdown"]`).click();
    await expect(page.getByTestId('mode-readout')).toHaveText('source');
    await expect(page.getByTestId('main-editor')).toHaveAttribute('data-mode', 'source');
  });

  test('the toolbarActions snippet receives a ToolbarContext that tracks the editor', async ({
    page,
  }) => {
    await ready(page);
    const context = page.getByTestId('toolbar-context');
    // `editorContext` is null until the attachment reports ready and non-null
    // after, so this is the snippet seeing the real editor rather than a
    // placeholder.
    await expect(context).toHaveText('ctx=yes undo=false redo=false ro=false');

    // `canUndo` derives from ProseMirror's history depth, and the derivation reads
    // `value` — which only moves after Milkdown's 200ms listener debounce and the
    // package's 300ms `onchange` debounce. Polling measures that chain; a fixed
    // wait would be a guess at its total.
    await page.getByTestId('focus-editor').click();
    await page.keyboard.type('Draft. ');
    await expect(context).toHaveText(/undo=true/);
    await expect(context).toHaveText(/ctx=yes/);
  });
});

test.describe('markdown-editor: readonly', () => {
  test('readonly is mirrored onto the ProseMirror node as aria-readonly', async ({ page }) => {
    await ready(page);
    // REGRESSION PIN for cinder#1292, asserted on the component that implements
    // it. `editable: () => false` gives the node `contenteditable="false"`, which
    // stops edits but conveys nothing: Chromium still computes the textbox as
    // `readonly=false, settable=true`, so a screen reader announces an ordinary
    // editable field that silently ignores typing.
    //
    // It has to be on `view.dom`. The wrapping `role="application"` host carries
    // no textbox role and ARIA states do not inherit down to the node that does —
    // which is what the originally-filed version of that fix got wrong.
    const readonlySurface = page.locator(`#${READONLY_ID} .ProseMirror`);
    const editableSurface = page.locator(`#${MAIN_ID} .ProseMirror`);

    await expect(readonlySurface).toHaveAttribute('aria-readonly', 'true');
    await expect(readonlySurface).toHaveAttribute('contenteditable', 'false');
    // The editable instance is the control. Without it this would pass against a
    // component that set the attribute unconditionally.
    await expect(editableSurface).not.toHaveAttribute('aria-readonly', 'true');
    await expect(editableSurface).toHaveAttribute('contenteditable', 'true');
  });

  test('a readonly editor renders no toolbar but still reports its toolbar context', async ({
    page,
  }) => {
    await ready(page);
    const readonlyWrapper = page.getByTestId('readonly-editor');
    // `toolbarVisible` is `showToolbar && !readonly && …`, so readonly removes the
    // toolbar outright rather than disabling it.
    await expect(readonlyWrapper).not.toHaveAttribute('data-has-toolbar', 'true');
    await expect(readonlyWrapper.locator('.editor-toolbar')).toHaveCount(0);
    // …and the editable instance proves that absence is the `readonly` prop's
    // doing rather than the toolbar never rendering on this page at all.
    await expect(page.getByTestId('main-editor')).toHaveAttribute('data-has-toolbar', 'true');

    // `ontoolbarcontextchange` is therefore the ONLY route to that state for a
    // readonly editor, which makes it the callback a consumer hosting its own
    // formatting controls depends on. It still fires, with a real Ctx and the
    // readonly flag set.
    await expect(page.getByTestId('ro-toolbar-context')).toHaveText(
      'ctx=yes undo=false redo=false ro=true',
    );
  });
});
