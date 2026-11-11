/**
 * One visual system (COR-1647): the shell's outlet is the one place that pads a page, each view
 * says how dense and how wide it is, a chat does not spend its height on chrome, and the agent
 * form fits its fields above the fold. Every measure is a bounding box or a computed style on the
 * real page against the real host, at the two widths the application is built for.
 */
import type { Page } from '@playwright/test';

import { routes } from '../../src/app/routes.ts';
import { pageWidth, VIEW_NAMES } from '../../src/app/views.ts';
import { approveThroughMount, conversation, newThreadId, runToEnd } from './chat-support.ts';
import { E2E_BUREAU_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

/** A chat is a transcript of one user message, tool calls, and one reply: nothing needs more. */
const TRANSCRIPT_HEIGHT = 400;
const DESKTOP = { width: 1280, height: 812 } as const;

/** The page roots in the outlet: its children, looking through the view frame (`display: contents`). */
async function pageRootPaddings(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const outlet = document.querySelector('main.weft-shell-outlet');
    if (outlet === null) return ['no outlet'];
    const roots: Element[] = [];
    const visit = (element: Element) => {
      for (const child of Array.from(element.children)) {
        if (getComputedStyle(child).display === 'contents') visit(child);
        else roots.push(child);
      }
    };
    visit(outlet);
    return roots
      .filter((root) => root.tagName !== 'DIALOG' && root.getAttribute('role') !== 'status')
      .map((root) => {
        const style = getComputedStyle(root);
        return `${root.tagName.toLowerCase()}.${root.className.split(' ')[0]} ${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`;
      });
  });
}

const PAGES = [
  '/chats',
  '/agents',
  '/agents/new',
  '/capabilities',
  '/workflows',
  '/runs',
  '/schedules',
  '/reviews',
  '/health/workers',
  '/health/storage',
  '/settings/api-reference',
  '/health/audit',
  '/settings',
  '/goals',
  '/health',
] as const;

test.describe('the outlet pads a page and nothing else does', () => {
  for (const path of PAGES) {
    test(`${path} has no padding of its own at the top of the page`, async ({ page, request }) => {
      // A host with no chat a person started opens /chats on its welcome, which the view frame
      // draws (COR-1645). The page under test is the list, so there is a chat to list.
      if (path === '/chats') {
        await runToEnd(request, 'demo:echo', newThreadId('visual-system-list'), 'Hello echo');
      }
      await page.setViewportSize(DESKTOP);
      await page.goto(path);
      await expect(page.locator('[data-view]').first()).not.toHaveAttribute(
        'data-state',
        'loading',
      );
      const roots = await pageRootPaddings(page);
      expect(roots.length).toBeGreaterThan(0);
      for (const root of roots) {
        expect(root, `${path}: ${root}`).toMatch(/ 0px 0px 0px 0px$/);
      }
    });
  }

  test('the outlet pads 16px above, 24px at the sides on a table page, and less on a phone', async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/runs');
    const outlet = page.locator('main.weft-shell-outlet');
    await expect(outlet).toHaveCSS('padding-top', '16px');
    await expect(outlet).toHaveCSS('padding-left', '24px');
    await expect(outlet).toHaveCSS('padding-right', '24px');
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(outlet).toHaveCSS('padding-top', '12px');
    await expect(outlet).toHaveCSS('padding-left', '16px');
  });
});

test.describe('the first-use chat screen on a fresh host', () => {
  // The second host holds nothing a person did, so /chats has no chats (`24-chat-sessions.spec.ts`).
  test.use({ baseURL: E2E_BUREAU_URL });

  test('adds no padding of its own inside the outlet, which pads the page', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/chats');
    // The frame is ready: the list pane words its own first use ("No chats yet") inside itself,
    // so the screen is no longer an empty state that fills the outlet.
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await expect(
      page.getByRole('region', { name: 'Chats' }).getByRole('heading', { name: 'No chats yet' }),
    ).toBeVisible();

    // The outlet's padding is the only one: the chat screen's roots add none of their own.
    const roots = await pageRootPaddings(page);
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) {
      expect(root, `/chats (first use): ${root}`).toMatch(/ 0px 0px 0px 0px$/);
    }
  });
});

test.describe('each route says what kind of page it is, and every page has one density', () => {
  test('the outlet carries the width of the route’s kind and no density', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const paths: Partial<Record<(typeof VIEW_NAMES)[number], string>> = {
      agents: '/agents',
      capabilities: '/capabilities',
      runs: '/runs',
      reviews: '/reviews',
      audit: '/health/audit',
      health: '/health',
    };
    for (const path of Object.values(paths)) {
      await page.goto(path);
      const outlet = page.locator('main.weft-shell-outlet');
      const route = routes.find((candidate) => candidate.pattern === path);
      await expect(outlet).not.toHaveAttribute('data-density', /.*/);
      await expect(outlet).toHaveAttribute('data-width', pageWidth(route?.kind ?? 'reading'));
    }
  });

  test('a reading page is the 720px column, centred; a table page takes the whole width', async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    // The new-workflow builder is a form, which keeps the reading width: the outlet pads its content
    // into the column, so the column is the outlet's width less its padding.
    await page.goto('/workflows/new');
    const outlet = page.locator('main.weft-shell-outlet');
    await expect(outlet).toHaveAttribute('data-width', 'reading');
    await expect(outlet.getByRole('heading', { level: 1 })).toBeVisible();
    const column = await outlet.evaluate((element) => {
      const style = getComputedStyle(element);
      return (
        element.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight)
      );
    });
    expect(column).toBeLessThanOrEqual(720);
    expect(column).toBeGreaterThanOrEqual(700);
    // Settings is a full-width page whose section navigation sits beside one reading column of at
    // most 46rem (design rows 05f and 47a), which the page header and the content share.
    await page.goto('/settings');
    await expect(page.locator('[data-view="settings"]')).toHaveAttribute('data-state', 'ready');
    await expect(outlet).toHaveAttribute('data-width', 'full');
    const settingsColumn = await page
      .locator('.weft-settings__title-area')
      .evaluate((element) => element.getBoundingClientRect().width);
    expect(settingsColumn).toBeLessThanOrEqual(46 * 16);
    expect(settingsColumn).toBeGreaterThanOrEqual(700);
    await page.goto('/runs');
    // The loading skeleton is already wider than 900px, so a width read before the frame has swapped
    // it for the page measures nothing about the page. Wait for the page, then read its width.
    await expect(page.locator('[data-view="runs"]')).toHaveAttribute('data-state', 'ready');
    const runsPage = page.locator('[data-view="runs"]').locator('> *').first();
    await expect
      .poll(async () => {
        const box = await runsPage.boundingBox();
        return box?.width ?? 0;
      })
      .toBeGreaterThan(900);
  });

  test('every page reads the same row height, the comfortable one', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const heights: string[] = [];
    for (const path of ['/runs', '/agents', '/health']) {
      await page.goto(path);
      const height = await page
        .locator('main.weft-shell-outlet')
        .evaluate((outlet) =>
          getComputedStyle(outlet).getPropertyValue('--cinder-density-row-height'),
        );
      heights.push(height.trim());
    }
    expect(heights).toEqual(['3.5rem', '3.5rem', '3.5rem']);
  });
});

test.describe('a chat', () => {
  test('with one message, its tool calls, and one reply fits in 400px of transcript at 1280', async ({
    page,
    request,
  }) => {
    const threadId = newThreadId('visual-system');
    const stream = await runToEnd(request, 'demo:tool-runner', threadId, 'Refund order-1001');
    await approveThroughMount(request, threadId, stream);
    await page.setViewportSize(DESKTOP);
    await page.goto(`/chats/${threadId}`);
    await expect(conversation(page).getByText('Order order-1001 was refunded.')).toBeVisible();
    // The tool calls are rows on the rail, the tallest the transcript gets.
    await expect(page.locator('[data-cinder-tool-call-row]').first()).toBeVisible();

    const timeline = page.locator('.chat-timeline');
    const first = await timeline.locator('> *').first().boundingBox();
    const messages = timeline.locator('.chat-message-wrapper');
    const last = await messages.last().boundingBox();
    if (first === null || last === null) throw new Error('The transcript has no entries.');
    expect(last.y + last.height - first.y).toBeLessThanOrEqual(TRANSCRIPT_HEIGHT);
  });
});

test.describe('the agent form', () => {
  test('fits its fields above the fold at 1280 by 812, with the instructions visible', async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/agents/new');
    // A new agent's ID follows its name as a line with Change (S7), not a field of its own until
    // Change is pressed, so the line is what has to fit.
    for (const field of [
      page.locator('#agent-name'),
      page.getByTestId('agent-identifier'),
      page.locator('#agent-description'),
      page.locator('#agent-model'),
    ]) {
      await expect(field).toBeVisible();
      const box = await field.boundingBox();
      expect(box, String(field)).not.toBeNull();
      expect((box?.y ?? 0) + (box?.height ?? 0), String(field)).toBeLessThanOrEqual(DESKTOP.height);
    }
    const instructions = page.locator('#agent-instructions');
    await expect(instructions).toBeInViewport({ ratio: 1 });
  });
});
