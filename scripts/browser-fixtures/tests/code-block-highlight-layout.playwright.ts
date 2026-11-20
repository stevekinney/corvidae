import { expect, test, type Page } from '@playwright/test';

import { functionalResidualRoute } from './functional-residual-route.ts';

const CODE_BLOCK_ROUTE = functionalResidualRoute;
const EXAMPLE = '#example-mount-delayed-highlighting';

declare global {
  interface Window {
    cinderCodeBlockLayoutHighlighterReady?: boolean;
    resolveCinderCodeBlockLayoutHighlight?: () => void;
  }
}

type LayoutMetrics = {
  blockHeight: number;
  sentinelY: number;
  viewportClientWidth: number;
  viewportScrollWidth: number;
  viewportTabIndex: string | null;
  descendantTabIndexCount: number;
  preOverflowX: string;
  prePaddingBlockStart: string;
  prePaddingBlockEnd: string;
};

async function readLayoutMetrics(page: Page): Promise<LayoutMetrics> {
  return await page.evaluate((exampleSelector) => {
    const block = document.querySelector(`${exampleSelector} .cinder-code-block`);
    const sentinel = document.querySelector(
      `${exampleSelector} [data-testid="code-block-sentinel"]`,
    );
    const viewport = document.querySelector(`${exampleSelector} .cinder-code-block__viewport`);
    const pre = document.querySelector(`${exampleSelector} .cinder-code-block__viewport pre`);
    if (!(block instanceof HTMLElement)) throw new Error('Missing code block.');
    if (!(sentinel instanceof HTMLElement)) throw new Error('Missing sentinel.');
    if (!(viewport instanceof HTMLElement)) throw new Error('Missing viewport.');
    if (!(pre instanceof HTMLElement)) throw new Error('Missing pre.');

    const blockRect = block.getBoundingClientRect();
    const sentinelRect = sentinel.getBoundingClientRect();
    const preStyles = getComputedStyle(pre);

    return {
      blockHeight: blockRect.height,
      sentinelY: sentinelRect.y,
      viewportClientWidth: viewport.clientWidth,
      viewportScrollWidth: viewport.scrollWidth,
      viewportTabIndex: viewport.getAttribute('tabindex'),
      descendantTabIndexCount: viewport.querySelectorAll('[tabindex]').length,
      preOverflowX: preStyles.overflowX,
      prePaddingBlockStart: preStyles.paddingBlockStart,
      prePaddingBlockEnd: preStyles.paddingBlockEnd,
    };
  }, EXAMPLE);
}

// Rendered Markdown styles a bare `pre` from the utilities layer, which is later than CodeBlock's
// components layer, so a CodeBlock inside `.cinder-markdown-content` is measured as well.
for (const insideMarkdown of [false, true]) {
  const where = insideMarkdown ? ' inside rendered Markdown' : '';
  test(`CodeBlock highlighting does not move surrounding layout${where}`, async ({ page }) => {
    await assertHighlightKeepsLayout(page, insideMarkdown);
  });
}

async function assertHighlightKeepsLayout(page: Page, insideMarkdown: boolean): Promise<void> {
  await page.goto(CODE_BLOCK_ROUTE, { waitUntil: 'domcontentloaded' });
  const block = page.locator(`${EXAMPLE} .cinder-code-block`).first();
  await expect(block.locator('.cinder-code-block__pre')).toBeVisible();
  await page.waitForFunction(() => Boolean(window.cinderCodeBlockLayoutHighlighterReady));

  await block.evaluate((element, wrap) => {
    if (wrap) {
      const content = document.createElement('div');
      content.className = 'cinder-markdown-content';
      element.before(content);
      content.append(element);
    }
    element.style.inlineSize = '240px';
    const sentinel = document.createElement('div');
    sentinel.dataset['testid'] = 'code-block-sentinel';
    sentinel.style.marginBlockStart = '16px';
    sentinel.style.blockSize = '24px';
    sentinel.style.background = 'var(--cinder-accent-solid)';
    (element.parentElement?.classList.contains('cinder-markdown-content')
      ? element.parentElement
      : element
    ).after(sentinel);
  }, insideMarkdown);
  await block.locator('.cinder-code-block__viewport').evaluate((viewport) => {
    viewport.setAttribute('data-stable-viewport', 'before-highlight');
  });

  const before = await readLayoutMetrics(page);

  await page.evaluate(() => {
    const resolver = window.resolveCinderCodeBlockLayoutHighlight;
    if (resolver === undefined) throw new Error('Highlighter resolver was not registered.');
    resolver();
  });

  await expect(block.locator('.cinder-code-block__highlighted .shiki')).toBeVisible();
  await expect(block.locator('.cinder-code-block__viewport')).toHaveAttribute(
    'data-stable-viewport',
    'before-highlight',
  );

  const after = await readLayoutMetrics(page);

  expect(before.viewportTabIndex).toBe('0');
  expect(after.viewportTabIndex).toBe('0');
  expect(before.descendantTabIndexCount).toBe(0);
  expect(after.descendantTabIndexCount).toBe(0);
  expect(after.preOverflowX).toBe('clip');
  expect(before.viewportScrollWidth).toBeGreaterThan(before.viewportClientWidth);
  expect(after.viewportScrollWidth).toBeGreaterThan(after.viewportClientWidth);
  expect(after.prePaddingBlockStart).toBe(before.prePaddingBlockStart);
  expect(after.prePaddingBlockEnd).toBe(before.prePaddingBlockEnd);
  expect(Math.abs(after.blockHeight - before.blockHeight)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(after.sentinelY - before.sentinelY)).toBeLessThanOrEqual(0.5);
}
