/**
 * One visual system (COR-1647): the shell's outlet is the one place that pads a page, each view
 * says how dense and how wide it is, a chat does not spend its height on chrome, and the agent
 * form fits its fields above the fold. Every measure is a bounding box or a computed style on the
 * real page against the real host, at the two widths the application is built for.
 */
import type { Page } from '@playwright/test';

import { routes } from '../../src/app/routes.ts';
import { pageWidth, VIEW_NAMES, VIEWS } from '../../src/app/views.ts';
import { approveThroughMount, newThreadId, runToEnd } from './chat-support.ts';
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
  '/chat',
  '/agents',
  '/agents/new',
  '/workflows',
  '/runs',
  '/schedules',
  '/reviews',
  '/workers',
  '/storage',
  '/system',
  '/audit',
  '/settings',
  '/goals',
  '/engine',
] as const;

test.describe('the outlet pads a page and nothing else does', () => {
  for (const path of PAGES) {
    test(`${path} has no padding of its own at the top of the page`, async ({ page, request }) => {
      // A host with no chat a person started opens /chat on its welcome, which the view frame
      // draws (COR-1645). The page under test is the list, so there is a chat to list.
      if (path === '/chat') {
        await runToEnd(request, 'echo', newThreadId('visual-system-list'), 'Hello echo');
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

test.describe('the empty chat screen on a fresh host', () => {
  // The second host holds nothing a person did, so /chat is empty (`24-chat-sessions.spec.ts`).
  test.use({ baseURL: E2E_BUREAU_URL });

  test('adds no padding of its own inside the outlet, which pads the page', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/chat');
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'empty');

    // Cinder's EmptyState pads itself 48px by 32px; the frame takes that off, so the outlet's
    // padding is the only one and the state starts where the page does.
    const empty = page.locator('[data-view="chat"] .cinder-empty-state');
    await expect(empty).toHaveCSS('padding-top', '0px');
    await expect(empty).toHaveCSS('padding-right', '0px');
    await expect(empty).toHaveCSS('padding-bottom', '0px');
    await expect(empty).toHaveCSS('padding-left', '0px');
    const roots = await pageRootPaddings(page);
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) {
      expect(root, `/chat (empty): ${root}`).toMatch(/ 0px 0px 0px 0px$/);
    }
  });
});

test.describe('each view declares how dense it is, and each route what kind of page it is', () => {
  test('the outlet carries the view’s density and the width of the route’s kind', async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const paths: Partial<Record<(typeof VIEW_NAMES)[number], string>> = {
      agents: '/agents',
      runs: '/runs',
      reviews: '/reviews',
      audit: '/audit',
      engine: '/engine',
    };
    for (const [view, path] of Object.entries(paths)) {
      await page.goto(path);
      const outlet = page.locator('main.weft-shell-outlet');
      const declared = VIEWS[view as keyof typeof VIEWS];
      const route = routes.find((candidate) => candidate.pattern === path);
      await expect(outlet).toHaveAttribute('data-density', declared.density);
      await expect(outlet).toHaveAttribute('data-width', pageWidth(route?.kind ?? 'reading'));
    }
  });

  test('a reading page is the 760px column, centred; a table page takes the whole width', async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    // Settings is a form, which keeps the reading width: the outlet pads its content into the
    // column, so the column is the outlet's width less its padding.
    await page.goto('/settings');
    await expect(page.locator('[data-view="settings"]')).toHaveAttribute('data-state', 'ready');
    const column = await page.locator('main.weft-shell-outlet').evaluate((outlet) => {
      const style = getComputedStyle(outlet);
      return (
        outlet.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight)
      );
    });
    expect(column).toBeLessThanOrEqual(760);
    expect(column).toBeGreaterThanOrEqual(740);
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

  test('the compact density has shorter rows and tighter padding than the comfortable one', async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/runs');
    const compact = await page
      .locator('main.weft-shell-outlet')
      .evaluate((outlet) =>
        getComputedStyle(outlet).getPropertyValue('--cinder-density-row-height'),
      );
    await page.goto('/agents');
    const comfortable = await page
      .locator('main.weft-shell-outlet')
      .evaluate((outlet) =>
        getComputedStyle(outlet).getPropertyValue('--cinder-density-row-height'),
      );
    expect(compact.trim()).toBe('2.5rem');
    expect(comfortable.trim()).toBe('3.5rem');
  });
});

test.describe('a chat', () => {
  test('with one message, its tool calls, and one reply fits in 400px of transcript at 1280', async ({
    page,
    request,
  }) => {
    const threadId = newThreadId('visual-system');
    const stream = await runToEnd(request, 'tool-runner', threadId, 'Refund order-1001');
    await approveThroughMount(request, threadId, stream);
    await page.setViewportSize(DESKTOP);
    await page.goto(`/chat/${threadId}`);
    await expect(page.getByText('Order order-1001 was refunded.')).toBeVisible();
    // The tool calls open into their rows, the tallest the transcript gets.
    await page.getByRole('button', { name: 'Show' }).click();
    await expect(page.locator('[data-tool-call-row]').first()).toBeVisible();

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
    for (const id of ['agent-name', 'agent-identifier', 'agent-description', 'agent-model']) {
      const box = await page.locator(`#${id}`).boundingBox();
      expect(box, id).not.toBeNull();
      expect((box?.y ?? 0) + (box?.height ?? 0), id).toBeLessThanOrEqual(DESKTOP.height);
    }
    const instructions = page.locator('#agent-instructions');
    await expect(instructions).toBeInViewport({ ratio: 1 });
  });
});
