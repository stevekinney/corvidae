import { expect, test } from '@playwright/test';
import type { ActiveDescriptor } from './review-ssr-and-a11y-test-helpers';
import {
  EDITOR_ID,
  activeDescriptor,
  openThreadPopover,
  ready,
  tabAndSettle,
  tabTo,
} from './review-ssr-and-a11y-test-helpers';

test('the Tab order through the composed surface is short and predictable', async ({ page }) => {
  await ready(page);

  // The walk starts from a button OUTSIDE the component so the first Tab is
  // unambiguously the component's first stop.
  await page.getByTestId('tab-order-start').focus();

  // 1. The selected view tab — the tablist's single roving stop.
  await tabTo(page, { role: 'tab', text: 'Editor' });
  // 2. The formatting toolbar's single roving stop. Undo and Redo come
  //    first in the DOM but are disabled on a fresh document, and Cinder's
  //    Toolbar primitive skips disabled items when electing the stop, so the
  //    block-type dropdown inherits it.
  await tabTo(page, { tag: 'BUTTON', label: 'Block type: Paragraph', inControls: true });
  // 3-4. The trailing actions.
  await tabTo(page, { tag: 'BUTTON', label: 'Open comments sidebar (1 comment)' });
  await tabTo(page, { tag: 'BUTTON', label: 'Copy to clipboard' });
  // 5. The ProseMirror HOST — a `role="application"` div that is itself a
  //    tab stop…
  await tabTo(page, { id: EDITOR_ID, role: 'application', label: 'Markdown editor' });
  // 6. …and then the editable surface inside it. Two stops for one editor:
  //    the wrapper's `tabindex="0"` buys nothing a keyboard user can use,
  //    since the very next Tab lands on the contenteditable that does the
  //    work.
  await tabTo(page, { role: 'textbox', label: 'Markdown editor' });
});

test('…and that group is four tab stops, with two more in the editor', async ({ page }) => {
  // SPLIT from the role assertions above, deliberately, rather than skipping
  // them together in WebKit. The roles are engine-independent and they are the
  // half that catches a revert to `role="toolbar"` — the very regression the
  // original pin was too weak to see. Losing that in an engine to protect the
  // count would repeat the mistake this test was rewritten to fix.
  await ready(page);
  await page.getByTestId('tab-order-start').focus();

  const stops: ActiveDescriptor[] = [];
  let current = await activeDescriptor(page);
  for (let step = 0; step < 6; step += 1) {
    current = await tabAndSettle(page, current);
    stops.push(current);
  }

  // Four stops in the bar — the tablist's roving stop, the formatting
  // toolbar's roving stop, and the two trailing action buttons — then two in
  // the editor region, for the ProseMirror host and the surface inside it.
  expect(stops.filter((stop) => stop.inControls)).toHaveLength(4);
  expect(stops.filter((stop) => stop.inEditorMain)).toHaveLength(2);
});

test('opening traps focus, and Tab cycles the three controls inside it', async ({ page }) => {
  await ready(page);
  await openThreadPopover(page);

  // Restated rather than left implicit in the helper: the trap taking focus
  // to the popover's FIRST tabbable element — the destructive one — is the
  // behaviour under test here, not just a precondition for the walk below.
  await expect
    .poll(() => activeDescriptor(page))
    .toMatchObject({
      tag: 'BUTTON',
      label: 'Delete thread',
      inPopover: true,
    });

  // Three stops, then a wrap. The seeded comment is authored by `maya`
  // rather than by `currentUserId`, so CommentList renders no per-comment
  // Edit/Delete buttons; the composer's submit button is `disabled` while
  // the textarea is empty, which takes it out of the cycle too.
  await tabTo(page, { tag: 'BUTTON', label: 'Close', inPopover: true });
  await tabTo(page, { tag: 'TEXTAREA', id: `${EDITOR_ID}-thread-popover-composer` });
  await tabTo(page, { tag: 'BUTTON', label: 'Delete thread', inPopover: true });

  // …and Shift+Tab reverses it without escaping.
  await page.keyboard.press('Shift+Tab');
  await expect
    .poll(() => activeDescriptor(page))
    .toMatchObject({ tag: 'TEXTAREA', inPopover: true });
});
