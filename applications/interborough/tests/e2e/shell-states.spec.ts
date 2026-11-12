/**
 * The shell's two page-level dead ends on the sample world (`fixtures/sample-world-seed.ts`, the
 * showcase host; COR-2015, design rows 12x, 12y, 12z, 13a): the not-found page for a run that does
 * not exist, with Runs › Not found for its breadcrumb and its two secondary buttons, and the
 * forbidden page for Hooks, with the scope it needs and its two secondary buttons. They are read on
 * the showcase host so that `bun scripts/design-review-capture.ts --data showcase` captures them
 * without the stress data; the same states on the stress host are in `15-view-states.spec.ts`.
 * Each is captured at 1280 and 375 pixels under its own name.
 */
import type { Page } from '@playwright/test';

import { SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { VIEW_COPY } from '../../src/app/copy/view-pages.ts';
import { FORBIDDEN_COPY, NOT_FOUND_COPY } from '../../src/app/copy/views.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, holdBureauFeed, loggedFailedResponse, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'shell-states.spec.ts';
const WIDTHS = [1280, 375] as const;

async function captureAt(page: Page, width: number, route: string, state: string): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await captureForDesignReview(page, { route, state, source: SOURCE });
}

for (const width of WIDTHS) {
  test(`a run that does not exist is the not-found page: a search glyph, the title that names it, two secondary buttons and Runs › Not found, at ${width} pixels`, async ({
    page,
    pageErrors,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    pageErrors.expectEvery({
      pattern: loggedFailedResponse(404, /\/v1\/workflows\/no-such-run/),
      reason: 'the engine has no run called no-such-run',
    });
    await page.goto('/runs/no-such-run');

    // A run the engine does not know is the page's own empty state, not the route's not-found view.
    const frame = page.locator('main');
    await expect(frame.getByRole('heading', { level: 1 })).toHaveText('This run doesn’t exist');
    await expect(frame).toContainText(NOT_FOUND_COPY.description);
    // Row 12y: two secondary buttons and no primary one.
    const actions = frame.locator('.cinder-empty-state-action > *');
    await expect(actions).toHaveText(['Back to Runs', 'Search everything']);
    await expect(frame.locator('[data-cinder-variant="primary"]')).toHaveCount(0);
    // Row 12x: the neutral disc holds a search glyph, and the breadcrumb is in words.
    await expect(frame.locator('.cinder-empty-state svg.lucide-search')).toBeVisible();
    await expect(page.locator('header.weft-shell-topbar')).toContainText('Not found');
    // Row 04f: the parent keeps its whole word while the current page, which gives way first,
    // truncates; "Runs" never reads "Ru…" because a fraction of a pixel was taken from it.
    const parentCrumb = page.locator(
      width < 768 ? '.cinder-breadcrumbs__back-label' : '.cinder-breadcrumbs__link',
    );
    await expect(parentCrumb).toHaveText('Runs');
    expect(
      await parentCrumb.evaluate((element) => element.scrollWidth - element.clientWidth),
      'the parent crumb is not truncated',
    ).toBeLessThanOrEqual(0);
    await captureAt(page, width, '/runs/no-such-run', 'not-found');
  });

  test(`Hooks the sign-in cannot read is the forbidden page: a lock glyph, the title, the scope it needs and two secondary buttons, at ${width} pixels`, async ({
    page,
    pageErrors,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await holdBureauFeed(page);
    pageErrors.expectEvery({
      pattern: loggedFailedResponse(403, /\/bureau\/jsonrpc/),
      reason: 'the test answers the hooks probe with a 403',
    });
    await page.route('**/bureau/jsonrpc', async (route) => {
      if ((route.request().postData() ?? '').includes('"bureau.hooks.list"')) {
        await route.fulfill({ status: 403, json: { error: 'Forbidden' } });
        return;
      }
      await route.fallback();
    });
    await page.goto('/hooks');

    const frame = page.locator('[data-view="hooks"]');
    await expect(frame).toHaveAttribute('data-state', 'forbidden');
    await expect(frame.getByRole('heading', { level: 1 })).toHaveText(
      FORBIDDEN_COPY.title('Hooks'),
    );
    await expect(frame).toContainText(FORBIDDEN_COPY.description);
    // The scope is named as a person reads it, without the Bureau's `bureau.` prefix
    // (`forbidden-state.svelte`): the copy holds `bureau.hooks:read`, and the page says `hooks:read`.
    expect(VIEW_COPY.hooks.forbidden?.requirement).toBe('bureau.hooks:read');
    await expect(frame).toContainText('requires hooks:read');
    await expect(frame).not.toContainText('bureau.');
    // Row 13a: See your scopes and Back to Home, both secondary, and nothing that asks for access.
    await expect(frame.getByRole('link', { name: 'See your scopes' })).toBeVisible();
    await expect(frame.getByRole('link', { name: 'Back to Home' })).toBeVisible();
    await expect(frame.locator('[data-cinder-variant="primary"]')).toHaveCount(0);
    await expect(frame.getByRole('button', { name: /request access/i })).toHaveCount(0);
    // Row 12z: the gate's content is centred in the outlet like the not-found page, not drawn at its top.
    await expect
      .poll(
        async () => {
          const outlet = await page.locator('main.weft-shell-outlet').boundingBox();
          const gate = await frame.getByRole('heading', { level: 1 }).boundingBox();
          return (gate?.y ?? 0) - (outlet?.y ?? 0);
        },
        { message: 'the space above the title' },
      )
      .toBeGreaterThan(100);
    await captureAt(page, width, '/hooks', 'forbidden');
  });
}
