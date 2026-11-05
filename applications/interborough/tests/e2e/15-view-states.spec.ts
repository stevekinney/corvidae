/**
 * Every view in every state it can be in, at the two widths the application is built for, with
 * `@axe-core/playwright` run on each. The page is the real application against the real host; only
 * the one request a view's probe makes is answered by the test, the way the server would answer it:
 * slowly for loading, with nothing in it for empty, with a 500 for an error, with a 403 for
 * forbidden. A view in its ready state meets the real engine and its seeded fixtures.
 *
 * Health is the exception: it has no probe (`probeFor` answers `undefined` for it), because it reads
 * the engine band by band and a principal holding one of its two scopes must not be turned away by
 * a request that needs the other. Its frame is ready unless the principal holds neither scope, so
 * the loading, error and forbidden cases for Health are the ones its bands and its scopes have: a
 * count or the health line that could not be read, a read the principal's scopes lock, and the
 * overview waiting on the engine's first answer.
 */
import type { Page, Route } from '@playwright/test';

import { NOT_FOUND_ROUTE_COPY, VIEW_COPY } from '../../src/app/copy.ts';
import { VIEW_NAMES, VIEWS, type ViewName, type ViewStateName } from '../../src/app/views.ts';
import { HEALTH_ATTENTION_COPY, HEALTH_COUNTS_COPY } from '../../src/routes/health/health-copy.ts';
import { newThreadId, runToEnd } from './chat-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_BASE_URL } from './e2e-constants.ts';
import {
  expect,
  holdBureauFeed,
  loggedFailedResponse,
  test,
  type PageErrorLog,
} from './fixtures.ts';
import { bureauCall } from './task-support.ts';

const WIDTHS = [375, 1280] as const;

/** The hook the hooks list's ready state is shown with; the spec deletes every hook of this name. */
const HOOK_NAME = 'e2e-view-states';

test.afterAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: E2E_BASE_URL });
  try {
    const listed = (await bureauCall(request, 'bureau.hooks.list', {})) as {
      hooks: { id: string; name: string | null }[];
    };
    for (const hook of listed.hooks) {
      if (hook.name === HOOK_NAME)
        await bureauCall(request, 'bureau.hooks.delete', { hookId: hook.id });
    }
  } finally {
    await request.dispose();
  }
});

const PATHS: Readonly<Record<ViewName, string>> = {
  home: '/',
  chat: '/chats',
  agents: '/agents',
  'agent-editor': '/agents/new',
  capabilities: '/capabilities',
  workflows: '/workflows',
  runs: '/runs',
  schedules: '/schedules',
  reviews: '/reviews',
  workers: '/health/workers',
  storage: '/health/storage',
  audit: '/health/audit',
  settings: '/settings',
  goals: '/goals',
  hooks: '/hooks',
  health: '/health',
};

/** The states this spec drives from the view's own path: a view is not found only at an item's address, which `21-chat.spec.ts` covers. */
type Outcome = Exclude<ViewStateName, 'not-found'> | 'ready';

/** How a view's probe is recognised on the wire, and what an empty answer looks like. */
type ProbeRoute = {
  /** The URL the probe asks, as Chromium reports it when the test answers it with an error status. */
  readonly url: RegExp;
  readonly matches: (url: URL, body: string) => boolean;
  readonly empty: unknown;
  /** A view that asks more than one question answers each by what the request asked. */
  readonly emptyFor?: (body: string) => unknown;
};

function jsonRpcProbe(method: string): ProbeRoute {
  return {
    url: /\/jsonrpc/,
    matches: (url, body) => url.pathname.endsWith('/jsonrpc') && body.includes(`"${method}"`),
    empty: { items: [] },
  };
}

/** A Bureau operation's request is a JSON-RPC call to `/bureau/jsonrpc`, answered with `empty` when the view is empty. */
function bureauProbe(method: string, empty: unknown): ProbeRoute {
  return {
    url: /\/bureau\/jsonrpc/,
    matches: (url, body) => url.pathname === '/bureau/jsonrpc' && body.includes(`"${method}"`),
    empty,
  };
}

/**
 * Every view that has a probe: Health reads its bands apart and has none, and Home reads what other
 * views read, each card on its own, so it has none either.
 */
type ProbedView = Exclude<ViewName, 'health' | 'home'>;

const PROBES: Readonly<Record<ProbedView, ProbeRoute>> = {
  // The view asks for one chat to learn whether the caller has any. The shell's notification bell
  // reads the same list, a hundred at a time and every few seconds, for the title of each chat an
  // item names; it is not the view's probe, so it goes through and is never answered with the
  // error (a poll that lands in a slow test would otherwise log a response the guard does not count).
  chat: {
    url: /\/bureau\/jsonrpc/,
    matches: (url, body) =>
      url.pathname === '/bureau/jsonrpc' &&
      body.includes('"bureau.contexts.list"') &&
      /"limit":1[,}]/.test(body),
    empty: { contexts: [], nextOffset: null },
  },
  agents: bureauProbe('bureau.agents.list', { agents: [] }),
  audit: bureauProbe('bureau.audit.query', { records: [], nextCursor: null }),
  goals: bureauProbe('bureau.goals.list', { goals: [], nextOffset: null }),
  hooks: bureauProbe('bureau.hooks.list', { hooks: [] }),
  // Never empty (`VIEWS.settings.canBeEmpty`), so the answer is never served as an empty one.
  settings: bureauProbe('bureau.settings.get', {
    values: {},
    effective: {},
    revision: 0,
    persisted: true,
    keys: {},
  }),
  'agent-editor': jsonRpcProbe('bureau.agents.catalog'),
  // Never empty (`VIEWS.capabilities.canBeEmpty`): each tab says its own nothing.
  capabilities: bureauProbe('bureau.agents.catalog', { models: [], tools: [] }),
  // The list joins the engine's definitions with the Bureau's files, so it asks both, and it is
  // empty only when neither lists anything.
  workflows: {
    url: /\/(bureau\/)?jsonrpc/,
    matches: (url, body) =>
      (url.pathname.endsWith('/jsonrpc') && body.includes('"weft.workflows.definitions.list"')) ||
      (url.pathname === '/bureau/jsonrpc' && body.includes('"bureau.workflows.list"')),
    empty: { definitions: [] },
    emptyFor: (body) =>
      body.includes('"bureau.workflows.list"')
        ? { workflows: [], nextOffset: null }
        : { definitions: [] },
  },
  // The runs are the Bureau's: the view asks it for one task and one goal, and is empty only when
  // it has neither. The list that follows asks for a hundred of each.
  runs: {
    url: /\/bureau\/jsonrpc/,
    matches: (url, body) =>
      url.pathname === '/bureau/jsonrpc' &&
      /"bureau\.(tasks|goals)\.list"/.test(body) &&
      /"limit":1[,}]/.test(body),
    empty: { tasks: [], nextPageToken: null },
    emptyFor: (body) =>
      body.includes('"bureau.tasks.list"')
        ? { tasks: [], nextPageToken: null }
        : { goals: [], nextOffset: null },
  },
  schedules: {
    url: /\/v1\/schedules/,
    matches: (url) => url.pathname === '/v1/schedules',
    empty: { items: [], total: 0 },
  },
  reviews: bureauProbe('bureau.reviews.list', { reviews: [] }),
  workers: jsonRpcProbe('weft.workers.list'),
  storage: jsonRpcProbe('weft.storage.capabilities'),
};

/** A principal that holds `scopes` and nothing else, as the page and the engine's `principal` operation both report it. */
async function holdOnlyScopes(page: Page, scopes: readonly string[]): Promise<void> {
  const principal = { method: 'api-key', subject: 'anonymous:local', scopes };
  await page.route('**/api/v1/principal', async (route) => {
    await route.fulfill({ json: principal });
  });
  await page.route('**/jsonrpc', async (route) => {
    const body = route.request().postData() ?? '';
    if (body.includes('"weft.system.principal"')) {
      await route.fulfill({ json: jsonRpcBody(body, principal) });
      return;
    }
    await route.fallback();
  });
}

/** The probe a view asks, which Health does not have. */
function probeOf(view: ViewName): ProbeRoute {
  const probe = view === 'health' || view === 'home' ? undefined : PROBES[view];
  if (probe === undefined) throw new Error(`${view} has no probe to answer`);
  return probe;
}

/** Answer the view's probe as the server would for `outcome`; every other request goes through. */
async function drive(
  page: Page,
  pageErrors: PageErrorLog,
  view: ViewName,
  outcome: Outcome,
): Promise<void> {
  if (outcome === 'ready') return;
  // Health asks no probe: it is locked when the principal holds neither scope it opens for.
  if (view === 'health') {
    await holdOnlyScopes(page, ['reviews:read']);
    return;
  }
  const probe = probeOf(view);
  if (outcome === 'error' || outcome === 'forbidden') {
    // The test answers every request for the probe's operation with an error status, and Chromium
    // logs each such response. How many there are is not the probe's to say: the shell reads some
    // of these operations too (the sidebar's workers badge reads the workers list), and whether its
    // observer asks once or again after the first answer follows when the shell re-renders, so the
    // count moves with load (two or three for Workers). The status is the claim, and the frame's
    // state below proves the probe got it. The feed's catch-up would ask the probe again if it
    // landed during the first read, so it is held.
    await holdBureauFeed(page);
    const status = outcome === 'error' ? 500 : 403;
    pageErrors.expectEvery({
      pattern: loggedFailedResponse(status, probe.url),
      reason: `the test answers the ${view} probe with a ${status}`,
    });
  }
  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    if (!probe.matches(new URL(request.url()), request.postData() ?? '')) {
      await route.fallback();
      return;
    }
    switch (outcome) {
      case 'loading':
        // Hold the request: the probe stays pending for as long as the page is open.
        return;
      case 'empty':
        await route.fulfill({
          json: jsonRpcBody(
            request.postData(),
            probe.emptyFor === undefined ? probe.empty : probe.emptyFor(request.postData() ?? ''),
          ),
        });
        return;
      case 'error':
        await route.fulfill({ status: 500, json: { error: 'The server broke.' } });
        return;
      case 'forbidden':
        await route.fulfill({ status: 403, json: { error: 'Forbidden' } });
        return;
    }
  });
}

/** A JSON-RPC probe wants an envelope around its result; a REST or health probe wants the body. */
function jsonRpcBody(post: string | null, result: unknown): unknown {
  if (post === null) return result;
  const parsed: unknown = JSON.parse(post);
  const id = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'id') : null;
  return { jsonrpc: '2.0', id, result };
}

function statesOf(view: ViewName): Outcome[] {
  // Health has no probe, so it is never loading, empty or failing as a view; it is ready, or locked
  // when the principal lacks both scopes. Its bands' own states are covered below.
  if (view === 'health') return ['forbidden', 'ready'];
  // Home has no probe either: each of its cards reads on its own, so the view is only ever ready.
  if (view === 'home') return ['ready'];
  // A view that owns its states keeps its header in each, so its page says them and not the frame:
  // its own specification drives them (`schedules-states.spec.ts`). The frame still refuses it.
  if (VIEWS[view].ownsStates === true) return ['forbidden', 'ready'];
  // The reviews probe swallows a Bureau failure such as a 5xx, and the page shows it in a banner
  // beside the engine's reviews (`31-reviews.spec.ts`), so the view is not in the error state for
  // it. A 401 does reach the error state (`view-frame.test.ts`, "the Reviews view").
  const states: Outcome[] =
    view === 'reviews' ? ['loading', 'forbidden'] : ['loading', 'error', 'forbidden'];
  if (VIEWS[view].canBeEmpty) states.push('empty');
  states.push('ready');
  return states;
}

for (const view of VIEW_NAMES) {
  for (const outcome of statesOf(view)) {
    for (const width of WIDTHS) {
      test(`${view} is ${outcome} at ${width} pixels, and passes axe`, async ({
        page,
        request,
        checkA11y,
        pageErrors,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        // The chat list has something to show once the caller has a session,
        // whose run is listed under Runs.
        if (view === 'chat' && outcome === 'ready') {
          await runToEnd(request, 'demo:assistant', newThreadId('states'), 'Hello');
        }
        // The hooks list has something to show once the caller has made a hook.
        if (view === 'hooks' && outcome === 'ready') {
          await bureauCall(request, 'bureau.hooks.create', {
            name: HOOK_NAME,
            events: ['review.requested'],
            action: { type: 'notify' },
          });
        }
        await drive(page, pageErrors, view, outcome);
        await page.goto(PATHS[view]);

        const frame = page.locator(`[data-view="${view}"]`);
        await expect(frame).toHaveAttribute('data-state', outcome);
        if (outcome !== 'ready') {
          const copy = VIEW_COPY[view];
          const title = outcome === 'empty' ? copy.empty?.title : copy[outcome]?.title;
          await expect(frame.getByRole('heading', { level: 1 })).toHaveText(title ?? '');
        }
        await captureForDesignReview(page, {
          route: PATHS[view],
          state: outcome,
          source: '15-view-states.spec.ts',
        });
        await checkA11y(`${view} — ${outcome} at ${width}px`);
        // No view scrolls the page sideways at the phone width, in any state: a table scrolls
        // inside its own wrapper, and nothing hidden is positioned outside it (COR-1647).
        const scrollWidth = await page.evaluate(() => document.scrollingElement?.scrollWidth ?? 0);
        expect(
          scrollWidth,
          `${view} — ${outcome} at ${width}px scrolls sideways`,
        ).toBeLessThanOrEqual(width);
        // The shell clips the document (`.weft-shell` is `overflow: hidden`), so a page that is
        // simply too wide scrolls the outlet instead and the check above passes. The outlet is
        // what must not overflow (COR-1647).
        const outlet = await page.locator('main.weft-shell-outlet').evaluate((element) => ({
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        }));
        expect(
          outlet.scrollWidth,
          `${view} — ${outcome} at ${width}px scrolls the outlet sideways`,
        ).toBeLessThanOrEqual(outlet.clientWidth);
      });
    }
  }
}

test('a view the principal lacks the scopes for is forbidden without a probe request', async ({
  page,
}) => {
  await holdOnlyScopes(page, ['workflows:read']);
  await page.goto('/health/storage');
  const frame = page.locator('[data-view="storage"]');
  await expect(frame).toHaveAttribute('data-state', 'forbidden');
  await expect(frame).toContainText('requires storage:admin');
});

/** The engine reads behind Health's runs counts and cards, which the faulted case refuses. */
const HEALTH_ENGINE_READS = ['"weft.workflows.aggregate"', '"weft.workflows.list"'] as const;

/** One of Health's four counts, by its label: its card holds the label, the number or dash, and its line. */
function healthCount(page: Page, label: string) {
  return page.getByRole('group', { name: HEALTH_COUNTS_COPY.label }).locator('.cinder-statistic', {
    has: page.locator('.cinder-statistic__label', { hasText: label }),
  });
}

for (const width of WIDTHS) {
  test(`health reads each band on its own: a read the engine refuses shows a dash in the counts and the cards at ${width} pixels`, async ({
    page,
    checkA11y,
    pageErrors,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    // A 4xx the engine sent is not retried, so the read fails at once (a 5xx is asked again, with a
    // back-off, before the query gives up). How many reads there are follows how often the page
    // asks, so the status is declared and not the count.
    pageErrors.expectEvery({
      pattern: loggedFailedResponse(400, /\/jsonrpc/),
      reason: 'the test refuses the engine reads behind the runs counts and the metric cards',
    });
    await page.route('**/jsonrpc', async (route) => {
      const body = route.request().postData() ?? '';
      if (HEALTH_ENGINE_READS.some((read) => body.includes(read))) {
        await route.fulfill({ status: 400, json: { error: 'The engine refused the read.' } });
        return;
      }
      await route.fallback();
    });
    await page.goto('/health');

    const frame = page.locator('[data-view="health"]');
    await expect(frame).toHaveAttribute('data-state', 'ready');
    // Only the counts that read the refused operation lose their number.
    await expect(healthCount(page, HEALTH_COUNTS_COPY.runningNow)).toContainText(
      HEALTH_COUNTS_COPY.unavailable,
    );
    await expect(healthCount(page, HEALTH_COUNTS_COPY.failedIn24Hours)).toContainText(
      HEALTH_COUNTS_COPY.unavailable,
    );
    await expect(healthCount(page, HEALTH_COUNTS_COPY.missedRuns)).toHaveText(/\d/);
    // The Bureau's list still says what needs attention, and the cards that came from the engine say they could not be read.
    await expect(frame.getByTestId('needs-attention')).toBeVisible();
    await expect(frame.getByTestId('metric-cards')).toContainText('Couldn’t be read');
    await captureForDesignReview(page, {
      route: '/health',
      state: 'refused-reads',
      source: '15-view-states.spec.ts',
    });
    await checkA11y(`health with refused reads at ${width}px`);
  });

  test(`health reads what a principal's scopes allow, and the rest of the page stays, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    // The runs scope alone opens the page: Needs you also counts the Bureau's reviews, which the
    // principal owns and no console scope gates, so it still has a number.
    await holdOnlyScopes(page, ['workflows:read']);
    await page.goto('/health');

    const frame = page.locator('[data-view="health"]');
    await expect(frame).toHaveAttribute('data-state', 'ready');
    await expect(healthCount(page, HEALTH_COUNTS_COPY.runningNow)).toHaveText(/\d/);
    await expect(healthCount(page, HEALTH_COUNTS_COPY.needsYou)).toHaveText(/\d/);
    await expect(frame.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
    await captureForDesignReview(page, {
      route: '/health',
      state: 'locked-reads',
      source: '15-view-states.spec.ts',
    });
    await checkA11y(`health with locked reads at ${width}px`);
  });

  test(`health shows its heading and tabs while the list of what needs attention is still being read at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    // Never answered: the list stays a skeleton for as long as the page is open.
    await page.route('**/bureau/jsonrpc', async (route) => {
      if ((route.request().postData() ?? '').includes('"bureau.health.attention"')) return;
      await route.fallback();
    });
    await page.goto('/health');

    const frame = page.locator('[data-view="health"]');
    await expect(frame).toHaveAttribute('data-state', 'ready');
    await expect(frame.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
    await expect(
      frame.getByRole('status', { name: `Loading ${HEALTH_ATTENTION_COPY.title.toLowerCase()}` }),
    ).toBeVisible();
    await captureForDesignReview(page, {
      route: '/health',
      state: 'waiting-on-attention',
      source: '15-view-states.spec.ts',
    });
    await checkA11y(`health waiting on what needs attention at ${width}px`);
  });
}

for (const width of WIDTHS) {
  test(`an address no route names shows the not-found page inside the shell at ${width} pixels, and passes axe`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    // A document navigation: the host answers it with the shell, not a bare 404.
    const response = await page.goto('/nonsense/route');
    expect(response?.status()).toBe(200);

    const frame = page.locator('[data-view="not-found"]');
    await expect(frame).toHaveAttribute('data-state', 'not-found');
    await expect(frame.getByRole('heading', { level: 1 })).toHaveText(NOT_FOUND_ROUTE_COPY.title);
    await expect(frame).toContainText(NOT_FOUND_ROUTE_COPY.description);
    await expect(frame.locator('.cinder-empty-state-action > *')).toHaveText([
      'Back to Home',
      'Search everything',
    ]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await captureForDesignReview(page, {
      route: '/nonsense/route',
      state: 'not-found',
      source: '15-view-states.spec.ts',
    });
    await checkA11y(`not-found route at ${width}px`);

    await frame.getByRole('link', { name: 'Back to Home' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test(`a run that does not exist is the not-found page, with Runs › Not found for a breadcrumb, at ${width} pixels`, async ({
    page,
    checkA11y,
    pageErrors,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    // The run page asks the workflow engine for a run the Bureau does not know, and it says no.
    pageErrors.expectEvery({
      pattern: loggedFailedResponse(404, /\/v1\/workflows\/no-such-run/),
      reason: 'the engine has no run called no-such-run',
    });
    await page.goto('/runs/no-such-run');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('This run doesn’t exist');
    await expect(page.getByText(NOT_FOUND_ROUTE_COPY.description)).toBeVisible();
    await expect(page.locator('main').getByRole('link', { name: 'Back to Runs' })).toBeVisible();
    await expect(
      page.locator('main').getByRole('button', { name: 'Search everything' }),
    ).toBeVisible();
    // The breadcrumb names the missing run in words: Runs › Not found.
    await expect(page.locator('header.weft-shell-topbar')).toContainText('Not found');
    await captureForDesignReview(page, {
      route: '/runs/no-such-run',
      state: 'not-found',
      source: '15-view-states.spec.ts',
    });
    await checkA11y(`a run that does not exist at ${width}px`);
  });

  test(`the not-found page keeps the sidebar at ${width} pixels`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/nonsense/route');
    await expect(page.locator('[data-view="not-found"]')).toHaveAttribute(
      'data-state',
      'not-found',
    );
    // Beside the page on a desktop, behind the menu button on a phone.
    if (width < 640) {
      await page.getByRole('button', { name: 'Open navigation' }).click();
    }
    const navigation = page.getByRole('navigation', { name: 'Views' });
    await expect(navigation).toBeVisible();
    await expect(navigation.getByRole('link', { name: VIEW_COPY.agents.label })).toBeVisible();
  });
}

test('an address that is not valid percent-encoding shows the not-found page', async ({ page }) => {
  // `%E0` cannot be decoded; the router used to throw while matching `/workflows/:workflow/runs`.
  const response = await page.goto('/workflows/%E0/nope');
  expect(response?.status()).toBe(200);
  const frame = page.locator('[data-view="not-found"]');
  await expect(frame).toHaveAttribute('data-state', 'not-found');
  await expect(frame.getByRole('heading', { level: 1 })).toHaveText(NOT_FOUND_ROUTE_COPY.title);
});

test('a miss on an asset, the Bureau, or the host is still a 404, not the shell', async ({
  request,
}) => {
  for (const path of ['/assets/missing-0000.js', '/bureau/missing', '/host/missing']) {
    const response = await request.get(path, { headers: { accept: 'text/html' } });
    expect(response.status(), path).toBe(404);
  }
});
