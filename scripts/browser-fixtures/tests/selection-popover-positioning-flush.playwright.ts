import { expect, test } from '@playwright/test';
import {
  boxesOverlap,
  desktopViewport,
  expectBoxInsideViewport,
  openPage,
  requireBox,
  waitForSelectionPopoverClearOfSelection,
} from './selection-popover-positioning-helpers.ts';

test.use({ viewport: { width: desktopViewport.width, height: desktopViewport.height } });

test('selection flush to viewport top places popover below the selection without overlapping', async ({
  page,
}) => {
  // Regression test for issue #369: when a selection sits flush against the
  // viewport top and there is ample room below, the popover must anchor below
  // the selection's BOTTOM edge (y + height), not its top edge. Without the
  // fix, the virtual anchor had zero height so `bottom` equalled `top` — causing
  // floating-ui's flip middleware to place the popover's top at `anchor.bottom +
  // offset = selection.top + 8`, which overlapped the selection line.
  await openPage(page);

  // Step 1: scroll so the target text is at the very top of the viewport,
  // giving no room above for a `top` placement and forcing a bottom-placement
  // flip. Scroll and selection geometry are split into separate evaluate calls
  // so the browser frame settles after the scroll before we capture post-scroll
  // coordinates. The scroll returns its intended target so we can wait on a
  // condition that is satisfied even when no scroll was needed (the text is
  // already flush to the top, so `initialRect.top` is 0) — waiting on
  // `scrollY > 0` would hang in that case.
  const targetScrollY = await page.evaluate(() => {
    const searchText = 'appears near highlighted text';
    function findTextNode(root: Node): Text | null {
      if (root instanceof Text && root.textContent?.includes(searchText)) {
        const parentElement = root.parentElement;
        if (parentElement && parentElement.getClientRects().length > 0) {
          return root;
        }
      }
      for (const child of Array.from(root.childNodes)) {
        const found = findTextNode(child);
        if (found) return found;
      }
      return null;
    }

    const textNode = findTextNode(document.body);
    if (!textNode) throw new Error('Text "appears near highlighted text" not found.');

    const initialRect = textNode.parentElement?.getBoundingClientRect();
    if (initialRect) {
      window.scrollBy(0, initialRect.top);
    }
    // The page may already be scrolled past the document's max, so clamp the
    // expected value to whatever the browser actually allows.
    const maxScrollY = document.documentElement.scrollHeight - window.innerHeight;
    return Math.max(0, Math.min(window.scrollY, maxScrollY));
  });

  // Wait for the scroll to settle so viewport-relative coordinates are stable.
  // `scrollY` has already reached its target inside the evaluate above; this
  // waits for the rendered frame to reflect it (and resolves immediately when
  // the target is 0 — no scroll was needed).
  await page.waitForFunction((expected) => Math.abs(window.scrollY - expected) <= 1, targetScrollY);

  // `scrollY` reaching its target is NOT the same as the browser having finished
  // dispatching `scroll` events — the event fires asynchronously after the
  // position updates, so one can still land after the wait above resolves.
  // SelectionPopover dismisses on `scroll` by design, so a single late event
  // arriving after Step 2 opens the popover closes it again, and
  // `data-cinder-position-ready` never flips to 'true'. That raced at roughly a
  // 40% failure rate locally.
  //
  // Wait for scroll QUIESCENCE — no scroll event for at least 100ms, checked on
  // animation frames — rather than only waiting for the final offset.
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let lastScrollAt = performance.now();
      const recordScroll = () => {
        lastScrollAt = performance.now();
      };

      window.addEventListener('scroll', recordScroll, { passive: true });

      const checkQuiescence = () => {
        if (performance.now() - lastScrollAt >= 100) {
          window.removeEventListener('scroll', recordScroll);
          resolve();
          return;
        }

        requestAnimationFrame(checkQuiescence);
      };

      requestAnimationFrame(checkQuiescence);
    });
  });

  // Step 2: now that the frame has settled, create the selection and capture
  // post-scroll geometry. The anchorBox.y must be near 0 because the text is
  // flush with the viewport top.
  const selectionGeometry = await page.evaluate(() => {
    const searchText = 'appears near highlighted text';
    function findTextNode(root: Node): Text | null {
      if (root instanceof Text && root.textContent?.includes(searchText)) {
        const parentElement = root.parentElement;
        if (parentElement && parentElement.getClientRects().length > 0) {
          return root;
        }
      }
      for (const child of Array.from(root.childNodes)) {
        const found = findTextNode(child);
        if (found) return found;
      }
      return null;
    }

    const selectedText = searchText;
    const textNode = findTextNode(document.body);
    if (!textNode) throw new Error(`Text "${selectedText}" not found.`);

    const sourceText = textNode.textContent ?? '';
    const start = sourceText.indexOf(selectedText);
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + selectedText.length);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));

    const clientRects = Array.from(range.getClientRects()).filter(
      (clientRect) => clientRect.width > 0 && clientRect.height > 0,
    );
    const anchorRect = clientRects[0] ?? range.getBoundingClientRect();

    return {
      anchorBox: {
        x: anchorRect.x,
        y: anchorRect.y,
        width: anchorRect.width,
        height: anchorRect.height,
      },
    };
  });

  // The selection must be near the viewport top (within one line height).
  expect(selectionGeometry.anchorBox.y).toBeLessThanOrEqual(30);

  const popover = page.locator('#basic-selection-popover');
  await expect(popover).toHaveAttribute('data-cinder-position-ready', 'true');

  // Poll until the popover is positioned and does not overlap the selection.
  await waitForSelectionPopoverClearOfSelection(
    page,
    '#basic-selection-popover',
    selectionGeometry.anchorBox,
  );

  const popoverBox = requireBox(await popover.boundingBox(), 'Flush-top selection popover');

  // Primary assertion: no overlap — the bug caused ~8.5px overlap.
  expect(boxesOverlap(selectionGeometry.anchorBox, popoverBox)).toBe(false);
  // Popover must stay fully inside the viewport.
  expectBoxInsideViewport(popoverBox, desktopViewport);
  // With ample room below, the popover should use bottom placement.
  const placement = await popover.getAttribute('data-cinder-placement');
  expect(placement).toMatch(/^bottom/);

  // Also verify the expanded composer does not overlap (the workaround sized
  // the padding to 8rem specifically because the composer is ~114px tall).
  await page.getByRole('button', { name: 'Add comment' }).first().click();
  await expect(page.getByRole('textbox', { name: 'Comment text' })).toBeVisible();
  await expect(popover).toHaveAttribute('data-cinder-position-ready', 'true');
  await waitForSelectionPopoverClearOfSelection(
    page,
    '#basic-selection-popover',
    selectionGeometry.anchorBox,
  );

  const expandedBox = requireBox(await popover.boundingBox(), 'Flush-top expanded composer');
  expect(boxesOverlap(selectionGeometry.anchorBox, expandedBox)).toBe(false);
  expectBoxInsideViewport(expandedBox, desktopViewport);
});
