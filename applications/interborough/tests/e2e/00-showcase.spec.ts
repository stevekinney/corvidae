/**
 * Every route in the route table, and the states the sample world gives a few of them, at 375, 768
 * and 1280 pixels, holding the sample world (`fixtures/sample-world-seed.ts`, which the end-to-end
 * server seeds before the showcase host listens) instead of the stress seed's 300-character words
 * (`responsive.spec.ts`). The design review (`.agents/skills/design-review`) captures these screens
 * for layout, hierarchy and density.
 *
 * The specification reads the sample world's identifiers once, opens each address, waits until the
 * page's frame is `ready` and the outlet has stopped changing, asserts no frame is `empty`, and
 * captures the page (`design-review-capture.ts`) when a capture directory is set.
 *
 * The file is named `00-` because Playwright runs files in name order and this one must run first:
 * the specifications that follow write to the same showcase host (they delete storage keys, start
 * runs, change schedules), and every one of those writes is a record the pages read back. Run last,
 * this sweep drew the audit log under eleven "Deleted a storage key" rows the storage specification
 * had left, in the capture a reviewer reads as the page's `ready` state.
 */
import type { Page } from '@playwright/test';

import { readSampleWorldRecords } from '../../fixtures/sample-world-records.ts';
import { designReviewCaptureDirectory } from '../../scripts/environment-configuration.ts';
import { routes } from '../../src/app/routes.ts';
import { connectProviderWithModels } from './chat-states-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_BASE_URL, E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, goOffline, test } from './fixtures.ts';
import { readBoxes } from './read-boxes.ts';
import { listEngineReviews } from './review-support.ts';
import {
  SHOWCASE_ROUTES_WITHOUT_CONTENT,
  showcaseAddresses,
  showcaseVariantNames,
  showcaseVariants,
} from './showcase-routes.ts';

/**
 * The widths each route is held at, widest first (owner, 2026-11-19: review leads with 1280 and
 * 1920, then 768 and 375). A design-review capture adds 1920, the wide desktop the owner reads
 * first; the suite itself keeps its three.
 */
const WIDTHS: readonly number[] =
  designReviewCaptureDirectory() === undefined ? [1280, 768, 375] : [1280, 1920, 768, 375];
const HEIGHT = 900;

/**
 * The routes `responsive.spec.ts` also captures with the stress seed under the state `ready`: the
 * sample world's captures of them are named `sample world`, so neither overwrites the other.
 */
const SAMPLE_WORLD_STATE_ROUTES: ReadonlySet<string> = new Set([
  '/runs',
  '/runs/:run',
  '/goals',
  '/goals/:goal',
  '/goals/new',
]);

let addresses: Readonly<Record<string, string>>;

/** Waits until the outlet's text and busy state have stopped changing for three reads in a row. */
async function untilQuiet(page: Page): Promise<void> {
  const outlet = page.locator('main.weft-shell-outlet');
  let previous = '';
  let streak = 0;
  await expect
    .poll(
      async () => {
        const text = await outlet.innerText();
        const busy = await outlet.locator('[aria-busy="true"]').count();
        const signature = `${busy}:${text.length}`;
        streak = signature === previous && busy === 0 ? streak + 1 : 0;
        previous = signature;
        return streak;
      },
      { intervals: [150] },
    )
    .toBeGreaterThanOrEqual(3);
}

/**
 * The refund showcase opens on a waiting approval. A design-review capture repeats its 375px view
 * at 320px with coarse-pointer emulation, which changes the header after the first layout frame.
 * Wait for Chat's arrival rule itself here, rather than taking a frame-delay screenshot while the
 * approval's tool target is still under that header.
 */
async function readyBlockedRefundApprovalCapture(page: Page): Promise<void> {
  if ((await page.evaluate(() => window.innerWidth)) !== 320) return;
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const transcript = document.querySelector<HTMLElement>('.chat-timeline');
        const approval = document.querySelector<HTMLElement>('[data-approval-decision]');
        const tool = approval
          ?.closest<HTMLElement>('.cinder-tool-call-rail__item')
          ?.querySelector<HTMLElement>('[data-cinder-tool-call-row]');
        const question = approval?.querySelector<HTMLElement>(
          '.cinder-approval-card__row-question, .cinder-approval-card__decision-title',
        );
        const actions = [...(approval?.querySelectorAll<HTMLButtonElement>('button') ?? [])].filter(
          (button) => ['Deny', 'Approve'].includes(button.textContent?.trim() ?? ''),
        );
        if (transcript === null || approval === null || tool === null || question === null)
          return false;
        if (
          actions.length !== 2 ||
          document.querySelector('[data-chat-approval-drawer]') !== null
        ) {
          return false;
        }
        const reaches = (element: HTMLElement, x: number, y: number) => {
          const hit = document.elementFromPoint(x, y);
          return hit !== null && element.contains(hit);
        };
        const withinTranscript = (element: HTMLElement) => {
          const box = element.getBoundingClientRect();
          const bounds = transcript.getBoundingClientRect();
          return box.top >= bounds.top && box.bottom <= bounds.bottom;
        };
        const toolBox = tool.getBoundingClientRect();
        const inset = 1;
        const toolCorners = [
          [toolBox.left + inset, toolBox.top + inset],
          [toolBox.right - inset, toolBox.top + inset],
          [toolBox.left + inset, toolBox.bottom - inset],
          [toolBox.right - inset, toolBox.bottom - inset],
        ];
        return (
          withinTranscript(question) &&
          actions.every(
            (action) =>
              withinTranscript(action) &&
              reaches(
                action,
                action.getBoundingClientRect().x + action.getBoundingClientRect().width / 2,
                action.getBoundingClientRect().y + action.getBoundingClientRect().height / 2,
              ),
          ) &&
          toolCorners.every(([x, y]) => reaches(tool, x, y))
        );
      }),
    )
    .toBe(true);
}

test.beforeAll(async () => {
  const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
  addresses = { ...showcaseAddresses(world), ...showcaseVariants(world) };
});

test('gives every route in the table an address', () => {
  const patterns = routes.filter((route) => route.redirect === undefined).map((r) => r.pattern);
  for (const pattern of patterns) expect(addresses, pattern).toHaveProperty([pattern]);
});

const NAMES = [
  ...routes.filter((route) => route.redirect === undefined).map((route) => route.pattern),
  ...showcaseVariantNames(),
].filter((name) => !SHOWCASE_ROUTES_WITHOUT_CONTENT.includes(name));

for (const name of NAMES) {
  test(`${name} holds believable content at ${WIDTHS.join(', ')} pixels`, async ({ page }) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: HEIGHT });
      // A pending question docks only when the conversation can continue. The sample showcase
      // otherwise intentionally has no provider configured, which is a different blocked state.
      if (name === '/chats/:chat (question waiting)') await connectProviderWithModels(page);
      await page.goto(`${E2E_SHOWCASE_URL}${addresses[name]}`);
      const outlet = page.locator('main.weft-shell-outlet');
      await expect(outlet).toBeVisible();
      const frame = outlet.locator('[data-view]').first();
      await expect(frame, `${name} at ${width}px`).toHaveAttribute('data-state', 'ready');
      await untilQuiet(page);
      await expect(frame, `${name} at ${width}px stays ready`).toHaveAttribute(
        'data-state',
        'ready',
      );
      await captureForDesignReview(page, {
        route: name,
        // `responsive.spec.ts` writes `<route>--ready--…` for the stress seed's pages, so a route it
        // also captures has its own state name here and the two captures never overwrite each other.
        state: SAMPLE_WORLD_STATE_ROUTES.has(name) ? 'sample world' : 'ready',
        source: '00-showcase.spec.ts',
        ...(name === '/chats/:chat' ? { ready: readyBlockedRefundApprovalCapture } : {}),
      });

      // COR-2014 row 17s is a transient state: hold a choice, capture its inline Undo affordance,
      // then undo before the answer reaches the fixture host so the shared sample world is unchanged.
      if (
        name === '/chats/:chat (question waiting)' &&
        (width === 320 || width === 375 || width === 1280)
      ) {
        const toolRow = page.locator('[data-cinder-tool-call-row]').filter({
          hasText: 'Request human input',
        });
        await expect(toolRow).toContainText('Question asked');
        await expect(toolRow).not.toContainText('Signal name');
        const staging = page.getByRole('radio', { name: /^Staging\b/, exact: false });
        await expect(staging).toBeVisible();
        // The configured-provider fixture makes a pending host question replace the composer
        // instead of falling back to the blocked-provider inline presentation.
        await expect(page.locator('[data-chat-question-dock="host"]')).toBeVisible();
        // The text before the question is the agent talking to the person (owner decision of
        // 14 November): it keeps its time, and is drawn in message ink, not as bare narration.
        const preface = page
          .locator('.chat-message-wrapper[data-asking]')
          .filter({ hasText: 'Before I ship it I need one answer.' });
        await expect(preface, `the asking text at ${width}px`).toBeVisible();
        await expect(preface.locator('.chat-message-line time')).toBeVisible();
        await staging.click();
        const heldStatus = page.locator('.chat-question-status[data-state="held"]');
        await expect(heldStatus).toBeVisible();
        await expect(staging).toHaveAttribute('aria-checked', 'true');
        const undo = page.getByRole('button', { name: /Undo/ });
        await expect(undo).toBeVisible();
        await captureForDesignReview(page, {
          route: name,
          state: 'answer-undo',
          source: 'showcase.spec.ts',
        });
        await undo.click();
        await expect(heldStatus).toHaveCount(0);
        await expect(page.locator('.chat-question-status[data-state="sent"]')).toHaveCount(0);
        await expect(staging).toBeVisible();
        await expect(staging).toHaveAttribute('aria-checked', 'false');
        if (width === 375) {
          await page.setViewportSize({ width: 320, height: 640 });
          await expect(page.locator('[data-chat-question-dock="host"]')).toBeVisible();
          await expect(staging).toBeVisible();
        }
      }
    }
  });
}

/** The Runs list's open Workflow menu and its full list after Load more, on the sample world (COR-2423, rows 10h, 53l, S68). */
for (const width of WIDTHS) {
  test(`/runs shows the Workflow menu open and the whole list after Load more, at ${width} pixels`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: HEIGHT });
    await page.goto(`${E2E_SHOWCASE_URL}${addresses['/runs']}`);
    const frame = page.locator('main.weft-shell-outlet [data-view]').first();
    await expect(frame).toHaveAttribute('data-state', 'ready');
    await untilQuiet(page);

    const more = page.getByRole('button', { name: 'Load more' });
    while ((await more.count()) > 0) {
      const before = await page.locator('main li[data-run]').count();
      await more.first().click();
      await expect(async () => {
        expect(await page.locator('main li[data-run]').count()).toBeGreaterThan(before);
      }).toPass();
    }
    await untilQuiet(page);
    await captureForDesignReview(page, {
      route: '/runs',
      state: 'load more pressed',
      source: '00-showcase.spec.ts',
    });

    // On a phone the chips fold into the Filter menu (05t), where Workflow is a row that opens its
    // options; on a wider screen Workflow is a chip of its own.
    const filterMenu = page.getByRole('button', { name: /^Filter/ });
    if (width === 375) {
      await filterMenu.click();
      await page
        .locator('.cinder-filter-bar__menu')
        .getByRole('button', { name: /^Workflow/ })
        .click();
    } else {
      await page.getByRole('button', { name: 'Workflow', exact: true }).click();
    }
    await expect(page.locator('.cinder-filter-bar__options')).toBeVisible();
    await captureForDesignReview(page, {
      route: '/runs',
      state: 'workflow menu open',
      source: '00-showcase.spec.ts',
    });
  });
}

/** Routes whose offline state the design draws: a list, a detail page and a form page. */
const OFFLINE_ROUTES = ['/runs', '/capabilities', '/agents'] as const;

for (const name of OFFLINE_ROUTES) {
  test(`${name} shows the offline banner over its old data at 375 and 1280 pixels`, async ({
    page,
    context,
    pageErrors,
  }) => {
    for (const width of [375, 1280] as const) {
      await page.setViewportSize({ width, height: HEIGHT });
      await page.goto(`${E2E_SHOWCASE_URL}${addresses[name]}`);
      const frame = page.locator('main.weft-shell-outlet [data-view]').first();
      await expect(frame, `${name} at ${width}px`).toHaveAttribute('data-state', 'ready');
      await untilQuiet(page);

      await goOffline(context, pageErrors);
      await page.evaluate(() => {
        window.dispatchEvent(new Event('offline'));
        window.dispatchEvent(new Event('visibilitychange'));
      });
      const banner = page.getByRole('region', { name: 'Connection problem' });
      await expect(banner, `${name} at ${width}px offline`).toBeVisible();
      await expect(frame).toHaveAttribute('data-state', 'ready');
      await captureForDesignReview(page, {
        route: name,
        state: 'offline',
        source: '00-showcase.spec.ts',
      });

      await context.setOffline(false);
      await expect(banner, `${name} at ${width}px back online`).toHaveCount(0);
    }
  });
}

/** The offline banner, over a page that stays as it was, on the sample world. */
async function expectOfflineBanner(page: Page, label: string) {
  const banner = page.getByRole('region', { name: 'Connection problem' });
  await expect(banner, label).toBeVisible();
  // The browser, not the server, is the cause, so the banner leads with that and offers Try again,
  // the app's one word for asking again (COR-2489).
  await expect(banner).toContainText('You’re offline.');
  await expect(banner).toContainText('Showing what loaded as of');
  await expect(banner).toContainText('Changes are off until you’re back.');
  await expect(banner.getByRole('button', { name: 'Try again' })).toBeVisible();
  return banner;
}

for (const width of [320, 375, 1280] as const) {
  test(`Shell, offline: the new chat keeps its typed text with Send off under the offline drawer, at ${width} pixels`, async ({
    page,
    context,
    pageErrors,
  }) => {
    await page.setViewportSize({ width, height: HEIGHT });
    await page.goto(`${E2E_SHOWCASE_URL}/chats/new`);
    const composer = page.getByRole('textbox', { name: /message/i });
    await composer.fill('What did I approve yesterday?');
    await untilQuiet(page);

    await goOffline(context, pageErrors);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    const banner = await expectOfflineBanner(page, `new chat at ${width}px offline`);
    // COR-2284 C5: the offline warning drawer sits above the composer while the host is
    // unreachable; the box keeps the typed text and Send is off.
    const offlineDrawer = page.locator('[data-chat-composer-drawer="offline"]');
    await expect(offlineDrawer).toContainText('Your draft is saved here');
    await expect(offlineDrawer).toBeVisible();
    const drawerBox = await offlineDrawer.boundingBox();
    expect(drawerBox).not.toBeNull();
    expect(drawerBox!.y).toBeGreaterThanOrEqual(0);
    expect(drawerBox!.y + drawerBox!.height).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerHeight),
    );
    await expect(composer).toHaveValue('What did I approve yesterday?');
    const send = page.getByRole('button', { name: 'Send message' });
    await expect(send).toBeDisabled();
    if (width === 320) {
      // A phone's fixed tabs are a sibling of the shrinking outlet. Both the composer and Send
      // must finish above them while the offline drawer remains intact, not merely scroll into
      // view after the frame has already painted beneath the tabs.
      const tabBar = page.getByRole('navigation', { name: 'Main tabs', exact: true });
      const boxes = await readBoxes(page, { composer, send, offlineDrawer, tabBar });
      expect(boxes.composer.y + boxes.composer.height).toBeLessThanOrEqual(boxes.tabBar.y);
      expect(boxes.send.y + boxes.send.height).toBeLessThanOrEqual(boxes.tabBar.y);
      expect(boxes.offlineDrawer.y + boxes.offlineDrawer.height).toBeLessThanOrEqual(
        boxes.composer.y,
      );
    }
    // The top bar and the navigation stay live, because navigation still works for loaded pages.
    await expect(page.getByRole('button', { name: 'Search everything' })).toBeEnabled();
    if (width < 700) {
      // Below a top-level page on a phone the trail's back link takes the menu button's place
      // (06m); the menu is on the page that has no parent.
      await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveCount(0);
      await expect(
        page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Chat' }),
      ).toBeVisible();
    } else {
      await expect(page.getByRole('link', { name: 'Home', exact: true }).first()).toBeVisible();
    }
    await captureForDesignReview(page, {
      route: '/chats/new',
      state: 'offline',
      source: '00-showcase.spec.ts',
    });

    await context.setOffline(false);
    await expect(banner, `new chat at ${width}px back online`).toHaveCount(0);
    await expect(composer).toHaveValue('What did I approve yesterday?');
    await expect(offlineDrawer).toHaveCount(0);
    await expect(page.getByText('Off until it’s back')).toHaveCount(0);
  });

  test(`Shell, offline (/): Home shows the banner under the top bar at ${width} pixels`, async ({
    page,
    context,
    pageErrors,
  }) => {
    await page.setViewportSize({ width, height: HEIGHT });
    await page.goto(`${E2E_SHOWCASE_URL}/`);
    await untilQuiet(page);
    await goOffline(context, pageErrors);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    const banner = await expectOfflineBanner(page, `home at ${width}px offline`);
    await captureForDesignReview(page, {
      route: '/',
      state: 'offline',
      source: '00-showcase.spec.ts',
    });

    await context.setOffline(false);
    await expect(banner, `home at ${width}px back online`).toHaveCount(0);
  });
}

/**
 * The review pane's Markdown artifact, from the default fixture host's `markdown-review` specimen
 * (`fixtures/reviews.ts`): a heading, a table and a highlighted code block, so `ArtifactView`'s
 * Markdown branch is on a screen at 375 (and 320) and 1280 pixels. The code block also pins
 * CodeBlock's `light-dark()` colours: a highlighted token takes its `--shiki-dark` colour in a dark
 * scheme and its `--shiki-light` colour in a light one.
 */
for (const width of [375, 1280] as const) {
  test(`/reviews shows a Markdown artifact with its table and highlighted code at ${width} pixels`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: HEIGHT });
    // The engine's reviews reach the inbox list through the same route `02-approve-review-partial`
    // uses (`review-support.ts`).
    await listEngineReviews(page, request);
    // Opened by its address, which works at every width: on a phone, opening a row replaces the
    // list, so the review is never found by clicking through the rows in turn.
    const pending = await request.get(`${E2E_BASE_URL}/v1/reviews`, {
      params: { status: 'pending' },
    });
    const items = (
      (await pending.json()) as {
        items: { reviewId: string; artifact: unknown }[];
      }
    ).items;
    const markdownReview = items.find(
      (item) =>
        typeof item.artifact === 'object' && item.artifact !== null && 'markdown' in item.artifact,
    );
    expect(markdownReview, 'the fixture engine holds the markdown-review specimen').toBeDefined();
    await page.goto(
      `/reviews?review=${encodeURIComponent(`engine:${markdownReview?.reviewId ?? ''}`)}`,
    );
    const pane = page.locator('.ib-review-detail[data-kind="engine-review"]');
    await expect(pane.getByRole('heading', { name: 'Refund policy update' })).toBeVisible();
    await expect(pane.locator('[data-cinder-markdown-node="table"] td').first()).toHaveText(
      'Up to $25',
    );
    const token = pane.locator('.cinder-code-block .line span[style*="--shiki-dark"]').first();
    await expect(token).toBeVisible();
    await untilQuiet(page);
    await captureForDesignReview(page, {
      route: '/reviews',
      state: 'markdown artifact',
      source: '00-showcase.spec.ts',
    });

    const colours = async (scheme: 'light' | 'dark') => {
      await page.emulateMedia({ colorScheme: scheme });
      return await token.evaluate((span, wanted) => {
        const probe = document.createElement('span');
        probe.style.color = span.style.getPropertyValue(`--shiki-${wanted}`).trim();
        span.after(probe);
        const expected = getComputedStyle(probe).color;
        probe.remove();
        return { actual: getComputedStyle(span).color, expected };
      }, scheme);
    };
    const dark = await colours('dark');
    const light = await colours('light');
    expect(dark.actual).toBe(dark.expected);
    expect(light.actual).toBe(light.expected);
    expect(dark.actual).not.toBe(light.actual);
  });
}
