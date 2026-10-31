/**
 * Every route in the route table at 375, 768 and 1280 pixels, with long values seeded where a page
 * prints them: a 2,000-character storage key and a 200-character agent description.
 *
 * A route fits when neither the document nor the shell's outlet scrolls sideways, and no box in the
 * outlet reaches past the right edge of the viewport unless an ancestor below the outlet scrolls or
 * clips sideways (`overflow-x` other than `visible`, such as a scrollable table or a line truncated
 * with an ellipsis). That ancestor's own box is measured too, so one that itself reaches past the
 * viewport still fails. Text cut off inside a container that fits is therefore not detected.
 *
 * A route listed in `pending` (`responsive-routes.ts`) is not yet made responsive, and names the
 * issue that owns doing it. The list can only shrink: a listed route that fits fails this
 * specification (remove it), and an unlisted route that overflows fails it too. At COR-1837 every
 * route fits, so `pending` is empty.
 */
import type { Page } from '@playwright/test';

import { routes } from '../../src/app/routes.ts';
import { createAgentFile, removeAgent } from './agent-support.ts';
import { deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { E2E_BASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { pending, responsiveAddresses, type ResponsiveSeed } from './responsive-routes.ts';

const WIDTHS = [375, 768, 1280] as const;
const HEIGHT = 900;

const AGENT_ID = 'responsive-long-description';
const LONG_DESCRIPTION = 'An agent description that keeps going well past one line. '
  .repeat(4)
  .padEnd(200, 'x')
  .slice(0, 200);
const LONG_STORAGE_KEY = `responsive-${'k'.repeat(1989)}`;
const CHAT_THREAD = newThreadId('responsive');

/** What overflows the viewport: the document and the outlet by their scroll width, and the boxes that reach past it. */
interface Overflow {
  readonly document: number;
  readonly outlet: number;
  /** Elements in the outlet whose box extends past the right edge of the viewport, and that no scrolling or clipping ancestor holds. */
  readonly escaping: readonly string[];
}

async function overflowOf(page: Page): Promise<Overflow> {
  return page.evaluate(() => {
    const outlet = document.querySelector('main.weft-shell-outlet');
    const limit = window.innerWidth + 1;
    /** Whether an ancestor below the outlet scrolls or clips sideways, so the box is reached by scrolling it, or is truncated on purpose. */
    const heldByContainer = (element: Element): boolean => {
      for (let parent = element.parentElement; parent && parent !== outlet;) {
        const overflowX = getComputedStyle(parent).overflowX;
        if (overflowX !== 'visible') return true;
        parent = parent.parentElement;
      }
      return false;
    };
    const escaping: string[] = [];
    if (outlet !== null) {
      for (const element of outlet.querySelectorAll('*')) {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.right <= limit || heldByContainer(element)) continue;
        const name =
          element.tagName.toLowerCase() +
          (typeof element.className === 'string' && element.className !== ''
            ? `.${element.className.split(' ')[0]}`
            : '');
        if (!escaping.includes(name)) escaping.push(name);
      }
    }
    return {
      document: document.documentElement.scrollWidth - window.innerWidth,
      outlet: outlet === null ? 0 : outlet.scrollWidth - outlet.clientWidth,
      escaping: escaping.slice(0, 5),
    };
  });
}

/** Whether a measurement shows anything that does not fit. */
function overflows(overflow: Overflow): boolean {
  return overflow.document > 0 || overflow.outlet > 0 || overflow.escaping.length > 0;
}

/**
 * Opens `address` at `width` and waits until the page has something to measure: the view's frame
 * has left its loading state, nothing in the outlet is busy, and the outlet holds text.
 */
async function settle(page: Page, pattern: string, width: number): Promise<void> {
  const address = addresses[pattern]!;
  await page.setViewportSize({ width, height: HEIGHT });
  await page.goto(address);
  const outlet = page.locator('main.weft-shell-outlet');
  await expect(outlet).toBeVisible();
  const frame = outlet.locator('[data-view]').first();
  await expect(frame).toBeVisible();
  await expect(frame).not.toHaveAttribute('data-state', 'loading');
  await expect(outlet.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect
    .poll(async () => {
      const text = await outlet.innerText();
      return text.trim().length;
    })
    .toBeGreaterThan(0);
  await reveal[pattern]?.(page);
}

/**
 * What a page needs done before it prints a seeded value: the storage page lists keys only once it
 * has scanned, so it scans from the long key's start and waits for the key.
 */
const reveal: Readonly<Record<string, (page: Page) => Promise<void>>> = {
  '/health/storage': async (page) => {
    await page.getByRole('tab', { name: 'Start / end' }).click();
    await page.getByLabel('Start (inclusive)').fill('responsive-');
    await page.getByRole('button', { name: 'Scan', exact: true }).click();
    await expect(
      page.locator('.weft-storage-key-cell', { hasText: LONG_STORAGE_KEY }),
    ).toBeVisible();
  },
};

let addresses: Readonly<Record<string, string>>;

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: E2E_BASE_URL });
  try {
    await removeAgent(request, AGENT_ID);
    await createAgentFile(request, AGENT_ID, {
      name: AGENT_ID,
      description: LONG_DESCRIPTION,
    });
    await runToEnd(request, 'assistant', CHAT_THREAD, 'Say hello');
    const stored = await request.put(`/v1/storage/${encodeURIComponent(LONG_STORAGE_KEY)}`, {
      headers: { 'content-type': 'application/octet-stream' },
      data: Buffer.from('a value'),
    });
    expect(stored.status(), 'storing the long key').toBeLessThan(300);
    const listed = await request.get('/v1/workflows?type=order-processing&limit=1');
    const runs = (await listed.json()) as { items?: { id: string }[] };
    const scheduled = await request.get('/v1/schedules');
    const schedules = (await scheduled.json()) as { items?: { id: string }[] };
    const seed: ResponsiveSeed = {
      chat: CHAT_THREAD,
      agent: AGENT_ID,
      workflow: 'order-processing',
      run: runs.items?.[0]?.id ?? 'responsive-run',
      schedule: schedules.items?.[0]?.id ?? 'responsive-schedule',
    };
    addresses = responsiveAddresses(seed);
  } finally {
    await request.dispose();
  }
});

test.afterAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: E2E_BASE_URL });
  try {
    await removeAgent(request, AGENT_ID);
    await request.delete(`/v1/storage/${encodeURIComponent(LONG_STORAGE_KEY)}`);
    await deleteChats([CHAT_THREAD]);
  } finally {
    await request.dispose();
  }
});

test('gives every route in the table an address, and every pending route an owner and a route', () => {
  const patterns = routes.filter((route) => route.redirect === undefined).map((r) => r.pattern);
  expect(Object.keys(addresses).toSorted()).toEqual(patterns.toSorted());
  for (const entry of pending) {
    expect(patterns, entry.pattern).toContain(entry.pattern);
    expect(entry.issue, entry.pattern).toMatch(/^COR-\d+$/);
  }
  expect(new Set(pending.map((entry) => entry.pattern)).size).toBe(pending.length);
});

test('measures a box that reaches past the viewport, and not one a scrolling or clipping container holds', async ({
  page,
}) => {
  await settle(page, '/reviews', 375);
  expect(overflows(await overflowOf(page))).toBe(false);
  await page.evaluate(() => {
    const outlet = document.querySelector('main.weft-shell-outlet')!;
    const held = document.createElement('div');
    held.style.cssText = 'overflow-x: auto; width: 100px';
    held.innerHTML = '<div id="held" style="width: 2000px">held</div>';
    outlet.append(held);
  });
  expect(overflows(await overflowOf(page))).toBe(false);
  await page.evaluate(() => {
    const wide = document.createElement('div');
    wide.id = 'wide';
    wide.style.cssText = 'width: 2000px; overflow: hidden';
    document.querySelector('main.weft-shell-outlet')!.append(wide);
  });
  const overflow = await overflowOf(page);
  expect(overflows(overflow)).toBe(true);
  expect(overflow.escaping).toContain('div');
});

for (const route of routes) {
  if (route.redirect !== undefined) continue;
  const owner = pending.find((entry) => entry.pattern === route.pattern);

  if (owner === undefined) {
    test(`${route.pattern} fits at 375, 768 and 1280 pixels`, async ({ page }) => {
      for (const width of WIDTHS) {
        await settle(page, route.pattern, width);
        const overflow = await overflowOf(page);
        expect(
          overflows(overflow),
          `${route.pattern} at ${width}px: ${JSON.stringify(overflow)}`,
        ).toBe(false);
      }
    });
  } else {
    test(`${route.pattern} still overflows, which ${owner.issue} owns (remove it from pending once it fits)`, async ({
      page,
    }) => {
      let overflowed = false;
      for (const width of WIDTHS) {
        await settle(page, route.pattern, width);
        const overflow = await overflowOf(page);
        if (overflows(overflow)) overflowed = true;
      }
      expect(overflowed, `${route.pattern} fits now; remove it from pending`).toBe(true);
    });
  }
}
