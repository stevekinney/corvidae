/**
 * Every view in every state it can be in, at the two widths the application is built for, with
 * `@axe-core/playwright` run on each. The page is the real application against the real host; only
 * the one request a view's probe makes is answered by the test, the way the server would answer it:
 * slowly for loading, with nothing in it for empty, with a 500 for an error, with a 403 for
 * forbidden. A view in its ready state meets the real engine and its seeded fixtures.
 */
import type { Page, Route } from '@playwright/test';

import { VIEW_COPY } from '../../src/app/copy.ts';
import { VIEW_NAMES, VIEWS, type ViewName, type ViewStateName } from '../../src/app/views.ts';
import { newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';

const WIDTHS = [375, 1280] as const;

const PATHS: Readonly<Record<ViewName, string>> = {
  chat: '/chat',
  agents: '/agents',
  'agent-editor': '/agents/new',
  workflows: '/workflows',
  runs: '/runs',
  schedules: '/schedules',
  reviews: '/reviews',
  workers: '/workers',
  storage: '/storage',
  system: '/system',
  audit: '/audit',
  goals: '/goals',
  engine: '/engine',
};

/** The states this spec drives from the view's own path: a view is not found only at an item's address, which `21-chat.spec.ts` covers. */
type Outcome = Exclude<ViewStateName, 'not-found'> | 'ready';

/** How a view's probe is recognised on the wire, and what an empty answer looks like. */
type ProbeRoute = {
  readonly matches: (url: URL, body: string) => boolean;
  readonly empty: unknown;
  /** A view that asks more than one question answers each by what the request asked. */
  readonly emptyFor?: (body: string) => unknown;
};

function jsonRpcProbe(method: string): ProbeRoute {
  return {
    matches: (url, body) => url.pathname.endsWith('/jsonrpc') && body.includes(`"${method}"`),
    empty: { items: [] },
  };
}

/** A Bureau operation's request is a JSON-RPC call to `/bureau/jsonrpc`, answered with `empty` when the view is empty. */
function bureauProbe(method: string, empty: unknown): ProbeRoute {
  return {
    matches: (url, body) => url.pathname === '/bureau/jsonrpc' && body.includes(`"${method}"`),
    empty,
  };
}

const PROBES: Readonly<Record<ViewName, ProbeRoute>> = {
  chat: bureauProbe('bureau.contexts.list', { contexts: [], nextOffset: null }),
  agents: bureauProbe('bureau.agents.list', { agents: [] }),
  audit: bureauProbe('bureau.audit.query', { records: [], nextCursor: null }),
  goals: bureauProbe('bureau.goals.list', { goals: [], nextOffset: null }),
  'agent-editor': jsonRpcProbe('bureau.agents.catalog'),
  // The list joins the engine's definitions with the Bureau's files, so it asks both, and it is
  // empty only when neither lists anything.
  workflows: {
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
  schedules: { matches: (url) => url.pathname === '/v1/schedules', empty: { items: [], total: 0 } },
  reviews: bureauProbe('bureau.reviews.list', { reviews: [] }),
  workers: jsonRpcProbe('weft.workers.list'),
  storage: jsonRpcProbe('weft.storage.capabilities'),
  system: jsonRpcProbe('weft.system.registry'),
  engine: jsonRpcProbe('weft.system.registry'),
};

/** Answer the view's probe as the server would for `outcome`; every other request goes through. */
async function drive(page: Page, view: ViewName, outcome: Outcome): Promise<void> {
  if (outcome === 'ready') return;
  const probe = PROBES[view];
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
      }) => {
        await page.setViewportSize({ width, height: 900 });
        // The chat list has something to show once the caller has a session,
        // whose run is listed under Runs.
        if (view === 'chat' && outcome === 'ready') {
          await runToEnd(request, 'assistant', newThreadId('states'), 'Hello');
        }
        await drive(page, view, outcome);
        await page.goto(PATHS[view]);

        const frame = page.locator(`[data-view="${view}"]`);
        await expect(frame).toHaveAttribute('data-state', outcome);
        if (outcome !== 'ready') {
          const copy = VIEW_COPY[view];
          const title = outcome === 'empty' ? copy.empty?.title : copy[outcome]?.title;
          await expect(frame.getByRole('heading', { level: 1 })).toHaveText(title ?? '');
        }
        await checkA11y(`${view} — ${outcome} at ${width}px`);
        // No view scrolls the page sideways at the phone width, in any state: a table scrolls
        // inside its own wrapper, and nothing hidden is positioned outside it (COR-1647).
        const scrollWidth = await page.evaluate(() => document.scrollingElement?.scrollWidth ?? 0);
        expect(
          scrollWidth,
          `${view} — ${outcome} at ${width}px scrolls sideways`,
        ).toBeLessThanOrEqual(width);
      });
    }
  }
}

test('a view the principal lacks the scopes for is forbidden without a probe request', async ({
  page,
}) => {
  await page.route('**/api/v1/principal', async (route) => {
    await route.fulfill({
      json: { method: 'api-key', subject: 'anonymous:local', scopes: ['workflows:read'] },
    });
  });
  await page.route('**/jsonrpc', async (route) => {
    const body = route.request().postData() ?? '';
    if (body.includes('"weft.system.principal"')) {
      await route.fulfill({
        json: {
          jsonrpc: '2.0',
          id: JSON.parse(body).id,
          result: { method: 'api-key', subject: 'anonymous:local', scopes: ['workflows:read'] },
        },
      });
      return;
    }
    await route.fallback();
  });
  await page.goto('/storage');
  const frame = page.locator('[data-view="storage"]');
  await expect(frame).toHaveAttribute('data-state', 'forbidden');
  await expect(frame).toContainText('Requires storage:admin');
});
