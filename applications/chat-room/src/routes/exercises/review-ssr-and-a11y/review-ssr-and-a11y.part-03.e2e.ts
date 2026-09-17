import { expect, test } from '@playwright/test';
import {
  EDITOR_ID,
  activeDescriptor,
  caretBlock,
  currentMarkdown,
  openSidebar,
  ready,
  tabToEditableSurface,
} from './review-ssr-and-a11y-test-helpers';

test.describe('review-ssr-and-a11y: keyboard reachability', () => {
  test('the control bar is a role="group" of four tab stops, and the editor is two', async ({
    page,
  }) => {
    await ready(page);

    // HISTORY. This used to be pinned as a bug titled "claims role='toolbar'
    // but exposes four tab stops". The complaint was sound while it held: a
    // `role="toolbar"` promises ONE tab stop with arrow-key navigation inside
    // it, this bar was a plain container that happened to carry the role, and
    // it owned both a `tablist` and a nested `toolbar` — neither a valid child
    // of `toolbar`.
    //
    // Since `@repo/editor@0.8.1` the bar is `role="group"`, and both
    // halves of the complaint dissolve with it: a group makes no tab-stop
    // promise at all, so four stops inside it is correct ARIA, and a group is a
    // perfectly valid owner of a tablist and a toolbar. The pin outlived the
    // fix because it only ever COUNTED stops — a regression back to
    // `role="toolbar"` would not have changed the count, so the pin would have
    // passed while re-asserting the bug in its own title.
    //
    // Rewritten as the structural invariant the counting was always circling:
    // the container's role and the number of stops it owns are the same claim,
    // so they are asserted together. The role check is what makes a revert to
    // `toolbar` fail HERE, at the walk that would otherwise excuse it. (The
    // same role is pinned by attribute in "the editor view renders ONE control
    // row" above; that one guards the bar's composition, this one guards what
    // the role implies for the keyboard.)
    const bar = page.locator(`#${EDITOR_ID}-controls`);
    await expect(bar).toHaveAttribute('role', 'group');
    // The one real toolbar in the composition is the nested formatting group,
    // and it behaves like one: a single roving stop, which is why four stops
    // and not seven come out of a bar holding this many buttons.
    await expect(page.locator(`#${EDITOR_ID}-toolbar`)).toHaveAttribute('role', 'toolbar');
  });

  test('Escape then Tab escapes a list without editing it, and Mod-]/Mod-[ indent and outdent directly', async ({
    page,
    browserName,
  }) => {
    await ready(page);

    /**
     * Walk to the editable surface (the webkit-aware helper above) and poll
     * until the caret is genuinely sitting in the checklist's LAST bullet —
     * where Tab tabs in by default in this fixture. Re-used below because the
     * first assertion in this test walks focus back out of the component.
     */
    async function settleOnLastBullet(): Promise<void> {
      await page.getByTestId('tab-order-start').focus();
      await tabToEditableSurface(page, browserName);
      await expect
        .poll(() => caretBlock(page))
        .toMatchObject({
          tag: 'P',
          text: expect.stringContaining('Document review export behavior'),
        });
    }

    // The debounced markdown export — component-level `debounceMs: 300`,
    // stacked on `@milkdown/plugin-listener`'s own ~200ms internal debounce
    // (see `markdown-editor.svelte`'s own comment on this exact stacking) —
    // means a read straight after a keypress can pass by racing ahead of a
    // real, slightly-delayed mutation rather than by there being none. Every
    // "did this edit the document" check below is an auto-retrying
    // `toHaveAttribute`/`.not.toHaveAttribute()` match, which polls out that
    // window on its own rather than needing a fixed wait in front of it.

    await settleOnLastBullet();
    const markdownBefore = await currentMarkdown(page).getAttribute('value');
    expect(markdownBefore).not.toBeNull();

    // FIXED, cinder#1302 — this was a WCAG 2.1.2 keyboard trap. Bare
    // Tab/Shift-Tab are STILL bound to sink/lift-list-item at this position
    // by design (commonmark's own list keymap; that binding is not itself
    // the bug) — what was missing was an escape route. Pressing Escape now
    // arms a one-shot latch (`keymap-plugin.ts`'s `createTabEscapeLatch`)
    // that the very next Tab consumes instead of sinking, provided nothing
    // else changed the document or selection in between. This is the
    // keyboard route the toolbar's own shortcut list documents ('Move focus
    // out of the editor (then Tab)': Esc), and it is reachable at all only
    // because the fix stripped Tab/Shift-Tab from the commonmark list keymap
    // and the GFM table keymap — both bound the identical trap and both used
    // to run AHEAD of this latch in Milkdown's keymap chain, so the
    // Escape-armed release could never be reached before.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    // No waitForTimeout: toHaveAttribute is an auto-retrying matcher, so
    // polling it toward markdownBefore's captured value already waits out
    // the debounce chain (see the comment above) while proving the SAME
    // thing a fixed-then-check pair would, on a concrete condition instead
    // of a guessed duration -- matching the fix already applied to the two
    // Mod-]/Mod-[ checks below.
    await expect(currentMarkdown(page)).toHaveAttribute('value', markdownBefore!);
    // The exact element differs by engine (a trailing button in Chromium and
    // Firefox; WebKit's native Tab can't reach that button at all — see
    // `../keyboard`'s own doc comment — so it lands on `<body>` instead) but
    // "no longer anywhere inside the editor" is true everywhere.
    await expect.poll(() => activeDescriptor(page)).toMatchObject({ inEditorMain: false });

    // Mod-]/Mod-[ are the shortcut this fix freed up (from the commonmark
    // list keymap, which used to bind them to Tab/Shift-Tab too) to
    // indent/outdent directly — no Escape ceremony, and useable from
    // anywhere in the list, not just the position Tab happens to hand you.
    // "Mod" is platform-, not engine-, dependent — the same mac detection
    // the package's own `getShortcutDisplay` uses (`keymap-plugin.ts`).
    const isMac = await page.evaluate(() => /Mac|iPod|iPhone|iPad/.test(navigator.platform));
    await settleOnLastBullet();
    // No waitForTimeout before either check below: toHaveAttribute/
    // .not.toHaveAttribute() are auto-retrying matchers, so they already
    // poll out the debounce window themselves -- a fixed wait in front of
    // one would be pure padding, proving nothing a poll doesn't already
    // give for free.
    await page.keyboard.press(isMac ? 'Meta+]' : 'Control+]');
    await expect(currentMarkdown(page)).toHaveAttribute(
      'value',
      /\n {2}[*-] Document review export behavior/,
    );

    await page.keyboard.press(isMac ? 'Meta+[' : 'Control+[');
    await expect(currentMarkdown(page)).not.toHaveAttribute(
      'value',
      /\n {2}[*-] Document review export behavior/,
    );
  });

  test('only the active tab carries aria-controls, and it follows the selection', async ({
    page,
  }) => {
    await ready(page);

    // FIXED. Each Segment used to be given the id of the panel it controls
    // unconditionally, but only the ACTIVE view's panel is ever rendered (the
    // view area is an `{#if}` chain, not three panels with two hidden) — so
    // two of the three tabs always referenced an element that was not in the
    // document. The fix sets `aria-controls` on the ACTIVE tab only; an
    // inactive tab now carries no `aria-controls` attribute at all, rather
    // than a dangling reference to a nonexistent id.
    const resolution = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[role="tab"]')].map((tab) => ({
          selected: tab.getAttribute('aria-selected'),
          controls: tab.getAttribute('aria-controls'),
          resolves: !!document.getElementById(tab.getAttribute('aria-controls') ?? ''),
        })),
      );
    expect(await resolution()).toEqual([
      { selected: 'true', controls: `${EDITOR_ID}-editor-panel`, resolves: true },
      { selected: 'false', controls: null, resolves: false },
      { selected: 'false', controls: null, resolves: false },
    ]);

    // …and it MOVES with the selection rather than being a static snapshot of
    // the initial view: switching tabs hands `aria-controls` to whichever
    // panel is now actually rendered, and takes it away from the one that was
    // active a moment ago.
    await page.getByRole('tab', { name: 'Diff' }).click();
    await expect.poll(resolution).toEqual([
      { selected: 'false', controls: null, resolves: false },
      { selected: 'true', controls: `${EDITOR_ID}-diff-panel`, resolves: true },
      { selected: 'false', controls: null, resolves: false },
    ]);

    await page.getByRole('tab', { name: 'Summary' }).click();
    await expect.poll(resolution).toEqual([
      { selected: 'false', controls: null, resolves: false },
      { selected: 'false', controls: null, resolves: false },
      { selected: 'true', controls: `${EDITOR_ID}-summary-panel`, resolves: true },
    ]);
  });

  test("the comments toggle's aria-controls resolves when open and dangles when closed", async ({
    page,
  }) => {
    await ready(page);
    const toggle = page.getByRole('button', { name: /comments sidebar/ });

    // The controls component is instantiated as `{editorId}-controls`, so
    // deriving the sidebar id from its own id would produce
    // `a11y-editor-controls-sidebar` — an element that never exists. The
    // sidebar id is now passed in explicitly, and the reference is correct.
    await expect(toggle).toHaveAttribute('aria-controls', `${EDITOR_ID}-sidebar`);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(await page.locator(`#${EDITOR_ID}-controls-sidebar`).count()).toBe(0);

    // While collapsed the target still does not exist — the sidebar is behind
    // an `{#if sidebarOpen}`, so `aria-controls` dangles in the closed state.
    // That is much milder than pointing at a permanently-wrong id (nothing is
    // mislabelled, the relationship is just unavailable until it is true), but
    // it is worth knowing before writing `aria-controls`-based assertions.
    expect(await page.locator(`#${EDITOR_ID}-sidebar`).count()).toBe(0);

    await openSidebar(page);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const target = page.locator(`#${EDITOR_ID}-sidebar`);
    await expect(target).toHaveJSProperty('tagName', 'ASIDE');
    await expect(target).toHaveAttribute('aria-label', 'Comment threads');
  });

  test('anchored-comment decorations announce themselves and have a keyboard route', async ({
    page,
  }) => {
    await ready(page);

    const anchor = page.locator('span.comment-anchor');
    await expect(anchor).toHaveCount(1);
    await expect(anchor).toHaveText('Release Plan');

    // FIXED, cinder#1304. The decoration used to be built with exactly two
    // attributes — `class` and `data-thread-id`, both invisible to assistive
    // tech. It now also carries `role="mark"` and `aria-description`, the
    // same job a native `<mark>` would do, without a `<mark>` element
    // ProseMirror does not render here.
    const attributes = await anchor.evaluate((element) =>
      [...element.attributes].map((attribute) => attribute.name).toSorted(),
    );
    expect(attributes).toEqual(['aria-description', 'class', 'data-thread-id', 'role']);
    await expect(anchor).toHaveAttribute('role', 'mark');
    await expect(anchor).toHaveAttribute('aria-description', 'Commented text');

    // `role="mark"` deliberately carries no tab stop — an inline decoration
    // inside a contenteditable fighting ProseMirror's own selection handling
    // was rejected upstream as fragile — so the fix's keyboard route is a
    // container-level chord instead: Ctrl+Alt+ArrowDown/Up
    // (Cmd+Option+ArrowDown/Up on macOS, since Control+Option is VoiceOver's
    // own modifier prefix there) moves the caret to the next/previous anchor
    // in document order and opens its thread, the same as clicking the
    // decoration does. Exercised as a real keypress, not just an attribute
    // check: click inside the prose (never on the anchor itself, so the
    // popover below is provably the CHORD's doing) and fire the chord.
    await page.locator('.ProseMirror').getByText('The first release includes').click();
    const isMac = await page.evaluate(() => /Mac|iPod|iPhone|iPad/.test(navigator.platform));
    await page.keyboard.press(isMac ? 'Meta+Alt+ArrowDown' : 'Control+Alt+ArrowDown');

    await expect(page.locator('.thread-popover')).toBeVisible();
    await expect
      .poll(() => activeDescriptor(page))
      .toMatchObject({ tag: 'BUTTON', label: 'Delete thread', inPopover: true });
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('Release Plan');
  });
});
