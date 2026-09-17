import { expect, test } from '@playwright/test';
import {
  doubleClickSelectFirstWord,
  expectEditorSelection,
  keyboardSelectFirstWord,
  pressNextTabStop,
  ready,
  selectCreationParagraph,
} from './review-comment-creation-test-helpers';

test.describe('review-comment-creation: the selection popover', () => {
  test('a mouse drag opens a popover portaled to document.body, after the editor in document order', async ({
    page,
  }) => {
    await ready(page);
    await selectCreationParagraph(page);

    const popover = page.locator('#creation-editor-selection-popover');
    await expect(popover).toHaveAttribute('role', 'toolbar');
    await expect(popover).toHaveAttribute('aria-label', 'Selection actions');

    // `data-cinder-position-ready` is how floating-ui reports that the panel has
    // been measured and placed; `data-cinder-placement` is where it landed. Both
    // are hooks for positioning assertions — asserted as a shape, not a pixel.
    await expect(popover).toHaveAttribute('data-cinder-position-ready', 'true');
    await expect(popover).toHaveAttribute('data-cinder-placement', /^(top|bottom)/);

    // `data-cinder-expanded` is NOT present yet: the component writes it as
    // `expanded ? '' : undefined`, so in the icon state the attribute is absent
    // rather than "false". Only the expanded composer carries it.
    await expect(popover).not.toHaveAttribute('data-cinder-expanded');

    // The portal is the load-bearing part. The popover is a child of <body>, not
    // of the review editor — which is what keeps it out of the editor's overflow
    // and stacking context, and what puts it after the editor in document order.
    // That ordering is the whole reason a single Tab can reach it.
    const structure = await popover.evaluate((element) => ({
      parent: element.parentElement?.tagName,
      followsEditor: Boolean(
        document.querySelector('#creation-editor .ProseMirror')!.compareDocumentPosition(element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    }));
    expect(structure.parent).toBe('BODY');
    expect(structure.followsEditor).toBe(true);
  });

  test('a keyboard selection opens the same popover, and one Tab from the editor lands on its button', async ({
    page,
    browserName,
  }) => {
    await page.clock.install();
    await ready(page);

    await keyboardSelectFirstWord(page);

    // Same popover, same id — the component listens to `selectionchange`, so it
    // does not care whether the selection came from a pointer or a keyboard.
    // (There is a 20ms debounce before the position is computed; the
    // auto-retrying expect absorbs it.)
    const popover = page.locator('#creation-editor-selection-popover');
    await expect(popover).toBeVisible();

    // One tab stop, straight onto the action. Tab is bound in the editor's keymap
    // (sink list item), but that command returns false in a paragraph, so the
    // keypress falls through to the browser's own focus movement — and the next
    // tabbable thing in the document is the portaled popover.
    //
    // `pressNextTabStop` rather than a literal Tab: macOS WebKit leaves buttons
    // out of the plain-Tab cycle, so there the same intent is Option+Tab. The
    // assertion below is unchanged, and it holds in all three engines once the
    // keystroke says what it means on each. See `../keyboard`.
    await pressNextTabStop(page, browserName);
    await expect(popover.getByRole('button', { name: 'Add comment' })).toBeFocused();
  });

  test('Escape closes the popover from its button; from the composer, only the focus handoff is dependable', async ({
    page,
    browserName,
  }) => {
    await page.clock.install();
    await ready(page);

    const popover = page.locator('#creation-editor-selection-popover');
    const editor = page.locator('#creation-editor .ProseMirror');

    // A keyboard-made selection rather than a drag, because every step up to the
    // composer behaves identically on every run that way.
    await keyboardSelectFirstWord(page);
    await expect(popover).toBeVisible();

    // Record the popover leaving the DOM rather than asserting `toHaveCount(0)`
    // afterwards, for the same reason the announcement test records mutations:
    // closing hands the still-live selection back to the editor, and that can
    // re-trigger the very popover that just closed. Under load it came back inside
    // the polling interval and a count assertion never saw the zero. What is being
    // pinned is that Escape removed it, not that it stayed removed.
    await page.evaluate(() => {
      const state = { removed: false };
      Reflect.set(window, '__popover', state);
      new MutationObserver((records) => {
        if (
          records.some((record) =>
            Array.from(record.removedNodes).some(
              (node) =>
                node instanceof Element &&
                (node.id === 'creation-editor-selection-popover' ||
                  node.querySelector('#creation-editor-selection-popover') !== null),
            ),
          )
        ) {
          state.removed = true;
        }
      }).observe(document.body, { childList: true, subtree: true });
    });

    // From the icon state, Escape does exactly the right thing: the popover closes,
    // and the editor gets back both its focus and its selection. Focus sitting on a
    // BUTTON never disturbed the document selection in the first place — which is
    // the detail the composer half of this test turns on.
    //
    // Platform-accurate traversal, same reason as the sibling test above.
    await pressNextTabStop(page, browserName);
    await expect(popover.getByRole('button', { name: 'Add comment' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect
      .poll(() =>
        page.evaluate(() => {
          const popoverState = Reflect.get(window, '__popover');
          return (
            typeof popoverState === 'object' &&
            popoverState !== null &&
            Reflect.get(popoverState, 'removed') === true
          );
        }),
      )
      .toBe(true);
    await expect(editor).toBeFocused();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('The');

    // A new keyboard range can open the composer after the dismissed range.
    await page.keyboard.press('Shift+ArrowRight');
    await expectEditorSelection(page, 1, 5);
    await expect(popover).toBeVisible();
    await popover.getByRole('button', { name: 'Add comment' }).click();
    await expect(popover).toHaveAttribute('data-cinder-expanded', '');
    await expect(popover.getByRole('textbox', { name: 'Comment text' })).toBeFocused();

    // Escape out of the composer. Three things are true every single time: the
    // composer is gone, nothing was emitted, and the editor has the focus back.
    await page.keyboard.press('Escape');
    await expect(editor).toBeFocused();
    await expect(page.getByTestId('event-entry')).toHaveCount(0);
    // The 300ms that used to sit here was guarding against the composer coming
    // BACK after the matchers below had already looked. It cannot: the expanded
    // state has exactly one assignment of `true` in the whole component
    // (`handleSelectionPopoverExpand`, review-editor-impl.svelte:1294), and it is
    // wired to a single place — the selection popover's `onExpand` at :1884, i.e.
    // a user clicking "Add comment". Every one of the twelve other assignments
    // sets it false. No timer, no async path, and nothing this test does after
    // this line can re-expand it, so the auto-retrying matchers are already
    // waiting for the only transition that exists.
    await expect(popover.getByRole('textbox', { name: 'Comment text' })).toHaveCount(0);
    await expect(
      page.locator('#creation-editor-selection-popover[data-cinder-expanded]'),
    ).toHaveCount(0);

    // PINNED KNOWN BUG — and the bug is that there is no fourth thing to assert.
    // Escape is *supposed* to collapse the composer back to the icon state, keeping
    // the popover open over the same range so it can be re-expanded; the component
    // holds on to the captured selection precisely so it can. Whether that actually
    // happens is decided by a race it does not control. Focusing the composer's
    // textarea already collapsed the document selection; restoring focus to the
    // editor gives ProseMirror ~20ms to write its stored selection back into the
    // DOM, and if it does the popover survives, while if it does not the next
    // `selectionchange` clears the popover outright and the selection is simply
    // gone.
    //
    // Both outcomes were measured on this page, and which one you get tracks how
    // busy the machine is: run serially, the popover was gone 20 times out of 20
    // after a keyboard-made selection and 10 out of 12 after a mouse drag; run
    // four-wide in parallel, it survived 4 times out of 4. So "cancel keeps the
    // popover" and "cancel dismisses it" are both unassertable, and the instability
    // is the finding. (On a run where it does survive, a later Escape from its
    // button closes it and drops focus on `<body>` — the popover remembers a focus
    // target once, when it opens, and the cancel has already spent it.)
  });

  test('dismissal survives refocus, while deliberate same-range keyboard and pointer reselection reopens it', async ({
    page,
    browserName,
  }) => {
    await page.clock.install();
    await ready(page);

    const popover = page.locator('#creation-editor-selection-popover');
    const editor = page.locator('#creation-editor .ProseMirror');

    await keyboardSelectFirstWord(page);
    await expect(popover).toBeVisible();
    await pressNextTabStop(page, browserName);
    await page.keyboard.press('Escape');

    // The refocus handoff can emit a collapsed selection first. It must remain
    // dismissed through that transient state instead of reopening over "The".
    await expect(editor).toBeFocused();
    await expect(popover).toHaveCount(0);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('The');

    await page.keyboard.down('Shift');

    // Reproduce the handoff deterministically: a collapsed browser selection
    // arrives first, then ProseMirror restores the original range. Neither
    // synthetic event is user input, so the dismissal must survive both.
    await page.evaluate(() => {
      const text = document.querySelector('#creation-editor .ProseMirror p')?.firstChild;
      if (!(text instanceof Text)) throw new Error('Expected the editor text node');
      const selection = window.getSelection();
      if (!selection) throw new Error('Browser selection unavailable');
      const range = document.createRange();
      range.setStart(text, 0);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    // Run the existing selection debounce and ProseMirror timers before checking.
    await page.clock.runFor(100);
    await expect(popover).toHaveCount(0);
    await page.evaluate(() => {
      const text = document.querySelector('#creation-editor .ProseMirror p')?.firstChild;
      if (!(text instanceof Text)) throw new Error('Expected the editor text node');
      const selection = window.getSelection();
      if (!selection) throw new Error('Browser selection unavailable');
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 3);
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    // Run the existing selection debounce and ProseMirror timers before checking.
    await page.clock.runFor(100);
    await expect(popover).toHaveCount(0);

    await page.keyboard.up('Shift');

    // A keyboard gesture is renewed intent even when it recreates the exact
    // range that was just dismissed.
    await page.keyboard.press('ArrowLeft');
    await page.clock.runFor(100);
    expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);
    for (const selectedText of ['T', 'Th', 'The']) {
      await page.keyboard.press('Shift+ArrowRight');
      await expect
        .poll(() => page.evaluate(() => window.getSelection()?.toString()))
        .toBe(selectedText);
    }
    await expect(popover).toBeVisible();

    await pressNextTabStop(page, browserName);
    await page.keyboard.press('Escape');
    await expect(editor).toBeFocused();
    await expect(popover).toHaveCount(0);

    // The equivalent pointer gesture must also clear the dismissal latch and
    // offer the same range again.
    await doubleClickSelectFirstWord(page);
    await expect(popover).toBeVisible();
  });
});
