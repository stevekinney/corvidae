/**
 * The Run hooks section of a run's page (`/runs/:run`) on the sample world
 * (`fixtures/sample-world-seed.ts`, the showcase host) at the browser's sample clock, Monday, Nov 2,
 * 10:46 AM Central time (COR-2115, design rows C3-01 to C3-23): a live run's plan with the hooks that
 * threw first, a settled run's failed hooks alone, a run with nothing to say, and each state of the
 * section (plan unreadable, loading, failing, refused, offline, dark, and settling while watched).
 * The sample world's runs run no plugin hook that throws, so the plan and the failures are what
 * `bureau.tasks.inspect` would answer for a run that had them: each test lets the host answer the
 * inspection and replaces its `hooks`, so everything else on the page is the host's own.
 *
 * A run that settles while it is watched (C3-11) and a hook that fails while it is watched (C3-12)
 * are not driven here either: no specification settles a run on the shared showcase host or holds
 * its page open across a change the host makes, so they are asserted over the section itself
 * (`run-hooks-section.test.ts`, "a run watched while it goes on"), and the design review answers
 * the scroll position and the state of How it ran unverified.
 *
 * A live run reattached after the host restarts (C3-13) is not driven here: no specification
 * restarts the showcase host under an open run (`connect-tools-restart.spec.ts` restarts a separate,
 * empty host). The reattached plan is asserted below the browser, over a real second Bureau on the
 * first one's database (`packages/bureau/src/tasks-inspect-hooks-recovery.test.ts`), and the design
 * review answers C3-13 unverified.
 */
import type { Page, Route } from '@playwright/test';

import {
  SAMPLE_NOW,
  SAMPLE_NOW_MILLISECONDS,
  SAMPLE_TIME_ZONE,
} from '../../fixtures/sample-now.ts';
import {
  readSampleWorldRecords,
  type SampleWorldRecords,
} from '../../fixtures/sample-world-records.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'run-hooks-states.spec.ts';
const WIDTHS = [1280, 375] as const;
/** Every request the page makes of the host, which a test takes away to make the server stop answering. */
const HOST_REQUESTS = /\/(v1|bureau|api)\//;

type Plan = Array<{
  id: string;
  hookPoint: string;
  source: string | null;
  priority: number;
  replay: 'safe' | 'effectful';
}>;
type Failed = Array<{
  hookId: string;
  hookPoint: string;
  source: string | null;
  count: number;
  lastFailedAt: string;
}>;
type Hooks = { plan: Plan | null; failed: Failed };

/** The Bureau's own hook, the agent's, and a plugin's that throws. */
const PLAN: Plan = [
  {
    id: 'acme-audit:redact-secrets',
    hookPoint: 'beforeToolExecution',
    source: 'acme-audit',
    priority: 100,
    replay: 'effectful',
  },
  {
    id: 'agent:trim-context',
    hookPoint: 'prepareStep',
    source: 'agent',
    priority: 20,
    replay: 'safe',
  },
  { id: 'onRunStart#1', hookPoint: 'onRunStart', source: 'bureau', priority: 1000, replay: 'safe' },
  {
    id: 'onRunComplete#1',
    hookPoint: 'onRunComplete',
    source: 'bureau',
    priority: 1000,
    replay: 'safe',
  },
];
/** One hook that threw three times, and one that threw once, a minute apart. */
const FAILED: Failed = [
  {
    hookId: 'acme-audit:redact-secrets',
    hookPoint: 'beforeToolExecution',
    source: 'acme-audit',
    count: 3,
    lastFailedAt: '2026-11-02T16:42:00.000Z',
  },
  {
    hookId: 'agent:trim-context',
    hookPoint: 'prepareStep',
    source: 'agent',
    count: 1,
    lastFailedAt: '2026-11-02T16:41:00.000Z',
  },
];
const LONG = `plugin-${'z'.repeat(293)}`;

let world: SampleWorldRecords;
test.beforeAll(async () => {
  world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
});

const live = () => `/runs/${encodeURIComponent(world.runs.waiting)}`;
const settled = () => `/runs/${encodeURIComponent(world.runs.done)}`;
const section = (page: Page) => page.locator('main [data-section="run-hooks"]');
const hooks = (page: Page) => section(page).locator('[data-hook]');

/**
 * Answers `bureau.tasks.inspect` as the host does, with its `hooks` replaced by `answer`, and leaves
 * every other operation to the host. `answer` may be a status to fail the read with, or a gate.
 */
async function answerHooks(
  page: Page,
  answer: Hooks | number | (() => Promise<Hooks | number> | Hooks | number),
): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { method?: string };
    if (body.method !== 'bureau.tasks.inspect') {
      await route.fallback();
      return;
    }
    const given = typeof answer === 'function' ? await answer() : answer;
    if (typeof given === 'number') {
      await route.fulfill({ status: given, json: { error: 'The server answered.' } });
      return;
    }
    const response = await route.fetch();
    const json = (await response.json()) as { result?: Record<string, unknown> };
    await route.fulfill({ response, json: { ...json, result: { ...json.result, hooks: given } } });
  });
}

async function openRun(page: Page, address: string, width: number): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(address);
  await expect(page.locator('main [data-run-header]')).toBeVisible();
}

const captured = (page: Page, state: string) =>
  captureForDesignReview(page, {
    route: `/runs/:run (hooks, ${state})`,
    state: 'ready',
    source: SOURCE,
  });

for (const width of WIDTHS) {
  test.describe(`at ${width} pixels`, () => {
    test('a live run lists its plan with the failed hooks first, in words, after What happened and before How it ran (C3-01, C3-02, C3-05 to C3-10)', async ({
      page,
      checkA11y,
    }) => {
      await answerHooks(page, { plan: PLAN, failed: FAILED });
      await openRun(page, live(), width);

      const body = section(page);
      await expect(body.getByRole('heading', { level: 2, name: 'Run hooks' })).toBeVisible();
      await expect(body).toContainText('In the order they run, failed hooks first.');
      // The order: the hook that failed last, then the one that failed before it, then the plan's own.
      await expect(hooks(page)).toHaveCount(4);
      await expect(hooks(page).nth(0)).toHaveAttribute('data-hook', 'acme-audit:redact-secrets');
      await expect(hooks(page).nth(1)).toHaveAttribute('data-hook', 'agent:trim-context');
      await expect(hooks(page).nth(2)).toHaveAttribute('data-hook', 'onRunStart#1');
      // Each hook point is in words; a failed one carries its status and its time, a clean one neither.
      await expect(hooks(page).nth(0)).toContainText('Before a tool runs');
      await expect(hooks(page).nth(0)).toContainText('Failed, 3 times');
      await expect(hooks(page).nth(0).locator('time')).toBeVisible();
      await expect(hooks(page).nth(1)).toContainText('Failed');
      await expect(hooks(page).nth(1)).not.toContainText('times');
      await expect(hooks(page).nth(2)).toContainText('When the run starts');
      await expect(hooks(page).nth(2).locator('.cinder-status-dot')).toHaveCount(0);
      await expect(hooks(page).nth(2).locator('time')).toHaveCount(0);
      // Line two: who, the id in monospace, the priority and the replay words.
      await expect(hooks(page).nth(2)).toContainText(
        'Interborough, onRunStart#1, priority 1000, no side effects',
      );
      await expect(
        hooks(page).nth(0).locator('code', { hasText: 'acme-audit:redact-secrets' }),
      ).toBeVisible();
      // No link, button or disclosure on a row, and no retry anywhere in the section.
      await expect(hooks(page).locator('a[href], button')).toHaveCount(0);
      await expect(body.getByRole('button')).toHaveCount(0);
      // No count or badge beside the heading, and no raw word.
      await expect(body.locator('.cinder-badge')).toHaveCount(0);
      for (const raw of ['effectful', 'tier', 'Bureau', 'beforeToolExecution']) {
        await expect(body).not.toContainText(raw);
      }
      // The section sits after What happened and before How it ran.
      const order = await page
        .locator(
          'main [data-section="what-happened"], main [data-section="run-hooks"], main [data-section="how-it-ran"]',
        )
        .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-section')));
      expect(order).toEqual(['what-happened', 'run-hooks', 'how-it-ran']);

      await captured(page, 'live with failures');
      await checkA11y(`run hooks, live with failures, at ${width}px`);
    });

    test('a live run with no failure lists its plan and every row has an empty status column (C3-05)', async ({
      page,
    }) => {
      await answerHooks(page, { plan: PLAN, failed: [] });
      await openRun(page, live(), width);

      await expect(hooks(page)).toHaveCount(4);
      await expect(section(page).locator('.cinder-status-dot')).toHaveCount(0);
      await captured(page, 'live');
    });

    test('a settled run lists only its failed hooks, under the line that says the full plan is shown while a run is live (C3-03)', async ({
      page,
      checkA11y,
    }) => {
      await answerHooks(page, { plan: null, failed: FAILED });
      await openRun(page, settled(), width);

      await expect(section(page)).toContainText('The full hook plan is shown while a run is live.');
      await expect(hooks(page)).toHaveCount(2);
      await expect(hooks(page).nth(0)).toHaveAttribute('data-hook', 'acme-audit:redact-secrets');
      await captured(page, 'settled with failures');
      await checkA11y(`run hooks, settled with failures, at ${width}px`);
    });

    test('a settled run no hook failed in draws no section: no heading, no line and no empty state (C3-04)', async ({
      page,
    }) => {
      await answerHooks(page, { plan: null, failed: [] });
      await openRun(page, settled(), width);

      await expect(page.locator('main [data-section="what-happened"]')).toBeVisible();
      await expect(section(page)).toHaveCount(0);
      await expect(page.locator('main')).not.toContainText('Run hooks');
      await captured(page, 'settled none failed');
    });

    test('a live run whose plan cannot be read says so, lists its failed hooks and draws no placeholder row (C3-14)', async ({
      page,
    }) => {
      await answerHooks(page, { plan: null, failed: FAILED });
      await openRun(page, live(), width);

      await expect(section(page)).toContainText('This run’s hook plan can’t be read.');
      await expect(hooks(page)).toHaveCount(2);
      await expect(section(page).locator('.cinder-skeleton-row')).toHaveCount(0);
      await captured(page, 'plan unreadable');
    });

    test('a read that failed is one row-form error with a secondary Try again, and the rest of the run is shown (C3-16)', async ({
      page,
      pageErrors,
      checkA11y,
    }) => {
      pageErrors.expectEvery({
        pattern: loggedFailedResponse(500, /\/bureau\/jsonrpc/),
        reason: 'the test answers the run’s inspection with a 500',
      });
      await answerHooks(page, 500);
      await openRun(page, live(), width);

      const body = section(page);
      await expect(body).toContainText('Couldn’t load this run’s hooks.');
      await expect(body).toContainText('The rest of the run is shown.');
      const retry = body.getByRole('button', { name: 'Try again' });
      await expect(retry).toHaveAttribute('data-cinder-variant', 'secondary');
      await expect(page.locator('main [data-section="what-happened"]')).toBeVisible();
      await captured(page, 'failing');
      await checkA11y(`run hooks, failing, at ${width}px`);
    });

    test('a read that was refused is an inline access gate with the scope in monospace and only See your scopes (C3-17)', async ({
      page,
      pageErrors,
      checkA11y,
    }) => {
      pageErrors.expectEvery({
        pattern: loggedFailedResponse(403, /\/bureau\/jsonrpc/),
        reason: 'the test refuses the run’s inspection with a 403',
      });
      await answerHooks(page, 403);
      await openRun(page, live(), width);

      const body = section(page);
      await expect(body).toContainText('Your sign-in can’t see this run’s hooks');
      await expect(body).toContainText('requires runs:read');
      await expect(body.getByRole('link', { name: 'See your scopes' })).toHaveAttribute(
        'data-cinder-variant',
        'secondary',
      );
      await expect(body.getByRole('button')).toHaveCount(0);
      await captured(page, 'forbidden');
      await checkA11y(`run hooks, refused, at ${width}px`);
    });

    test('in the dark a failed hook keeps its tone and the identifiers stay legible (C3-21)', async ({
      page,
      checkA11y,
    }) => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await answerHooks(page, { plan: PLAN, failed: FAILED });
      await openRun(page, live(), width);

      await expect(hooks(page).nth(0).locator('.cinder-status-dot')).toBeVisible();
      await captureForDesignReview(page, {
        route: '/runs/:run (hooks, live)',
        state: 'ready (dark)',
        source: SOURCE,
      });
      await checkA11y(`run hooks in the dark at ${width}px`);
    });
  });
}

test('with a 300-character hook id and source, line two is cut with an ellipsis, the time stays on line one and the page never scrolls sideways (C3-19)', async ({
  page,
  checkA11y,
}) => {
  await answerHooks(page, {
    plan: [{ id: LONG, hookPoint: 'onStep', source: LONG, priority: 1, replay: 'safe' }],
    failed: [
      {
        hookId: LONG,
        hookPoint: 'onStep',
        source: LONG,
        count: 2,
        lastFailedAt: '2026-11-02T16:42:00.000Z',
      },
    ],
  });
  await openRun(page, live(), 320);

  await expect(hooks(page)).toHaveCount(1);
  await expect(hooks(page).locator('time')).toBeVisible();
  const scrolls = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(scrolls, 'the page never scrolls sideways').toBe(false);
  await captureForDesignReview(page, {
    route: '/runs/:run (hooks, live)',
    state: 'long values',
    source: SOURCE,
  });
  await checkA11y('run hooks with long values');
});

test.describe('a read in progress (C3-15)', () => {
  /** Holds the inspection until `release`, with the page's clock paused at the sample instant. */
  async function openHeld(page: Page, address: string): Promise<() => void> {
    await page.clock.install({ time: SAMPLE_NOW_MILLISECONDS - 1_000 });
    await page.clock.pauseAt(SAMPLE_NOW);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await answerHooks(page, async () => {
      await gate;
      return { plan: PLAN, failed: FAILED };
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(address);
    await expect(page.locator('main [data-run-header]')).toBeVisible();
    return release;
  }

  test('a live run shows its heading, and after 300 ms three skeleton rows named for what loads', async ({
    page,
    checkA11y,
  }) => {
    const release = await openHeld(page, live());
    await expect(section(page).getByRole('heading', { level: 2, name: 'Run hooks' })).toBeVisible();
    await expect(section(page).locator('.cinder-skeleton-row')).toHaveCount(0);

    await page.clock.runFor(300);
    await expect(section(page).locator('.cinder-skeleton-row')).toHaveCount(3);
    await expect(
      section(page).getByRole('status').filter({ hasText: 'Loading this run’s hooks' }),
    ).toHaveCount(1);
    await captureForDesignReview(page, {
      route: '/runs/:run (hooks, loading)',
      state: 'ready',
      source: SOURCE,
    });
    await page.clock.resume();
    await checkA11y('run hooks loading');
    release();
    await expect(hooks(page)).toHaveCount(4);
  });

  test('a settled run draws nothing for the section while its failed hooks load, so the page does not grow and then shrink', async ({
    page,
  }) => {
    const release = await openHeld(page, settled());
    await page.clock.runFor(1_000);

    await expect(section(page)).toHaveCount(0);
    release();
    await expect(hooks(page)).toHaveCount(2);
  });
});

test('a server that stops answering over a run keeps its hooks at full contrast, under the shell’s banner (C3-23)', async ({
  page,
  pageErrors,
}) => {
  const refused = 'net::ERR_CONNECTION_REFUSED';
  let requests = 0;
  let consoles = 0;
  page.on('requestfailed', (request) => {
    if (request.failure()?.errorText === refused) requests += 1;
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes(refused)) consoles += 1;
  });
  await answerHooks(page, { plan: PLAN, failed: FAILED });
  await openRun(page, live(), 1280);
  await expect(hooks(page)).toHaveCount(4);

  await page.route(HOST_REQUESTS, (route) => route.abort('connectionrefused'));
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));

  const banner = page.getByRole('region', { name: 'Connection problem' });
  await expect(banner).toBeVisible();
  await expect(hooks(page)).toHaveCount(4);
  await expect(hooks(page).nth(0)).toHaveCSS('opacity', '1');
  await captureForDesignReview(page, {
    route: '/runs/:run (hooks, live)',
    state: 'offline',
    source: SOURCE,
  });

  await page.unroute(HOST_REQUESTS);
  await expect(banner).toHaveCount(0);

  const reason = 'the test took the page’s network away on purpose';
  if (requests > 0) {
    pageErrors.expect({
      pattern: new RegExp(`^request failed: .* \\(${refused}\\)$`),
      reason,
      count: requests,
    });
  }
  if (consoles > 0) {
    pageErrors.expect({
      pattern: new RegExp(`^console error: .*${refused}`),
      reason,
      count: consoles,
    });
  }
});
