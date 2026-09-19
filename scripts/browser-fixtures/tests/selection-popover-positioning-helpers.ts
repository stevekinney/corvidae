import { VIEWPORTS } from '@corvidae/testing';
import { expect, type Page } from '@playwright/test';
import { fixtureRoute } from './editor-fixture.ts';

type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type SelectionGeometry = {
  anchorBox: Box;
  boundingBox: Box;
  clientRectCount: number;
};

export const desktopViewport =
  VIEWPORTS.find((viewport) => viewport.name === 'desktop') ??
  (() => {
    throw new Error('Desktop viewport is required.');
  })();

const SELECTION_ROUTE = fixtureRoute('selection-popover');

export async function openPage(page: Page): Promise<Page> {
  await page.goto(SELECTION_ROUTE, { waitUntil: 'load' });
  await expect(page.locator('.selection-surface')).toBeVisible();
  return page;
}

export function requireBox(box: Box | null, label: string): Box {
  if (!box) {
    throw new Error(`${label} must have a layout box.`);
  }
  return box;
}

export async function selectTextInExample(
  page: Page,
  text: string,
  options: { constrainClosestArticleWidth?: string } = {},
): Promise<SelectionGeometry> {
  return page.evaluate(
    ({ selectedText, constrainClosestArticleWidth }) => {
      function findTextNode(root: Node): Text | null {
        if (root instanceof Text && root.textContent?.includes(selectedText)) {
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
      if (!textNode) {
        throw new Error(`Unable to find text node containing "${selectedText}".`);
      }

      if (constrainClosestArticleWidth) {
        const article = textNode.parentElement?.closest<HTMLElement>('article');
        if (article) {
          article.style.maxWidth = constrainClosestArticleWidth;
          article.style.width = constrainClosestArticleWidth;
        }
      }

      const sourceText = textNode.textContent ?? '';
      const start = sourceText.indexOf(selectedText);
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + selectedText.length);

      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));

      const clientRects = Array.from(range.getClientRects()).filter((clientRect) => {
        return clientRect.width > 0 && clientRect.height > 0;
      });
      const anchorRect = clientRects[0] ?? range.getBoundingClientRect();
      const boundingRect = range.getBoundingClientRect();

      return {
        anchorBox: {
          x: anchorRect.x,
          y: anchorRect.y,
          width: anchorRect.width,
          height: anchorRect.height,
        },
        boundingBox: {
          x: boundingRect.x,
          y: boundingRect.y,
          width: boundingRect.width,
          height: boundingRect.height,
        },
        clientRectCount: clientRects.length,
      };
    },
    { selectedText: text, constrainClosestArticleWidth: options.constrainClosestArticleWidth },
  );
}

export function expectBoxInsideViewport(box: Box, viewport: { width: number; height: number }) {
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
}

export function boxesOverlap(first: Box, second: Box): boolean {
  return !(
    first.x + first.width <= second.x ||
    second.x + second.width <= first.x ||
    first.y + first.height <= second.y ||
    second.y + second.height <= first.y
  );
}

export function isBoxInsideViewport(
  box: Box,
  viewport: { width: number; height: number },
): boolean {
  return (
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.width <= viewport.width &&
    box.y + box.height <= viewport.height
  );
}

export function isSelectionPopoverPlacement(
  selectionBox: Box,
  popoverBox: Box,
  placement: string | null,
): boolean {
  if (popoverBox.width <= 0 || popoverBox.height <= 0) return false;
  if (!placement || !/^(top|bottom)/.test(placement)) return false;

  const verticalGap = placement.startsWith('top')
    ? selectionBox.y - (popoverBox.y + popoverBox.height)
    : popoverBox.y - (selectionBox.y + selectionBox.height);

  if (verticalGap < 4 || verticalGap > 32) return false;

  const selectionCenter = selectionBox.x + selectionBox.width / 2;
  return (
    selectionCenter >= popoverBox.x - 16 && selectionCenter <= popoverBox.x + popoverBox.width + 16
  );
}

export function expectSelectionPopoverPlacement(
  selectionBox: Box,
  popoverBox: Box,
  placement: string | null,
) {
  expect(isSelectionPopoverPlacement(selectionBox, popoverBox, placement)).toBe(true);
}

export async function waitForSelectionPopoverPlacement(
  page: Page,
  selector: string,
  selectionBox: Box,
) {
  await expect
    .poll(async () => {
      const popover = page.locator(selector);
      const popoverBox = await popover.boundingBox();
      if (!popoverBox) return false;
      return isSelectionPopoverPlacement(
        selectionBox,
        popoverBox,
        await popover.getAttribute('data-cinder-placement'),
      );
    })
    .toBe(true);
}

export async function waitForSelectionPopoverClearOfSelection(
  page: Page,
  selector: string,
  selectionBox: Box,
) {
  await expect
    .poll(async () => {
      const popoverBox = await page.locator(selector).boundingBox();
      if (!popoverBox) return false;
      return (
        !boxesOverlap(selectionBox, popoverBox) && isBoxInsideViewport(popoverBox, desktopViewport)
      );
    })
    .toBe(true);
}
