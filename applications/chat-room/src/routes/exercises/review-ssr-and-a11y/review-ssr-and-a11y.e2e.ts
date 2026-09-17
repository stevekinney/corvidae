import { expect, test } from '@playwright/test';
import { EDITOR_ID, ROUTE, SENTINEL, liveRegion } from './review-ssr-and-a11y-test-helpers';

test.describe('review-ssr-and-a11y: what the server sends', () => {
  test('the server renders the whole shell and none of the editor', async ({ request }) => {
    // Read the raw bytes rather than a rendered page: this is the only way to
    // see the markup a client gets BEFORE any client module has run, which is
    // what a crawler, a no-JS reader, and the first paint all see.
    const response = await request.get(ROUTE);
    expect(response.ok()).toBe(true);
    const html = await response.text();

    // The container, its state attributes, and the tabpanel for the active
    // view are all server-rendered.
    expect(html).toContain('data-testid="review-editor"');
    expect(html).toContain('data-mode="edit"');
    expect(html).toContain('data-view="editor"');
    expect(html).toContain(`id="${EDITOR_ID}-controls"`);
    expect(html).toContain(`id="${EDITOR_ID}-editor-panel"`);
    expect(html).toContain(`id="${EDITOR_ID}-export"`);

    // …but the editor itself is not. MarkdownEditor's ProseMirror host sits
    // behind an `{#if browser}` guard; the server emits a skeleton in its
    // place. Matched on the class attribute specifically so an unrelated
    // asset name containing the word could not satisfy it.
    expect(html).not.toMatch(/class="[^"]*\bProseMirror\b/);
    expect(html).toContain('class="editor-skeleton');
    expect(html).toContain('aria-label="Loading editor"');

    // `data-ready` is the mount gate and is rendered as `undefined` — i.e.
    // omitted entirely — until the inner editor reports itself ready.
    expect(html).not.toContain('data-ready');

    // Neither the comment sidebar nor a thread popover is ever server
    // rendered: both are behind `{#if}` blocks whose state starts closed.
    expect(html).not.toContain('comment-sidebar');
    expect(html).not.toContain('thread-popover');
  });

  test('the view tablist ships keyboard-unreachable', async ({ request }) => {
    // Every tab is `tabindex="-1"` in the server markup. SegmentedControl
    // registers its Segments through a client-only attachment, so before
    // hydration no segment has been elected to hold the roving tab stop and
    // the whole tablist is skipped by Tab. Not a bug so much as the honest
    // consequence of a JS-driven roving-tabindex implementation — but it does
    // mean the control bar is inert for keyboard users until hydration lands.
    const response = await request.get(ROUTE);
    const html = await response.text();
    const tabs = html.match(/<[a-z]+[^>]*\brole="tab"[^>]*>/g) ?? [];
    expect(tabs).toHaveLength(3);
    for (const tab of tabs) {
      expect(tab).toContain('tabindex="-1"');
    }
  });

  test('all five hidden form inputs are fully populated server-side', async ({ request }) => {
    // The counterpart to everything above: the *form* participation story is
    // complete without JavaScript. A plain POST from the server-rendered page
    // carries the whole review — baseline, current text, comments, diff, and
    // summary — even though no editor ever mounted.
    const response = await request.get(ROUTE);
    const html = await response.text();
    for (const field of ['original', 'current', 'comments', 'diff', 'summary']) {
      expect(html).toContain(`name="review-${field}"`);
    }
    // The comment body reaches the server-rendered form, HTML-escaped, in the
    // comments payload — proof these are populated rather than empty
    // placeholders waiting on hydration.
    expect(html).toContain(SENTINEL);
  });
});

test.describe('review-ssr-and-a11y: with JavaScript disabled', () => {
  test('the document text and every review thread are absent from the visible DOM', async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    // `gotoHydrated` cannot be used here: the hydration beacon it waits for is
    // set by client JS that will never run.
    await page.goto(ROUTE);

    await expect(page.locator('.ProseMirror')).toHaveCount(0);
    await expect(page.locator('aside.comment-sidebar')).toHaveCount(0);
    await expect(page.getByRole('tab')).toHaveCount(3);

    // The whole review is in the DOM as form data and NONE of it as text: a
    // no-JS reader sees a loading placeholder where the document should be.
    const visibleText = await page.locator('body').innerText();
    expect(visibleText).not.toContain(SENTINEL);
    expect(visibleText).not.toContain('Finalize the component API');

    const hiddenInputs = page.locator('[data-testid="review-editor"] input[type="hidden"]');
    await expect(hiddenInputs).toHaveCount(5);
    await expect(page.locator('input[type="hidden"][name="review-comments"]')).toHaveAttribute(
      'value',
      new RegExp(SENTINEL),
    );

    await context.close();
  });

  test('the loading placeholder is screen-reader-only, permanently', async ({ browser }) => {
    // HISTORY. This used to be a pinned bug. EditorSkeleton labelled its
    // `role="status"` region with `<span class="sr-only">Loading editor...</span>`,
    // and a bare `.sr-only` is defined NOWHERE in reach: Cinder's base
    // stylesheet ships `.cinder-sr-only`, and EditorSkeleton's own scoped
    // styles declared no `.sr-only` rule either. A class no stylesheet defines
    // hides nothing, so the span laid out in normal flow as a full-width line
    // of visible body copy — for every user during load, and PERMANENTLY for a
    // no-JS reader, since the skeleton is what SSR emits and nothing ever
    // replaces it. The old test pinned that by asserting `position: static`
    // and a box bigger than 1px.
    //
    // The skeleton now uses `cinder-sr-only`, the same utility
    // `review-editor/live-region.svelte` already used (see the live-region
    // tests below) — so the surface no longer has any instance of this defect.
    // Upstream carries its own unit guard for it in
    // `@repo/editor` → `markdown-editor/editor-skeleton.sr-only.test.ts`,
    // which checks the class is one some stylesheet actually declares rather
    // than that it is spelled a particular way.
    //
    // Asserted here as GEOMETRY, not as a class name, for two reasons. It is
    // what a user actually experiences, and it survives a refactor of how the
    // hiding is implemented (a `clip-path` recipe, a `<VisuallyHidden>`
    // wrapper) while still failing loudly on a regression to a class that
    // resolves to nothing — that one reverts to `position: static` and a
    // full-width box.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(ROUTE);

    const loadingLine = page.locator('[role="status"][aria-label="Loading editor"] span');
    await expect(loadingLine).toHaveText('Loading editor...');

    const geometry = await loadingLine.evaluate((element) => {
      const styles = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        position: styles.position,
        overflow: styles.overflow,
        display: styles.display,
        visibility: styles.visibility,
        ariaHidden: element.getAttribute('aria-hidden'),
        width: rect.width,
        height: rect.height,
      };
    });
    // Visually hidden: lifted out of flow and clipped to a 1x1 box, so it
    // occupies no line of its own and shoves nothing down the page.
    expect(geometry.position).toBe('absolute');
    expect(geometry.overflow).toBe('hidden');
    expect(Math.round(geometry.width)).toBe(1);
    expect(Math.round(geometry.height)).toBe(1);
    // …but still ANNOUNCED. The half of the contract a naive "hide it" fix
    // breaks: `display: none`, `visibility: hidden`, or `aria-hidden` would all
    // satisfy the geometry above and take the only loading signal a no-JS
    // reader gets away from assistive tech entirely.
    expect(geometry.display).not.toBe('none');
    expect(geometry.visibility).toBe('visible');
    expect(geometry.ariaHidden).toBeNull();

    // The two hidden regions in this document now agree. ReviewEditor's own
    // announcer was the reference implementation the skeleton was measured
    // against while the bug stood; asserting they match keeps that comparison
    // meaningful rather than deleting it along with the pin.
    const announcer = await liveRegion(page).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        position: getComputedStyle(element).position,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    });
    expect(announcer).toEqual({
      position: geometry.position,
      width: Math.round(geometry.width),
      height: Math.round(geometry.height),
    });

    await context.close();
  });
});
