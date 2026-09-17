import { expect, test } from '@playwright/test';
import type { Page } from './review-modes-test-helpers';
import {
  INSTANCES,
  bodyParagraph,
  clearSelection,
  currentSelection,
  frame,
  openReviewModes,
  openThreadPopover,
  popoverEverAppeared,
  selectText,
  stopWatchingPopovers,
  surface,
  watchForPopover,
} from './review-modes-test-helpers';

test.describe('review-modes: mode is reflected everywhere and enforced in one place', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await openReviewModes(page, INSTANCES);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('`data-mode` echoes the passed string verbatim, including a value outside the union', async () => {
    // `data-mode={mode}` is an unfiltered reflection of the prop. The exotic
    // instance passes `'suggest'`, which the ReviewMode union does not
    // contain and the component never validates — so it reaches the
    // attribute unchanged.
    const expected: Record<(typeof INSTANCES)[number], string> = {
      'modes-edit': 'edit',
      'modes-readonly': 'readonly',
      'modes-nouser': 'edit',
      'modes-emptyuser': 'edit',
      'modes-snapshot': 'edit',
      'modes-plain': 'edit',
      'modes-exotic': 'suggest',
    };
    for (const name of INSTANCES) {
      await expect(surface(frame(page, name))).toHaveAttribute('data-mode', expected[name]);
    }
  });

  test('only the exact string `readonly` reaches the DOM as a disabled editor', async () => {
    // Enforcement reads `mode === 'readonly'`, never `data-mode`. The exotic
    // instance shows the two are independent: it reflects a non-union mode
    // and is still fully editable.
    await expect(page.locator('#modes-readonly .ProseMirror')).toHaveAttribute(
      'contenteditable',
      'false',
    );
    await expect(page.locator('#modes-readonly')).toHaveAttribute('data-readonly', 'true');

    for (const editorId of ['modes-edit', 'modes-exotic']) {
      await expect(page.locator(`#${editorId} .ProseMirror`)).toHaveAttribute(
        'contenteditable',
        'true',
      );
      // `data-readonly={readonly || undefined}` — the attribute is ABSENT
      // when editable, never `"false"`.
      await expect(page.locator(`#${editorId}`)).not.toHaveAttribute('data-readonly');
    }
  });

  test('readonly withholds the formatting toolbar while the unified control bar survives', async () => {
    const editSurface = surface(frame(page, 'modes-edit'));
    const readonlySurface = surface(frame(page, 'modes-readonly'));

    // One bar, in both modes, named "Review editor controls". It is
    // `role="group"` rather than `role="toolbar"`, because it contains a
    // `tablist` and hosts the editor's own `toolbar` — neither of which is
    // a valid child of a `toolbar`.
    for (const scope of [editSurface, readonlySurface]) {
      await expect(scope.getByRole('group', { name: 'Review editor controls' })).toHaveCount(1);
    }

    const formatting = editSurface.getByRole('toolbar', { name: 'Formatting toolbar' });
    await expect(formatting).toHaveCount(1);
    await expect(formatting).toHaveAttribute('id', 'modes-edit-toolbar');
    // The formatting controls live INSIDE the unified bar, in
    // `.controls-formatting`, rather than in a second stacked row: the
    // editor view has no `.editor-toolbar-wrapper` at all.
    await expect(editSurface.locator('#modes-edit-controls .controls-formatting')).toHaveCount(1);
    await expect(editSurface.locator('.editor-toolbar-wrapper')).toHaveCount(0);

    // `formatting={activeView === 'editor' && !isReadonly ? … : undefined}`:
    // readonly removes the snippet outright, it does not merely disable it.
    await expect(readonlySurface.getByRole('toolbar', { name: 'Formatting toolbar' })).toHaveCount(
      0,
    );
    await expect(readonlySurface.locator('.controls-formatting')).toHaveCount(0);
  });

  test('a missing selection quote reports the requested text and editor', async () => {
    await expect(selectText(page, 'modes-edit', 'absent selection quote')).rejects.toThrow(
      '"absent selection quote" not found in #modes-edit',
    );
  });

  test('readonly makes the selection popover structurally impossible', async () => {
    // The popover is portaled to `document.body`, so it is addressed by id
    // and never as a descendant of a container.
    const readonlyPopover = page.locator('#modes-readonly-selection-popover');
    const exoticPopover = page.locator('#modes-exotic-selection-popover');
    const editPopover = page.locator('#modes-edit-selection-popover');

    // Recording starts before the first gesture, so what is asserted at the end
    // is "never appeared", not "not present right now".
    await watchForPopover(page, 'modes-edit-selection-popover');
    await watchForPopover(page, 'modes-readonly-selection-popover');
    await watchForPopover(page, 'modes-exotic-selection-popover');

    // Readonly text is still selectable — the block lives in the component's
    // handler (`if (mode !== 'edit') { … return; }`), not in the browser.
    //
    // `currentSelection` immediately after, rather than after a delay: it is a
    // SEPARATE page evaluate in a later task, so a component (or a ProseMirror
    // observer) that stomped the selection synchronously or on a microtask
    // would show up here. What the old 400ms added on top of that was a longer
    // window for a stomp that never had a mechanism; the absence claim it was
    // really protecting is timed by the control below instead.
    expect(await selectText(page, 'modes-readonly', 'dashboard')).toBe('dashboard');
    expect(await currentSelection(page)).toBe('dashboard');

    // `showSelectionPopover` requires `mode === 'edit'` exactly, so the
    // out-of-union mode is gated out from the other side: an editable
    // document with no way to comment on it.
    await clearSelection(page);
    expect(await selectText(page, 'modes-exotic', 'dashboard')).toBe('dashboard');
    expect(await currentSelection(page)).toBe('dashboard');

    // The control does two jobs, and the second is the reason it moved up here
    // from the bottom of the test. It shows the identical gesture producing a
    // popover in an ungated instance — and, because the assertion below it is
    // auto-retrying and does not resolve until the component has carried a
    // `selectionchange` all the way through its 20ms debounce, it is also the
    // CLOCK for the two absences that follow. See the note above `test.describe`
    // for why a poll is unavailable and a control is the honest substitute.
    await clearSelection(page);
    expect(await selectText(page, 'modes-edit', 'dashboard')).toBe('dashboard');
    await expect(editPopover).toHaveCount(1);

    // Now the absences mean something. Both gated instances took the identical
    // gesture — readonly two `selectText` calls back, exotic one, so ≥200ms and
    // ≥100ms of in-page time respectively, against a 20ms debounce — and an
    // ungated instance has since carried the same gesture all the way to a
    // mounted popover. The recorded reads are the load-bearing pair: they cover
    // every instant since before the first gesture. The live counts are kept
    // underneath them because they also fail if a popover is present *now*,
    // which a record of past insertions would not report.
    // The first registered observer must still update the shared record after
    // the other observers were installed; otherwise absence checks are vacuous.
    expect(await popoverEverAppeared(page, 'modes-edit-selection-popover')).toBe(true);
    expect(await popoverEverAppeared(page, 'modes-readonly-selection-popover')).toBe(false);
    expect(await popoverEverAppeared(page, 'modes-exotic-selection-popover')).toBe(false);
    await expect(readonlyPopover).toHaveCount(0);
    await expect(exoticPopover).toHaveCount(0);

    await expect(editPopover).toHaveAttribute('role', 'toolbar');
    await expect(editPopover).toHaveAttribute('aria-label', 'Selection actions');
    await expect(editPopover.getByLabel('Add comment')).toHaveCount(1);

    // Collapsing the selection tears it back down, which also leaves the
    // page clean for the next test.
    await clearSelection(page);
    await expect(editPopover).toHaveCount(0);
    await stopWatchingPopovers(page);
  });

  test('readonly strips the sidebar of every mutating affordance but keeps the thread list', async () => {
    for (const name of ['modes-edit', 'modes-readonly']) {
      // Singular/plural is computed from the visible comment count, so the
      // accessible name is "(1 comment)" and never "(1 comments)".
      await surface(frame(page, name))
        .getByRole('button', { name: 'Open comments sidebar (1 comment)' })
        .click();
      const sidebar = page.locator(`#${name}-sidebar`);
      await expect(sidebar).toHaveCount(1);
      await expect(sidebar).toHaveAttribute('aria-label', 'Comment threads');
      await expect(sidebar.locator('.thread-item')).toHaveCount(1);
    }

    const editSidebar = page.locator('#modes-edit-sidebar');
    await expect(editSidebar.getByRole('button', { name: 'Add document comment' })).toHaveCount(1);
    await expect(editSidebar.getByRole('button', { name: 'Comment actions' })).toHaveCount(1);

    const readonlySidebar = page.locator('#modes-readonly-sidebar');
    await expect(readonlySidebar.getByRole('button', { name: 'Add document comment' })).toHaveCount(
      0,
    );
    await expect(readonlySidebar.getByRole('button', { name: 'Comment actions' })).toHaveCount(0);

    // Close both: an open sidebar narrows the editor column, and the later
    // click-and-type test picks its click target by layout.
    for (const name of ['modes-edit', 'modes-readonly']) {
      await surface(frame(page, name))
        .getByRole('button', { name: 'Close comments sidebar (1 comment)' })
        .click();
      await expect(page.locator(`#${name}-sidebar`)).toHaveCount(0);
    }
  });

  test('readonly strips the thread popover down to Close, with no reply composer', async () => {
    const editPopover = page.locator('#modes-edit-thread-popover');
    await openThreadPopover(page, 'modes-edit');
    await expect(editPopover).toHaveAttribute('role', 'dialog');
    // FIXED (cinder#1305): `aria-modal="true"` used to be asserted here, but
    // it was a false claim the popover never backed up — nothing outside it
    // was made `inert`, and F6 landmark navigation deliberately moves focus
    // out to `.review-editor-main` while the popover stays open, which is
    // the popover's intended non-modal workflow (an anchored comment
    // popover, not a blocking dialog). The attribute is now genuinely
    // absent rather than present-but-dishonest. Modality semantics belong
    // to review-ssr-and-a11y; this is just the control this test's
    // readonly-vs-edit comparison already needed matching the new baseline.
    await expect(editPopover).not.toHaveAttribute('aria-modal');
    await expect(editPopover.getByRole('button', { name: 'Delete thread' })).toBeEnabled();
    await expect(editPopover.getByRole('button', { name: 'Edit comment' })).toHaveCount(1);
    await expect(editPopover.getByRole('button', { name: 'Delete comment' })).toHaveCount(1);
    // The reply composer's textarea is `{popoverId}-composer`.
    await expect(page.locator('#modes-edit-thread-popover-composer')).toHaveCount(1);
    await editPopover.getByRole('button', { name: 'Close' }).click();
    await expect(editPopover).toHaveCount(0);

    const readonlyPopover = page.locator('#modes-readonly-thread-popover');
    await openThreadPopover(page, 'modes-readonly');
    // The seeded comment's author is `steve`, which is also this instance's
    // `currentUserId` — so these four are withheld by readonly and by
    // nothing else. Same seed, same identity, different mode.
    await expect(readonlyPopover.getByRole('button', { name: 'Delete thread' })).toHaveCount(0);
    await expect(readonlyPopover.getByRole('button', { name: 'Edit comment' })).toHaveCount(0);
    await expect(readonlyPopover.getByRole('button', { name: 'Delete comment' })).toHaveCount(0);
    await expect(page.locator('#modes-readonly-thread-popover-composer')).toHaveCount(0);
    // Reading is untouched: the quote and the comment body still render.
    await expect(readonlyPopover.getByText('Title reads well — keep it.')).toBeVisible();
    await readonlyPopover.getByRole('button', { name: 'Close' }).click();
    await expect(readonlyPopover).toHaveCount(0);
  });

  test('typing into a readonly editor leaves `value` byte-identical; the same gesture edits an edit instance', async () => {
    const readonlyValue = page.getByTestId('modes-readonly-value-json');
    const readonlyBefore = ((await readonlyValue.textContent()) ?? '').trim();
    expect(readonlyBefore).toContain('# Release Plan');

    // Clicking a `contenteditable="false"` ProseMirror does not focus it;
    // focus lands on the markdown-editor host, which carries `tabindex="0"`
    // for exactly this reason. Asserting that first is what makes the
    // no-op assertion below mean something: the keystrokes were delivered
    // INSIDE the editor, they just had nowhere to go.
    await page.locator('#modes-readonly .ProseMirror').click();
    await expect(page.locator('#modes-readonly')).toBeFocused();
    await page.keyboard.type('INJECTED');

    // The control does double duty. It shows the same gesture working under
    // `mode="edit"` — and, because it is asserted first, it proves a full
    // keystroke → onchange → DOM cycle has elapsed since the readonly
    // keystrokes above. That is what licenses the negative assertions after
    // it without an arbitrary sleep.
    const editValue = page.getByTestId('modes-edit-value-json');
    const editBefore = ((await editValue.textContent()) ?? '').trim();
    await bodyParagraph(page, 'modes-edit').click();
    await expect(page.locator('#modes-edit .ProseMirror')).toBeFocused();
    await page.keyboard.type('INJECTED');

    await expect(page.locator('#modes-edit .ProseMirror')).toContainText('INJECTED');
    await expect
      .poll(async () => ((await editValue.textContent()) ?? '').trim())
      .not.toBe(editBefore);
    // `onchange` carries the whole new document rather than a delta, which is
    // why the log records a length. How many events a typing burst coalesces
    // into is the editor's business and not pinned here — only that at least
    // one arrived carrying a document length.
    await expect(page.getByTestId('modes-edit-event-log').getByRole('listitem').last()).toHaveText(
      /^change:\d+$/,
    );

    await expect(page.locator('#modes-readonly .ProseMirror')).not.toContainText('INJECTED');
    expect(((await readonlyValue.textContent()) ?? '').trim()).toBe(readonlyBefore);
    await expect(page.getByTestId('modes-readonly-event-count')).toHaveText('events: 0');
  });

  test('readonly keeps view switching, the sidebar, and every export action', async () => {
    const scope = surface(frame(page, 'modes-readonly'));

    await frame(page, 'modes-readonly').getByRole('tab', { name: 'Diff' }).click();
    await expect(scope).toHaveAttribute('data-view', 'diff');
    // Revert All is gated on `activeView === 'diff' && hasContentChanges &&
    // !readonly`. This instance satisfies the first two, so readonly is the
    // only thing withholding it; `review-views` owns the other two thirds.
    await expect(scope.getByLabel('Revert all changes')).toHaveCount(0);

    await frame(page, 'modes-readonly').getByRole('tab', { name: 'Summary' }).click();
    await expect(scope).toHaveAttribute('data-view', 'summary');
    await expect(page.locator('#modes-readonly-summary-panel')).toHaveCount(1);

    await frame(page, 'modes-readonly').getByRole('tab', { name: 'Editor' }).click();
    await expect(scope).toHaveAttribute('data-view', 'editor');
    // The editor comes back readonly — a view round trip does not reset
    // `mode`. (It does lose the anchor decoration, which is a separate
    // upstream problem and not this route's to pin, so nothing here depends
    // on the decoration surviving the trip.)
    await expect(page.locator('#modes-readonly .ProseMirror')).toHaveAttribute(
      'contenteditable',
      'false',
    );

    // Export is a read-only capability, so readonly withholds none of it:
    // the trigger opens `{id}-export-menu` with all five formats.
    await scope.getByRole('button', { name: 'Copy to clipboard' }).click();
    const menu = page.locator('#modes-readonly-export-menu');
    await expect(menu).toHaveAttribute('role', 'menu');
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Content',
      'Summary (for LLM)',
      'Git Diff',
      'Comments',
      'JSON',
    ]);
  });
});
