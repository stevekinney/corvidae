import { expect, test } from '@playwright/test';
import type { AstReadout } from './markdown-editor-test-helpers';
import {
  DOC_SIZE,
  HEADING,
  INITIAL,
  MAIN_ID,
  PARAGRAPH_ONE,
  PARAGRAPH_THREE,
  PARAGRAPH_TWO,
  REPLACEMENT,
  ROUTE,
  json,
  readAstWhenReady,
  ready,
} from './markdown-editor-test-helpers';

test.describe('markdown-editor: what the server sends', () => {
  test('the server renders the wrapper and a skeleton, and none of the editor', async ({
    request,
  }) => {
    // Raw bytes, so this is the markup a crawler, a no-JS reader, and the first
    // paint all see — before any client module has run.
    const response = await request.get(ROUTE);
    expect(response.ok()).toBe(true);
    const html = await response.text();

    // Both wrappers and their state attributes ship from the server.
    expect(html).toContain('data-testid="main-editor"');
    expect(html).toContain('data-testid="readonly-editor"');
    expect(html).toContain('data-initializing');
    expect(html).toContain('data-mode="wysiwyg"');

    // The editor itself does not: the ProseMirror host, the source textarea AND
    // the toolbar all sit behind `{#if browser}` / `&& browser`, so the server
    // emits a skeleton in their place and the client renders the other branch.
    // That branch swap is a real structural difference between the two renders,
    // which is why this route belongs in `HYDRATING_ROUTES` rather than being
    // assumed clean.
    expect(html).not.toMatch(/class="[^"]*\bProseMirror\b/);
    expect(html).not.toContain('role="application"');
    expect(html).toContain('aria-label="Loading editor"');

    // The toolbar is gated on `browser` too, so the `toolbarActions` snippet —
    // this page's only content inside it — cannot have rendered.
    expect(html).not.toContain('data-testid="toolbar-context"');

    // `data-ready` is the mount gate and is emitted as `undefined`, i.e. omitted
    // entirely, until the attachment reports in. Nothing else on this page emits
    // that attribute (`data-readonly` is browser-gated and is not a substring of
    // it), so a bare substring check is both sufficient and exact.
    expect(html).not.toContain('data-ready');
  });
});

test.describe('markdown-editor: the imperative handle', () => {
  test('getView returns the live ProseMirror view, whose dom sits inside the application host', async ({
    page,
  }) => {
    await ready(page);
    await page.getByTestId('read-view').click();
    const view = await json<{
      present: boolean;
      docSize: number | null;
      domIsProseMirror: boolean | null;
      domIsHost: boolean;
      domInsideHost: boolean;
      editable: boolean | null;
    }>(page, 'view-json');

    expect(view.present).toBe(true);
    expect(view.editable).toBe(true);

    // The empirical check on every position this file asserts: four block nodes
    // costing two boundary tokens each, plus 12 + 74 + 93 + 48 characters,
    // computed from the fixture rather than read back. A parser that nested the
    // document differently — the reason the fixture bans lists — fails here
    // first, before any position assertion could pass for the wrong reason.
    expect(view.docSize).toBe(DOC_SIZE);

    // `getView().dom` is the contenteditable INSIDE the `role="application"`
    // host, not the host. The host carries `tabindex="0"` and the same `id`, so
    // it looks like the editing surface and is not one.
    expect(view.domIsProseMirror).toBe(true);
    expect(view.domIsHost).toBe(false);
    expect(view.domInsideHost).toBe(true);
  });

  test('getEditor returns a live Milkdown editor whose action runs against its own ctx', async ({
    page,
  }) => {
    await ready(page);
    await page.getByTestId('read-editor').click();
    const editor = await json<{
      present: boolean;
      actionResult: string | null;
      actionCtxIsEditorCtx: boolean;
    }>(page, 'editor-json');

    expect(editor.present).toBe(true);
    // `present` alone would pass against any non-null object. Running
    // `editor.action(...)` and getting the editor's OWN `ctx` back is what
    // separates a live Milkdown instance from a stub: `action` is implemented as
    // `(fn) => fn(this.#ctx)`, and `editor.ctx` is a getter over the same field.
    expect(editor.actionResult).toBe('ran');
    expect(editor.actionCtxIsEditorCtx).toBe(true);
  });

  test('focus lands on the editing surface rather than the application host', async ({ page }) => {
    await ready(page);
    const button = page.getByTestId('focus-editor');
    await button.focus();
    await button.press('Enter');

    const focus = await json<{
      tag: string | null;
      isProseMirror: boolean;
      isHost: boolean;
      insideMainEditor: boolean;
    }>(page, 'focus-json');

    expect(focus.insideMainEditor).toBe(true);
    // The distinction that matters: `focus()` delegates to `view.focus()`, which
    // focuses the contenteditable. Landing on the wrapping `role="application"`
    // div instead would still satisfy `insideMainEditor`, and would put a screen
    // reader into application mode over a node that accepts no text.
    expect(focus.isProseMirror).toBe(true);
    expect(focus.isHost).toBe(false);

    // Announced, because this is the one control on the page that moves focus on
    // purpose and a keyboard user who pressed it has no other way to know.
    await expect(page.getByTestId('announcement')).toHaveText(
      /focus: focus moved into the editing surface/,
    );
  });

  test('getMarkdown and setMarkdown round-trip the document, and the binding catches up', async ({
    page,
  }) => {
    await ready(page);
    await page.getByTestId('read-markdown').click();
    // `.trim()` rather than an exact byte match: the serializer owns trailing
    // whitespace, and pinning its newline policy here would make this test fail
    // for a reason that has nothing to do with either method.
    const initialMarkdown = await json<string>(page, 'markdown-json');
    expect(initialMarkdown.trim()).toBe(INITIAL);

    await page.getByTestId('set-markdown').click();
    const replacementMarkdown = await json<string>(page, 'markdown-json');
    expect(replacementMarkdown.trim()).toBe(REPLACEMENT);
    await expect(page.locator(`#${MAIN_ID} .ProseMirror h1`)).toHaveText('Replaced Plan');

    // The bound `value` is a SEPARATE question from what the editor holds, and it
    // arrives late by design: an imperative `setMarkdown` writes straight into
    // ProseMirror, and `value` only moves once the change comes back out through
    // Milkdown's own 200ms listener debounce and then the editor package's 300ms
    // `onchange` debounce. Polling measures that chain; a fixed wait would be a
    // guess at the sum of two debounces this test does not own.
    await expect
      .poll(async () => {
        const value = await json<string>(page, 'value-json');
        return value.trim();
      })
      .toBe(REPLACEMENT);
  });

  test('setMarkdown falls back to the bound value when no editor is mounted', async ({ page }) => {
    await ready(page);
    // Source mode is the deterministic way to reach `setMarkdown`'s OTHER branch.
    // Switching to source tears the Milkdown instance down and sets the
    // component's `editorState` to null, so `setMarkdown` takes the
    // `value = content` path — synchronously, with none of the debounce chain the
    // wysiwyg branch goes through.
    await page.getByTestId('mode-source').click();
    const textarea = page.locator(`textarea#${MAIN_ID}`);
    await expect(textarea).toBeVisible();

    await page.getByTestId('set-markdown').click();
    // Exact, not trimmed: this branch assigns the string it was given, so any
    // difference at all would be the component reformatting behind a consumer's
    // back.
    await expect(textarea).toHaveValue(REPLACEMENT);
    expect(await json<string>(page, 'value-json')).toBe(REPLACEMENT);
    // And `getMarkdown()` answers from the same fallback — it is
    // `editorState?.getMarkdown() ?? value`, so it keeps working with no editor
    // mounted at all.
    expect(await json<string>(page, 'markdown-json')).toBe(REPLACEMENT);
  });

  test('getAst parses the live document, not the value it was mounted with', async ({ page }) => {
    await ready(page);
    await readAstWhenReady(page);
    const initial = await json<AstReadout>(page, 'ast-json');
    expect(initial.type).toBe('root');
    expect(initial.children).toEqual([
      { type: 'heading', depth: 3, text: HEADING },
      { type: 'paragraph', depth: null, text: PARAGRAPH_ONE },
      { type: 'paragraph', depth: null, text: PARAGRAPH_TWO },
      { type: 'paragraph', depth: null, text: PARAGRAPH_THREE },
    ]);

    // The half that makes this more than "an AST came back": replace the document
    // and the AST must follow. `getAst()` is `parseOrThrow(getMarkdown())`, so an
    // implementation that parsed the mounted `value` instead would still return a
    // perfectly valid root here — with the wrong contents, and with its heading
    // at the wrong depth.
    await page.getByTestId('set-markdown').click();
    await readAstWhenReady(page);
    const replaced = await json<AstReadout>(page, 'ast-json');
    expect(replaced.children).toEqual([
      { type: 'heading', depth: 1, text: 'Replaced Plan' },
      { type: 'paragraph', depth: null, text: 'Only one paragraph now.' },
    ]);
  });
});
