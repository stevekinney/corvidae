/**
 * One empty state for every list page (owner report, 2026-11-19): each list in the sidebar, with
 * nothing in it, keeps its page header and its labelled create action, and shows one Cinder
 * `EmptyState` in the `page` layout under it, top-aligned at the same offset on every page, in no
 * box, with the page's own sidebar icon, buttons rather than text links, plain words held to about
 * 60 characters, and no count, search, filter or segments over nothing. Each page is read at 1920,
 * 1280, 768 and 375 pixels in both themes and captured for the design review; one more case per
 * width and theme measures the offset under the header across the pages. `src/app/list-page-empty.test.ts`
 * walks the same pages in-process and holds the list to the sidebar's.
 *
 * Every list is emptied by rewriting what the host answers: each Bureau `*.list` result (and the
 * catalog's tools) loses its items, and the engine's schedules are none. Workflows are read on the
 * host whose console is the Bureau's own engine, keeping only the code types the Bureau lists, so
 * what remains is the types Interborough runs itself (as `26-workflows.spec.ts` does).
 */
import type { Page, Route } from '@playwright/test';

import { SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { designReviewColorScheme } from '../../scripts/environment-configuration.ts';
import { CHAT_COPY } from '../../src/app/copy/chat.ts';
import { isBureauCall } from './bureau-answer-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_BUREAU_URL, E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { readBoxes } from './read-boxes.ts';

const SOURCE = 'list-empty-states.spec.ts';
const WIDTHS = [1920, 1280, 768, 375] as const;
const THEMES = ['light', 'dark'] as const;
/** The narrowest width at which the sidebar, and so its icons, is on screen. */
const SIDEBAR_WIDTH = 1024;

interface ListPage {
  readonly path: string;
  /** The view's name, as the empty state's `data-list-empty` says it. */
  readonly view: string;
  /** The header's create action, or `null` for a list that makes nothing (Reviews, Checks). */
  readonly create: string | null;
  /** The host the page is read on. */
  readonly host: string;
}

const LIST_PAGES: readonly ListPage[] = [
  { path: '/chats', view: 'chat', create: 'New chat', host: E2E_SHOWCASE_URL },
  { path: '/reviews', view: 'reviews', create: null, host: E2E_SHOWCASE_URL },
  { path: '/runs', view: 'runs', create: 'Start run', host: E2E_SHOWCASE_URL },
  { path: '/checks', view: 'checks', create: null, host: E2E_SHOWCASE_URL },
  { path: '/agents', view: 'agents', create: 'New agent', host: E2E_SHOWCASE_URL },
  {
    path: '/workflows',
    view: 'workflows',
    create: 'New workflow',
    host: E2E_BUREAU_URL,
  },
  {
    path: '/schedules',
    view: 'schedules',
    create: 'New schedule',
    host: E2E_SHOWCASE_URL,
  },
  { path: '/goals', view: 'goals', create: 'New goal', host: E2E_SHOWCASE_URL },
  {
    path: '/capabilities',
    view: 'capabilities',
    create: 'Connect tools',
    host: E2E_SHOWCASE_URL,
  },
  { path: '/hooks', view: 'hooks', create: 'New hook', host: E2E_SHOWCASE_URL },
];

type JsonRecord = Record<string, unknown>;

/** A list result with its items taken out: every array empty and no further page. */
function emptied(result: JsonRecord, method: string): JsonRecord {
  const next: JsonRecord = {};
  for (const [key, value] of Object.entries(result)) {
    if (method === 'bureau.workflows.list' && key === 'workflows' && Array.isArray(value)) {
      // The code workflows plugins contributed stay: the page leaves them out of its rows.
      next[key] = value.filter(
        (entry) =>
          typeof entry === 'object' && entry !== null && Reflect.get(entry, 'kind') === 'code',
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
    const lists = method.endsWith('.list') || method === 'bureau.agents.catalog';
    if (!method.startsWith('bureau.') || !lists) {
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

/** Opens `list` with nothing in it, at `width` in `theme`, and answers its empty state. */
async function openEmpty(
  page: Page,
  list: ListPage,
  width: number,
  theme: 'light' | 'dark',
): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await page.setViewportSize({ width, height: width === 1920 ? 1080 : 900 });
  await emptyEveryList(page);
  await page.goto(new URL(list.path, list.host).toString());
  await expect(page.locator(`main [data-list-empty="${list.view}"]`)).toBeVisible();
}

/** The lucide name of the first icon `selector` matches, such as `lucide-target`. */
async function iconName(page: Page, selector: string): Promise<string | undefined> {
  const icon = page.locator(selector).first();
  if ((await icon.count()) === 0) return undefined;
  const classes = (await icon.getAttribute('class')) ?? '';
  return classes.split(/\s+/).find((name) => name.startsWith('lucide-') && name !== 'lucide-icon');
}

test.use({ timezoneId: SAMPLE_TIME_ZONE });

for (const list of LIST_PAGES) {
  for (const width of WIDTHS) {
    for (const theme of THEMES) {
      test(`${list.path} with nothing in it is the one list-page empty state, at ${String(width)} pixels, ${theme}`, async ({
        page,
        checkA11y,
      }) => {
        const captureScheme = designReviewColorScheme();
        test.skip(
          captureScheme !== undefined && captureScheme !== theme,
          'Captured in the other theme run',
        );
        await openEmpty(page, list, width, theme);
        const main = page.locator('main');
        const state = main.locator(`[data-list-empty="${list.view}"]`);

        // The header stays, with its create action as a labelled primary button.
        await expect(main.getByRole('heading', { level: 1 })).toHaveCount(1);
        if (list.create !== null) {
          const header = main.locator('.cinder-page-header');
          const create = header.locator('.cinder-button').filter({ hasText: list.create });
          await expect(create).toBeVisible();
          await expect(create).toHaveText(list.create);
          await expect(create).toHaveAttribute('data-cinder-variant', 'primary');
          await expect(create).not.toHaveAttribute('data-cinder-icon-only', /.*/);
        }
        if (list.view === 'chat') {
          await expect(main.locator('.cinder-page-header')).toContainText(
            CHAT_COPY.list.description,
          );
          await expect(main.getByRole('region', { name: 'Open chat' })).toHaveCount(0);
          const { outlet, action } = await readBoxes(page, {
            outlet: main,
            action: state.getByRole('link', { name: CHAT_COPY.newChat }),
          });
          expect(outlet.x + outlet.width - (action.x + action.width)).toBeGreaterThanOrEqual(12);
        }
        if (list.view === 'capabilities') {
          await expect(main.getByTestId('tab-count-tools')).toHaveCount(0);
          await expect(main.getByTestId('tab-count-skills')).toHaveCount(0);
        }

        // One state in Cinder's one layout, with nothing around it drawing a border.
        await expect(main.locator('.cinder-empty-state')).toHaveCount(1);
        await expect(state).not.toHaveAttribute('data-cinder-layout', /.*/);
        await expect(state).not.toHaveAttribute('data-cinder-bordered', /.*/);
        const bordered = await state.evaluate((element) => {
          for (let node: Element | null = element; node !== null; node = node.parentElement) {
            if (node.tagName === 'MAIN') return null;
            const style = getComputedStyle(node);
            if (style.borderTopStyle !== 'none' && Number.parseFloat(style.borderTopWidth) > 0) {
              return node.className;
            }
          }
          return null;
        });
        expect(bordered, 'nothing around the state draws a border').toBeNull();

        // The page's own icon, the one its sidebar item shows, where the sidebar is on screen.
        if (width >= SIDEBAR_WIDTH) {
          const navigation = await iconName(page, `nav a[href="${list.path}"] svg`);
          expect(navigation, 'the sidebar item has an icon').toBeDefined();
          expect(
            await iconName(page, `[data-list-empty="${list.view}"] .cinder-empty-state-icon svg`),
          ).toBe(navigation);
        }

        // The sentence holds a reading measure, and the words say nothing of paths or tool ids.
        const characters = await state
          .locator('.cinder-empty-state-description')
          .evaluate((element) => {
            const probe = document.createElement('span');
            probe.style.font = getComputedStyle(element).font;
            probe.textContent = '0';
            document.body.append(probe);
            const zero = probe.getBoundingClientRect().width;
            probe.remove();
            return element.getBoundingClientRect().width / zero;
          });
        expect(characters, 'the sentence holds about 60 characters').toBeLessThanOrEqual(61);
        const words = (await state.textContent()) ?? '';
        expect(words).not.toMatch(/(^|\s)[~.]?\/\w/);
        expect(words).not.toContain('bureau:');

        // Buttons, never text links, and no controls over nothing.
        await expect(state.locator('a:not(.cinder-button)')).toHaveCount(0);
        await expect(main.locator('.cinder-filter-bar')).toHaveCount(0);
        await expect(main.getByRole('searchbox')).toHaveCount(0);
        await expect(main.locator('.cinder-segmented-control')).toHaveCount(0);

        await captureForDesignReview(page, {
          route: list.path,
          state: 'first-use list',
          source: SOURCE,
        });
        await checkA11y(`${list.path} empty at ${String(width)}px, ${theme}`);
      });
    }
  }
}

for (const width of WIDTHS) {
  for (const theme of THEMES) {
    test(`every list's empty state starts the same distance under its header, at ${String(width)} pixels, ${theme}`, async ({
      page,
    }) => {
      for (const list of LIST_PAGES) {
        await openEmpty(page, list, width, theme);
        // Reviews learns that both lists are empty before it removes the filters.
        await expect(page.locator('main .cinder-filter-bar')).toHaveCount(0);
        const header =
          list.view === 'capabilities'
            ? page.getByRole('tablist')
            : page.locator('main .cinder-page-header').first();
        const state = page.locator(`main [data-list-empty="${list.view}"]`);
        await expect
          .poll(
            async () => {
              const boxes = await readBoxes(page, { header, state });
              return Math.round(boxes.state.y - (boxes.header.y + boxes.header.height));
            },
            { message: `${list.path} shares the list header spacing` },
          )
          .toBe(16);
      }
    });
  }
}
