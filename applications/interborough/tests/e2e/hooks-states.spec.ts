/**
 * The Hooks list in the states of its board (COR-2022, rows 84a-84k and 85l-85z): the sample
 * world's five hooks, nothing yet, filters that match nothing, a read in progress, a read that
 * failed with nothing to show, one that failed over hooks on screen, and a hook that gave up. The
 * page keeps its header in every one of them (`ownsStates` in `src/app/views.ts`), so each is read
 * at the header as well as the body. The showcase host holds the sample world's hooks, so a state
 * that is not that world is drawn by answering `bureau.hooks.list` differently, which is also the
 * probe the view frame makes. Each state is a named capture for the design review. The timings the
 * placeholders keep (nothing for 300 ms, a status line at 10 s) are Cinder's own and are not slept
 * here.
 *
 * Not drawn: the hook that "Can't load" (row 86e). Nothing the list carries says why a workflow hook
 * failed, so the row reads Failed until the Bureau reports it.
 */
import type { Page } from '@playwright/test';

import { SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';

test.describe('the hooks list states', () => {
  test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

  const SOURCE = 'hooks-states.spec.ts';
  const WIDTHS = [1280, 375] as const;
  const BUREAU_CALLS = '**/bureau/jsonrpc';
  const BUREAU_LOGGED = /\/bureau\/jsonrpc/;

  /** The header's "+": a secondary icon button named for what it makes. */
  const headerCreate = (page: Page) => page.locator('main .cinder-page-header__create');
  /** Every primary button on the page, which a list page keeps to the one its state offers. */
  const primaryButtons = (page: Page) => page.locator('main button[data-cinder-variant="primary"]');

  /** A hook as `bureau.hooks.list` answers it, field for field, with the newest delivery. */
  function listedHook(overrides: Record<string, unknown> = {}) {
    return {
      id: 'hook-stub',
      owner: 'anonymous:local',
      name: 'Page on-call when a run fails',
      action: { type: 'webhook', url: 'https://events.pagerduty.com/v2/enqueue' },
      events: ['schedule.failed'],
      scope: null,
      enabled: true,
      createdAt: Date.UTC(2026, 9, 21, 20),
      updatedAt: Date.UTC(2026, 9, 21, 20),
      revision: 1,
      lastDelivery: null,
      ...overrides,
    };
  }

  /** What `bureau.hooks.list` answers while the page is open: the hooks given, or a fault. */
  async function answerList(page: Page, answer: readonly unknown[] | { status: number }) {
    await page.route(BUREAU_CALLS, async (route) => {
      const body = route.request().postData() ?? '';
      if (!body.includes('"bureau.hooks.list"')) {
        await route.fallback();
        return;
      }
      if ('status' in answer) {
        await route.fulfill({ status: answer.status, json: { error: 'The server broke.' } });
        return;
      }
      const { id } = JSON.parse(body) as { id: unknown };
      await route.fulfill({ json: { jsonrpc: '2.0', id, result: { hooks: answer } } });
    });
  }

  test('lists the sample world as status-first rows, in the order drawn, with Refund audit off', async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/hooks');
    const main = page.locator('main');

    await expect(main.getByRole('heading', { level: 1, name: 'Hooks' })).toBeVisible();
    await expect(main).toContainText(
      'Run something when something happens: send a webhook, start a workflow, or notify you.',
    );
    await expect(headerCreate(page)).toHaveAccessibleName('New hook');
    await expect(headerCreate(page)).toHaveAttribute('data-cinder-variant', 'secondary');
    await expect(main.getByTestId('hooks-count')).toHaveText('5 hooks');

    const rows = main.locator('li[data-hook]');
    await expect(rows).toHaveCount(5);
    await expect(rows.locator('.cinder-stacked-list-item__title')).toHaveText([
      'Page on-call when a run fails',
      'Notify Slack when a review is waiting',
      'Tell me when triage finishes',
      'Tell me when a schedule misses',
      'Refund audit',
    ]);
    await expect(rows.nth(0)).toContainText(
      'When a run fails, send a webhook to events.pagerduty.com',
    );
    // The hook that is off leads with Off, says no time, and keeps its switch off.
    const refund = rows.nth(4);
    await expect(refund.locator('[data-status-word="Off"]')).toBeVisible();
    await expect(refund.locator('[data-last-delivery]')).toHaveCount(0);
    await expect(refund.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await expect(refund).toContainText('only for Tool runner');
    await expect(refund).not.toContainText(String.fromCodePoint(0xb7));

    await captureForDesignReview(page, { route: '/hooks', state: 'ready', source: SOURCE });
    await checkA11y('hooks list, the sample world');
  });

  for (const width of WIDTHS) {
    test(`nothing yet is the page, with no filter row and one primary New hook, at ${width} pixels`, async ({
      page,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await answerList(page, []);
      await page.goto('/hooks');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 1, name: 'Hooks' })).toBeVisible();
      await expect(main).toContainText('Run something when something happens.');
      await expect(main.getByRole('heading', { level: 2, name: 'No hooks yet' })).toBeVisible();
      await expect(main).toContainText(
        'A hook runs something when an event happens, for example sending a webhook when a run fails.',
      );
      await expect(main.getByRole('searchbox')).toHaveCount(0);
      await expect(headerCreate(page)).toHaveAccessibleName('New hook');
      await expect(primaryButtons(page)).toHaveCount(1);
      await expect(primaryButtons(page).first()).toHaveText('New hook');

      await captureForDesignReview(page, { route: '/hooks', state: 'empty', source: SOURCE });
      await checkA11y(`hooks first use at ${width}px`);
    });

    test(`filtered to nothing keeps the filter row over a Clear filters state, at ${width} pixels`, async ({
      page,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/hooks?q=Slack&event=schedule.missed');
      const main = page.locator('main');

      await expect(
        main.getByRole('heading', { level: 2, name: 'No hooks match these filters' }),
      ).toBeVisible();
      await expect(main).toContainText(
        'No hook watches that event for Slack. Try another event or search.',
      );
      await expect(main.getByRole('searchbox', { name: 'Search hooks' })).toHaveValue('Slack');
      await expect(main.locator('li[data-hook]')).toHaveCount(0);
      const state = main.locator('.cinder-empty-state');
      await expect(state).toHaveAttribute('data-cinder-kind', 'filtered');
      await expect(state.getByRole('button')).toHaveCount(1);
      await expect(primaryButtons(page)).toHaveCount(0);

      await captureForDesignReview(page, { route: '/hooks', state: 'filtered', source: SOURCE });
      await checkA11y(`hooks filtered at ${width}px`);

      await state.getByRole('button', { name: 'Clear filters' }).click();
      await expect(page).toHaveURL(/\/hooks$/);
      await expect(main.locator('li[data-hook]')).toHaveCount(5);
    });

    test(`a read in progress keeps the header and shows placeholder rows, at ${width} pixels`, async ({
      page,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(BUREAU_CALLS, async (route) => {
        if ((route.request().postData() ?? '').includes('"bureau.hooks.list"')) await held;
        await route.fallback();
      });
      await page.goto('/hooks');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 1, name: 'Hooks' })).toBeVisible();
      await expect(main).toContainText('Run something when something happens:');
      await expect(headerCreate(page)).not.toHaveAttribute('aria-disabled', 'true');
      await expect(main.locator('.cinder-skeleton-row')).toHaveCount(4);
      await expect(main.locator('li[data-hook]')).toHaveCount(0);

      await captureForDesignReview(page, { route: '/hooks', state: 'loading', source: SOURCE });
      await checkA11y(`hooks loading at ${width}px`);

      release();
      await expect(main.locator('li[data-hook]')).toHaveCount(5);
    });

    test(`a first load that failed is the error state under the header, with the plus inert, at ${width} pixels`, async ({
      page,
      checkA11y,
      pageErrors,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      pageErrors.expectEvery({
        pattern: loggedFailedResponse(500, BUREAU_LOGGED),
        reason: 'the test answers the hooks list with a 500',
      });
      await answerList(page, { status: 500 });
      await page.goto('/hooks');
      const main = page.locator('main');

      await expect(
        main.getByRole('heading', { level: 2, name: 'Couldn’t load hooks' }),
      ).toBeVisible();
      await expect(main.getByRole('heading', { level: 1, name: 'Hooks' })).toBeVisible();
      await expect(main).toContainText(
        'The server answered with an error (500). Nothing you did caused it.',
      );
      await expect(primaryButtons(page)).toHaveCount(1);
      await expect(primaryButtons(page).first()).toHaveText('Try again');
      await expect(main.getByRole('link', { name: 'Open Health' })).toBeVisible();
      await expect(headerCreate(page)).toHaveAttribute('aria-disabled', 'true');
      await expect(main.locator('li[data-hook]')).toHaveCount(0);

      await captureForDesignReview(page, { route: '/hooks', state: 'error', source: SOURCE });
      await checkA11y(`hooks failed first load at ${width}px`);

      await page.unroute(BUREAU_CALLS);
      await primaryButtons(page).first().click();
      await expect(main.locator('li[data-hook]')).toHaveCount(5);
    });

    test(`a refresh that failed over hooks on screen keeps them under a banner, with the switches held, at ${width} pixels`, async ({
      page,
      checkA11y,
      pageErrors,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      pageErrors.expectEvery({
        pattern: loggedFailedResponse(500, BUREAU_LOGGED),
        reason: 'the test answers the hooks list with a 500 once the page holds it',
      });
      await page.goto('/hooks');
      const main = page.locator('main');
      await expect(main.locator('li[data-hook]')).toHaveCount(5);

      await answerList(page, { status: 500 });
      // The person comes back to the tab, which reads the list again.
      await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
      const banner = main.getByRole('region', { name: 'Refresh problem' });
      await expect(banner).toBeVisible();
      await expect(banner).toContainText('Showing what loaded as of');
      await expect(banner.getByRole('button', { name: 'Retry now' })).toBeVisible();
      await expect(banner.getByRole('button', { name: /dismiss/i })).toHaveCount(0);
      // The rows stay at full contrast, links stay live, and what changes something is held.
      await expect(main.locator('li[data-hook]')).toHaveCount(5);
      await expect(main.locator('li[data-hook]').first()).toHaveCSS('opacity', '1');
      await expect(main.locator('li[data-hook]').first().getByRole('switch')).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await expect(headerCreate(page)).toHaveAttribute('aria-disabled', 'true');
      await expect(main.getByRole('searchbox', { name: 'Search hooks' })).toBeEnabled();

      await captureForDesignReview(page, {
        route: '/hooks',
        state: 'refresh-failed',
        source: SOURCE,
      });
      await checkA11y(`hooks failed refresh at ${width}px`);

      await page.unroute(BUREAU_CALLS);
      await banner.getByRole('button', { name: 'Retry now' }).click();
      await expect(banner).toHaveCount(0);
    });

    test(`a hook that gave up sorts first and reads Gave up in red, at ${width} pixels`, async ({
      page,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const quiet = listedHook({
        id: 'hook-quiet',
        name: 'Tell me when a schedule misses',
        events: ['schedule.missed'],
        action: { type: 'notify', title: null },
        lastDelivery: {
          id: 'delivery-quiet',
          kind: 'schedule.missed',
          test: false,
          status: 'delivered',
          lastAttempt: null,
          createdAt: Date.UTC(2026, 10, 2, 15),
          updatedAt: Date.UTC(2026, 10, 2, 15),
        },
      });
      const gaveUp = listedHook({
        id: 'hook-gave-up',
        lastDelivery: {
          id: 'delivery-gave-up',
          kind: 'schedule.failed',
          test: false,
          status: 'exhausted',
          lastAttempt: {
            number: 5,
            startedAt: Date.UTC(2026, 9, 30, 15),
            finishedAt: Date.UTC(2026, 9, 30, 15),
            outcome: 'response',
            status: 410,
            error: null,
          },
          createdAt: Date.UTC(2026, 9, 30, 15),
          updatedAt: Date.UTC(2026, 9, 30, 15),
        },
      });
      await answerList(page, [quiet, gaveUp]);
      await page.goto('/hooks');
      const main = page.locator('main');

      const rows = main.locator('li[data-hook]');
      await expect(rows).toHaveCount(2);
      await expect(rows.first()).toHaveAttribute('data-hook', 'hook-gave-up');
      await expect(rows.first().locator('[data-status-word="Gave up"]')).toBeVisible();
      await expect(rows.first()).toContainText(
        'When a run fails, send a webhook to events.pagerduty.com',
      );

      await captureForDesignReview(page, { route: '/hooks', state: 'gave up', source: SOURCE });
      await checkA11y(`hooks with a hook that gave up at ${width}px`);
    });
  }

  test('a very long webhook address ends line two at two lines and keeps the whole of it in the tooltip', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    const url = `https://events.example.com/v2/enqueue?token=${'t'.repeat(300)}`;
    await answerList(page, [
      listedHook({
        id: 'hook-long',
        name: 'Send a webhook to a very long address',
        action: { type: 'webhook', url },
        events: ['schedule.failed'],
      }),
    ]);
    await page.goto('/hooks');
    const row = page.locator('main li[data-hook="hook-long"]');

    await expect(row).toBeVisible();
    await expect(row.locator(`[title*="${url}"]`).first()).toBeAttached();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      375,
    );

    await captureForDesignReview(page, { route: '/hooks', state: 'long address', source: SOURCE });
  });
});
