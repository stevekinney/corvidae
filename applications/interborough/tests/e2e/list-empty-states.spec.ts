/**
 * One empty state for every list page (owner report, 2026-11-19): each list in the sidebar, with
 * nothing in it, keeps its page header and its labelled create action, and shows one Cinder
 * `EmptyState` in the `page` layout under it, top-aligned at the same offset on every page, in no
 * box, with the page's own sidebar icon, buttons rather than text links, plain words, and no count,
 * search, filter or segments over nothing. Each is read at 1280 and 375 pixels in both themes, and
 * captured for the design review.
 *
 * The showcase host holds the sample world, so every list is emptied by rewriting what the host
 * answers: each Bureau `*.list` result (and the catalog's tools) loses its items, the engine's
 * schedules are none, and the workflows the Bureau lists keep only the code types, so what remains is
 * the types Interborough runs itself (as `26-workflows.spec.ts` does).
 */
import type { Page, Route } from '@playwright/test';

import { SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { DESTINATIONS } from '../../src/app/shell/destinations.ts';
import type { ViewName } from '../../src/app/views.ts';
import { isBureauCall } from './bureau-answer-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'list-empty-states.spec.ts';
const WIDTHS = [1280, 375] as const;
const THEMES = ['light', 'dark'] as const;

/** Every list page in the sidebar and its create action; Reviews and Checks make nothing. */
const LIST_PAGES: readonly { view: ViewName; path: string; create: string | null }[] = [
  { view: 'chat', path: '/chats', create: 'New chat' },
  { view: 'reviews', path: '/reviews', create: null },
  { view: 'runs', path: '/runs', create: 'Start run' },
  { view: 'checks', path: '/checks', create: null },
  { view: 'agents', path: '/agents', create: 'New agent' },
  { view: 'workflows', path: '/workflows', create: 'New workflow' },
  { view: 'schedules', path: '/schedules', create: 'New schedule' },
  { view: 'goals', path: '/goals', create: 'New goal' },
  { view: 'capabilities', path: '/capabilities', create: 'Connect tools' },
  { view: 'hooks', path: '/hooks', create: 'New hook' },
];

type JsonRecord = Record<string, unknown>;

/** A list result with its items taken out: every array empty and no further page. */
function emptied(result: JsonRecord, method: string): JsonRecord {
  const next: JsonRecord = {};
  for (const [key, value] of Object.entries(result)) {
    if (method === 'bureau.workflows.list' && key === 'workflows' && Array.isArray(value)) {
      next[key] = value.filter(
        (entry) => typeof entry === 'object' && entry !== null && 'kind' in entry,
      );
    } else if (method === 'bureau.agents.catalog') {
      next[key] = key === 'tools' ? [] : value;
    } else {
      next[key] = Array.isArray(value) ? [] : value;
    }
  }
  if ('nextOffset' in next) next['nextOffset'] = null;
  if ('nextCursor' in next) next['nextCursor'] = null;
  if ('nextPageToken' in next) next['nextPageToken'] = null;
  if ('total' in next) next['total'] = 0;
  return next;
}

/** Makes every list the host answers empty. */
async function emptyEveryList(page: Page): Promise<void> {
  await page.route(isBureauCall, async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { method?: string };
    const method = body.method ?? '';
    if (
      !method.startsWith('bureau.') ||
      !(method.endsWith('.list') || method.endsWith('.catalog'))
    ) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const answer = (await response.json()) as { result?: JsonRecord };
    if (answer.result === undefined) {
      await route.fulfill({ response });
      return;
    }
    await route.fulfill({ response, json: { ...answer, result: emptied(answer.result, method) } });
  });
  await page.route(/\/v1\/schedules(\?|$)/, (route) =>
    route.fulfill({ json: { items: [], total: 0 } }),
  );
}

/** The lucide name of an icon, such as `lucide-target`. */
async function iconName(page: Page, selector: string): Promise<string | undefined> {
  const classes = await page.locator(selector).first().getAttribute('class');
  return (classes ?? '')
    .split(/\s+/)
    .find((name) => name.startsWith('lucide-') && name !== 'lucide-icon');
}

test('walks every list in the sidebar', () => {
  const lists = DESTINATIONS.map((destination) => destination.view).filter(
    (view) => view !== 'home' && view !== 'health' && view !== 'settings',
  );
  expect(LIST_PAGES.map((list) => list.view).toSorted()).toEqual(lists.toSorted());
});

for (const width of WIDTHS) {
  for (const theme of THEMES) {
    test(`every list page's empty state is the one pattern, at ${String(width)} pixels, ${theme}`, async ({
      page,
      checkA11y,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await emptyEveryList(page);
      /** How far below its page header each list's state starts. */
      const offsets = new Map<string, number>();

      for (const list of LIST_PAGES) {
        await page.goto(list.path);
        const main = page.locator('main');
        const state = main.locator(`[data-list-empty="${list.view}"]`);
        await expect(state, `${list.path} shows its empty state`).toBeVisible();

        // The header stays, with its create action as a labelled primary button.
        await expect(main.getByRole('heading', { level: 1 })).toHaveCount(1);
        if (list.create !== null) {
          const header =
            list.view === 'chat'
              ? main.locator('.ib-chats__title')
              : main.locator('.cinder-page-header');
          const create = header.locator('.cinder-button').filter({ hasText: list.create });
          await expect(create).toBeVisible();
          await expect(create).toHaveAttribute('data-cinder-variant', 'primary');
          await expect(create).not.toHaveAttribute('data-cinder-icon-only', /.*/);
        }

        // One state in the page layout, in no box, with the sidebar's icon for the page.
        await expect(main.locator('.cinder-empty-state')).toHaveCount(1);
        await expect(state).toHaveAttribute('data-cinder-layout', 'page');
        await expect(state).not.toHaveAttribute('data-cinder-bordered', /.*/);
        const border = await state.evaluate((element) => {
          for (let node: Element | null = element; node !== null; node = node.parentElement) {
            if (node.tagName === 'MAIN') return 'none';
            const style = getComputedStyle(node);
            if (style.borderTopStyle !== 'none' && Number.parseFloat(style.borderTopWidth) > 0) {
              return node.className;
            }
          }
          return 'none';
        });
        expect(border, `${list.path}: nothing around the state draws a border`).toBe('none');
        const navigation = await iconName(
          page,
          `nav a[href="${DESTINATIONS.find((entry) => entry.view === list.view)?.path ?? ''}"] svg`,
        );
        if (navigation !== undefined) {
          expect(
            await iconName(page, `[data-list-empty="${list.view}"] .cinder-empty-state-icon svg`),
          ).toBe(navigation);
        }

        // The words hold a reading measure, and say nothing of paths or tool ids.
        const description = state.locator('.cinder-empty-state-description');
        const measure = await description.evaluate((element) => {
          const style = getComputedStyle(element);
          const probe = document.createElement('span');
          probe.style.font = style.font;
          probe.textContent = '0';
          document.body.append(probe);
          const zero = probe.getBoundingClientRect().width;
          probe.remove();
          return element.getBoundingClientRect().width / zero;
        });
        expect(measure, `${list.path}: the sentence holds about 60 characters`).toBeLessThanOrEqual(
          61,
        );
        const words = (await state.textContent()) ?? '';
        expect(words).not.toMatch(/(^|\s)[~.]?\/\w/);
        expect(words).not.toContain('bureau:');

        // Buttons, never text links, and no controls over nothing.
        await expect(state.locator('a:not(.cinder-button)')).toHaveCount(0);
        await expect(main.locator('.cinder-filter-bar')).toHaveCount(0);
        await expect(main.getByRole('searchbox')).toHaveCount(0);
        await expect(main.locator('.cinder-segmented-control')).toHaveCount(0);

        // Chat's list is a pane with its own header, and Capabilities has its tabs under the header.
        if (list.view !== 'chat' && list.view !== 'capabilities') {
          const headerBox = await main.locator('.cinder-page-header').first().boundingBox();
          const stateBox = await state.boundingBox();
          if (headerBox !== null && stateBox !== null) {
            offsets.set(list.path, Math.round(stateBox.y - (headerBox.y + headerBox.height)));
          }
        }

        await captureForDesignReview(page, {
          route: list.path,
          state: `empty (${theme})`,
          source: SOURCE,
        });
        await checkA11y(`${list.path} empty at ${String(width)}px, ${theme}`);
      }

      // Top-aligned at one offset under the header on every page.
      const distinct = new Set(offsets.values());
      expect(
        distinct.size,
        `every state starts as far under its header: ${JSON.stringify([...offsets])}`,
      ).toBe(1);
    });
  }
}
