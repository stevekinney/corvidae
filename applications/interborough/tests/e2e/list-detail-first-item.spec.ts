/**
 * The list-and-detail pages open their first item (COR-2445, owner 2026-11-19): beside the list,
 * with nothing named in the address, the first row the list draws opens, the address names it with
 * a replace (Back leaves the page), and the row reads selected. With one pane at a time (a phone)
 * nothing opens and the list shows. Capabilities (Tools and Skills), Reviews (Waiting and Done)
 * and Chat, at 1280 and 1920 pixels and at 375.
 *
 * And the lists sit flat on the page under their tabs (the wide-first sweep, 2026-11-19): no
 * bordered, rounded box around ListDetail on Capabilities, an agent's Memory, Health's Workers and
 * Settings' Plugins, at 1280 and 1920 pixels.
 */
import type { Locator, Page, Route } from '@playwright/test';

import { CAPABILITIES_COPY } from '../../src/app/copy/capabilities.ts';
import { E2E_BASE_URL, E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { readBoxes } from './read-boxes.ts';

test.use({ baseURL: E2E_SHOWCASE_URL });

/** `path` on `origin`, the host whose world has the page's rows: the showcase unless a case names another. */
const at = (path: string, origin: string = E2E_SHOWCASE_URL): string =>
  new URL(path, origin).toString();

const WIDE = [1280, 1920] as const;
const PHONE = 375;

/** A page the tests arrive from, so Back has somewhere to go. */
const BEFORE = '/health';

/** Whether `row` is the selected one: it, or its primary control, carries `aria-current="true"`. */
async function isSelected(row: Locator): Promise<boolean> {
  return row.evaluate(
    (element) =>
      element.matches('[aria-current="true"]') ||
      element.querySelector('[aria-current="true"]') !== null,
  );
}

/** The list-and-detail cases: where each page is, its rows, and what its address names the open one. */
interface Case {
  readonly name: string;
  readonly path: string;
  readonly rows: (page: Page) => Locator;
  /** The open item's key in the address, read from it. */
  readonly openKey: (url: URL) => string | null;
  /** The first row's key, as the address names it, or `null` when the row does not carry it. */
  readonly rowKey: (row: Locator) => Promise<string | null>;
  /** Stands in for the server before the page is opened, when the showcase has no rows of its own. */
  readonly prepare?: (page: Page) => Promise<void>;
  /** The host to open the page on, when the showcase does not hold its rows (it discovers no skills). */
  readonly origin?: string;
}

/** The reviews the stand-in lists, waiting or decided, as `bureau.reviews.list` gives them. */
function reviewsOf(status: 'pending' | 'approved'): Record<string, unknown>[] {
  const now = Date.now();
  return Array.from({ length: 3 }, (_, index) => {
    const requestedAt = now - (index + 1) * 11 * 60_000;
    return {
      source: 'bureau',
      kind: 'tool-approval',
      id: `first-item-${status}-${String(index)}`,
      runId: `first-item-run-${String(index)}`,
      sessionId: `first-item-session-${String(index)}`,
      agentName: 'demo:tool-runner',
      requestedAt,
      ageMilliseconds: now - requestedAt,
      status,
      round: 0,
      approval: {
        callId: `first-item-call-${String(index)}`,
        toolName: 'demo:issue-refund',
        arguments: { orderId: `order-44${String(70 + index)}`, cents: 4200 },
        action: { type: 'approval', risk: 'medium', operation: { kind: 'other' } },
      },
      ...(status === 'approved'
        ? {
            resolution: {
              decision: 'approve',
              decidedBy: 'anonymous:local',
              decidedAt: requestedAt + 60_000,
              decisionSurface: 'reviews',
            },
          }
        : {}),
    };
  });
}

/** Adds three reviews of each kind to the server's answers to `bureau.reviews.list`. */
async function listReviews(page: Page): Promise<void> {
  await page.route('**/jsonrpc', async (route: Route) => {
    const call = route.request().postDataJSON() as {
      method?: string;
      params?: Record<string, unknown>;
    };
    if (call.method !== 'bureau.reviews.list') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as { result?: Record<string, unknown> };
    if (body.result !== undefined) {
      const resolved = call.params?.['status'] === 'resolved';
      const real = Array.isArray(body.result['reviews']) ? body.result['reviews'] : [];
      body.result['reviews'] = [...reviewsOf(resolved ? 'approved' : 'pending'), ...real];
    }
    await route.fulfill({ response, json: body });
  });
}

const CASES: readonly Case[] = [
  {
    name: 'Capabilities, Tools',
    path: '/capabilities',
    rows: (page) => page.locator('[data-tool-row]'),
    openKey: (url) => url.searchParams.get('tool'),
    rowKey: (row) => row.getAttribute('data-tool-row'),
  },
  {
    name: 'Capabilities, Skills',
    path: '/capabilities?tab=skills',
    rows: (page) => page.locator('[data-skill-row]'),
    openKey: (url) => url.searchParams.get('skill'),
    rowKey: async () => null,
    origin: E2E_BASE_URL,
  },
  {
    name: 'Reviews, Waiting',
    path: '/reviews',
    rows: (page) => page.locator('[data-review-row]'),
    openKey: (url) => url.searchParams.get('review'),
    rowKey: (row) => row.getAttribute('data-review-row'),
    prepare: listReviews,
  },
  {
    name: 'Reviews, Done',
    path: '/reviews?tab=done',
    rows: (page) => page.locator('[data-review-row]'),
    openKey: (url) => url.searchParams.get('review'),
    rowKey: (row) => row.getAttribute('data-review-row'),
    prepare: listReviews,
  },
  {
    name: 'Chat',
    path: '/chats',
    rows: (page) => page.locator('[data-chat]'),
    openKey: (url) => {
      const match = /^\/chats\/([^/]+)$/.exec(url.pathname);
      return match?.[1] === undefined || match[1] === 'new' ? null : decodeURIComponent(match[1]);
    },
    rowKey: (row) => row.getAttribute('data-chat'),
  },
];

for (const item of CASES) {
  test.describe(`${item.name} opens its first item`, () => {
    for (const width of WIDE) {
      test(`beside the list at ${width} pixels: the first row is open, named in the address, and Back leaves the page`, async ({
        page,
      }) => {
        await item.prepare?.(page);
        await page.setViewportSize({ width, height: 900 });
        await page.goto(at(BEFORE, item.origin));
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        await page.goto(at(item.path, item.origin));

        const first = item.rows(page).first();
        await expect(first).toBeVisible();
        await expect.poll(() => isSelected(first)).toBe(true);
        await expect.poll(() => item.openKey(new URL(page.url()))).not.toBeNull();
        const named = await item.rowKey(first);
        if (named !== null) expect(item.openKey(new URL(page.url()))).toBe(named);
        // One row is selected, and the detail beside it is the item, never a "Choose" placeholder.
        expect(
          await item
            .rows(page)
            .evaluateAll(
              (rows) =>
                rows.filter(
                  (row) =>
                    row.matches('[aria-current="true"]') ||
                    row.querySelector('[aria-current="true"]') !== null,
                ).length,
            ),
        ).toBe(1);
        await expect(
          page.locator('.cinder-list-detail__detail-body > .cinder-empty-state'),
        ).toHaveCount(0);

        // The open item replaced the address: Back goes to the page before.
        await page.goBack();
        await expect(page).toHaveURL((url) => url.pathname === BEFORE);
      });
    }

    test(`one pane at a time at ${PHONE} pixels: the list shows and nothing opens`, async ({
      page,
    }) => {
      await item.prepare?.(page);
      await page.setViewportSize({ width: PHONE, height: 800 });
      await page.goto(at(item.path, item.origin));
      const first = item.rows(page).first();
      await expect(first).toBeVisible();
      await expect(page.locator('.cinder-list-detail')).toHaveAttribute(
        'data-cinder-layout',
        'stacked',
      );
      expect(await isSelected(first)).toBe(false);
      expect(item.openKey(new URL(page.url()))).toBeNull();
    });
  });
}

test.describe('a deep link is never overridden', () => {
  test('a tool the address names opens, and one the catalog does not hold shows its not-found detail', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/capabilities');
    const second = page.locator('[data-tool-row]').nth(1);
    await expect(second).toBeVisible();
    const name = await second.getAttribute('data-tool-row');
    expect(name).not.toBeNull();

    await page.goto(`/capabilities?tool=${encodeURIComponent(name ?? '')}`);
    await expect.poll(() => isSelected(page.locator(`[data-tool-row="${name}"]`))).toBe(true);
    expect(new URL(page.url()).searchParams.get('tool')).toBe(name);

    await page.goto('/capabilities?tool=no-such-tool');
    await expect(page.locator('[data-tool-row]').first()).toBeVisible();
    await expect(page.locator('.cinder-list-detail__detail')).toContainText(
      CAPABILITIES_COPY.tool.page.notFound.title,
    );
    expect(new URL(page.url()).searchParams.get('tool')).toBe('no-such-tool');
  });

  test('a filter that hides the open tool opens the new first one, and one that hides every tool clears it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/capabilities');
    const rows = page.locator('[data-tool-row]');
    await expect.poll(() => isSelected(rows.first())).toBe(true);
    const firstName = await rows.first().getAttribute('data-tool-row');
    const lastName = await rows.last().getAttribute('data-tool-row');
    expect(lastName).not.toBe(firstName);
    // The name a person reads, which the filter matches.
    const lastText = await rows.last().getByTestId('tool-row-name').innerText();
    const lastHeading = lastText.trim();

    const search = page.getByRole('searchbox', { name: CAPABILITIES_COPY.filterLabel.tools });
    await search.fill(lastHeading);
    await expect
      .poll(async () => {
        const shown = await rows.first().getAttribute('data-tool-row');
        return shown !== null && new URL(page.url()).searchParams.get('tool') === shown;
      })
      .toBe(true);
    await expect.poll(() => isSelected(rows.first())).toBe(true);
    expect(new URL(page.url()).searchParams.get('tool')).not.toBe(firstName);

    await search.fill('zzzz-no-tool-matches-this');
    await expect(rows).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: CAPABILITIES_COPY.tool.filtered.clear }),
    ).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get('tool')).toBeNull();
  });
});

/** The list-and-detail pages the sweep found boxed, and the element their tabs are drawn in. */
const FLAT_PAGES = [
  { name: 'Capabilities', path: '/capabilities', underTabs: true },
  { name: 'an agent’s Memory', path: '/agents/tool-runner/memory', underTabs: true },
  // The showcase runs its workflows in process, with no fleet to list: its own host has workers.
  { name: 'Health, Workers', path: '/health/workers', underTabs: true, origin: E2E_BASE_URL },
  { name: 'Settings, Plugins', path: '/settings/plugins', underTabs: false },
] as const satisfies readonly {
  name: string;
  path: string;
  underTabs: boolean;
  origin?: string;
}[];

for (const flat of FLAT_PAGES) {
  for (const width of WIDE) {
    test(`${flat.name} draws its list and detail flat on the page, with no box, at ${width} pixels`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(at(flat.path, 'origin' in flat ? flat.origin : undefined));
      const listDetail = page.locator('.cinder-list-detail').first();
      await expect(listDetail).toBeVisible();
      await expect(listDetail).toHaveAttribute('data-cinder-layout', 'split');

      // From ListDetail up to the page's main region, nothing draws a border or rounds a corner.
      const boxes = await listDetail.evaluate((element) => {
        const found: string[] = [];
        for (
          let node: Element | null = element;
          node !== null && node.tagName !== 'MAIN';
          node = node.parentElement
        ) {
          const style = getComputedStyle(node);
          const widths = [
            style.borderTopWidth,
            style.borderRightWidth,
            style.borderBottomWidth,
            style.borderLeftWidth,
          ].map((value) => Number.parseFloat(value));
          const radius = Number.parseFloat(style.borderTopLeftRadius);
          if (widths.some((value) => value > 0) || radius > 0) {
            found.push(`${node.tagName.toLowerCase()}.${[...node.classList].join('.')}`);
          }
        }
        return found;
      });
      expect(boxes).toEqual([]);

      // Under tabs, the list starts on the tabs' own edge, not inset from it.
      const tabs = page
        .locator('main [role="tablist"]:not(.cinder-list-detail [role="tablist"])')
        .first();
      if (flat.underTabs) {
        const { tabsBox, listBox } = await readBoxes(page, { tabsBox: tabs, listBox: listDetail });
        expect(Math.abs(listBox.x - tabsBox.x)).toBeLessThanOrEqual(1);
      }
    });
  }
}
