/**
 * COR-2213: a plugin's page at `/plugins/<plugin>/<path>`. The route outlet mounts the page under the
 * view frame, whose probe reads the host's panels, so the host here is a table of answers (the panels
 * it serves, the plugins it loaded, and one page per panel) and the frame's window is a double the
 * test plays the app through. The real host serving the same routes is `src/host/host-panels.test.ts`;
 * the page in a browser, with a sidebar and a palette, is `tests/e2e/plugin-page.spec.ts`.
 */
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { HttpClient } from '@lostgradient/weft/testing';
import type { QueryClient } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';

import { breadcrumbTrail } from '../../app/breadcrumbs.svelte.ts';
import { PLUGIN_PAGE_COPY } from '../../app/copy/plugin-pages.ts';
import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorldStub,
} from '../../lib/bureau-world.test-support.ts';
import { queryKeys } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES, type AuthorizationScope } from '../../lib/scopes.svelte.ts';
import { landAt } from '../chat/pages.test-support.ts';

type FrameMessage = { jsonrpc?: string; id?: number; method?: string; result?: unknown } & Record<
  string,
  unknown
>;

type Panel = {
  plugin: string;
  app: string;
  title: string;
  uri: string;
  placements: unknown[];
};

/** The panel a plugin places as a page, in the host's own listing shape. */
function pagePanel(
  plugin: string,
  app: string,
  title: string,
  path: string,
  sidebar?: { group: string; icon?: string },
): Panel {
  return {
    plugin,
    app,
    title,
    uri: `ui://${plugin}/${app}/v1`,
    placements: [{ kind: 'page', path, ...(sidebar === undefined ? {} : { sidebar }) }],
  };
}

type Standing = {
  name: string;
  title: string;
  status?: 'running' | 'needs-setup' | 'disabled' | 'skipped';
  secrets?: { key: string; set: boolean }[];
};

/** One plugin as `GET /host/plugins` lists it, with only what these tests vary. */
function standingOf({ name, title, status = 'running', secrets = [] }: Standing) {
  return {
    descriptor: {
      name,
      title,
      version: '1.0.0',
      description: `The ${name} plugin.`,
      required: false,
      enabledByDefault: true,
    },
    source: 'package',
    location: `@fixtures/${name}`,
    status,
    problems: [],
    contributions: [],
    enabled: status !== 'disabled',
    configuration: {},
    configurationSchema: null,
    running: { enabled: status !== 'disabled', configuration: {} },
    secrets: secrets.map(({ key, set }) => ({
      key,
      generated: false,
      set,
      location: `/home/.bungalow/secrets/${key}`,
    })),
    restartRequired: false,
  };
}

const PAGE_HTML = '<div id="root"></div>';

let stub: BureauWorldStub | undefined;
let restoreHost: (() => void) | undefined;
let panels: Panel[] = [];
let plugins: Standing[] = [];
let panelsStatus = 200;
/** How many reads of a panel's page answer 500 before the host serves it. */
let pageFailures = 0;
let pageReads: string[] = [];
let heldPage: Promise<void> | undefined;
/** Holds the answer of `GET /host/panels`, as a slow host does while the shell already has the panels. */
let heldPanels: Promise<void> | undefined;
let framePayloads: FrameMessage[] = [];
const frameWindows = new WeakMap<object, { postMessage: (message: FrameMessage) => void }>();
const originalContentWindow = Object.getOwnPropertyDescriptor(
  HTMLIFrameElement.prototype,
  'contentWindow',
);
let debug: ReturnType<typeof spyOn<Console, 'debug'>>;

const ACME = pagePanel('acme-reports', 'queue', 'Review queue', 'reviews/queue', {
  group: 'work',
});

async function hostAnswer(path: string): Promise<Response | undefined> {
  if (path === '/host/panels') {
    if (heldPanels !== undefined) await heldPanels;
    return panelsStatus === 200
      ? Response.json({ apps: panels })
      : new Response('Not found', { status: panelsStatus });
  }
  if (path === '/host/plugins') {
    return Response.json({
      configurationRevision: null,
      plugins: plugins.map(standingOf),
      unloaded: [],
    });
  }
  const page = /^\/host\/plugins\/([^/]+)\/apps\/([^/]+)$/.exec(path);
  if (page !== null) {
    pageReads.push(`${page[1] ?? ''}/${page[2] ?? ''}`);
    if (heldPage !== undefined) await heldPage;
    if (pageFailures > 0) {
      pageFailures -= 1;
      return Response.json({ error: 'x' }, { status: 500 });
    }
    return Response.json({ html: PAGE_HTML, ui: {} });
  }
  return undefined;
}

beforeAll(() => {
  debug = spyOn(console, 'debug').mockImplementation(() => {});
});
afterAll(() => debug.mockRestore());

beforeEach(() => {
  sessionStorage.clear();
  panels = [ACME];
  plugins = [{ name: 'acme-reports', title: 'Acme reports' }];
  panelsStatus = 200;
  pageFailures = 0;
  pageReads = [];
  heldPage = undefined;
  heldPanels = undefined;
  framePayloads = [];
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    get(this: HTMLIFrameElement) {
      const existing = frameWindows.get(this);
      if (existing !== undefined) return existing;
      const created = { postMessage: (message: FrameMessage) => void framePayloads.push(message) };
      frameWindows.set(this, created);
      return created;
    },
  });
});

afterEach(() => {
  cleanup();
  restoreHost?.();
  restoreHost = undefined;
  stub?.restore();
  stub = undefined;
  sessionStorage.clear();
  if (originalContentWindow === undefined) {
    Reflect.deleteProperty(HTMLIFrameElement.prototype, 'contentWindow');
  } else {
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', originalContentWindow);
  }
});

const pathOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;

function open(
  address: string,
  scopes: readonly AuthorizationScope[] = AUTHORIZATION_SCOPES,
  onQueryClient?: (queryClient: QueryClient) => void,
) {
  stub = installBureauWorld(emptyBureauWorld({}));
  const bureauFetch = globalThis.fetch;
  const withHost = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      (await hostAnswer(pathOf(input))) ?? bureauFetch(input, init),
    { preconnect: bureauFetch.preconnect },
  );
  globalThis.fetch = withHost;
  restoreHost = () => {
    globalThis.fetch = bureauFetch;
  };
  landAt(address);
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes,
      ...(onQueryClient === undefined ? {} : { onQueryClient }),
    },
  } as never);
}

const frameOf = (view: ReturnType<typeof open>, title: string) =>
  view.container.querySelector<HTMLIFrameElement>(`iframe[title="${title}"]`);

async function ready(view: ReturnType<typeof open>, title = 'Review queue') {
  await waitFor(() => expect(frameOf(view, title)).not.toBeNull());
  return frameOf(view, title) as HTMLIFrameElement;
}

/** Plays the app: posts a JSON-RPC message to the host from the iframe's window. */
function fromApp(source: object, data: Record<string, unknown>): void {
  window.dispatchEvent(
    Object.assign(new window.Event('message'), { data: { jsonrpc: '2.0', ...data }, source }),
  );
}

async function initialize(source: object): Promise<void> {
  fromApp(source, {
    id: 1,
    method: 'ui/initialize',
    params: {
      appInfo: { name: 'fixture', version: '1.0.0' },
      appCapabilities: {},
      protocolVersion: '2026-01-26',
    },
  });
  await waitFor(() =>
    expect(framePayloads.some((message) => message.id === 1 && !('method' in message))).toBe(true),
  );
  fromApp(source, { method: 'ui/notifications/initialized' });
  // The bridge refuses a request that arrives before it has taken the notification in.
  await quietFor(20);
}

const responseTo = (id: number) =>
  framePayloads.find((message) => message.id === id && !('method' in message));

const viewOf = (view: ReturnType<typeof open>) =>
  view.container.querySelector<HTMLElement>('[data-view="plugin-page"]');

describe('a plugin’s page', () => {
  test('renders the panel full-page under its title and where it comes from, with no word of its plugin’s name or path', async () => {
    const view = open('/plugins/acme-reports/reviews/queue');
    const frame = await ready(view);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('srcdoc')).toContain(PAGE_HTML);
    expect(viewOf(view)?.getAttribute('data-state')).toBe('ready');
    // The panel fills its container instead of following the height it reports.
    expect(view.container.querySelector('.mcp-app')?.hasAttribute('data-fill')).toBe(true);
    expect(view.getByRole('heading', { level: 1, name: 'Review queue' })).toBeTruthy();
    const from = view.getByRole('link', { name: 'Acme reports' });
    expect(from.getAttribute('href')).toBe('/settings/plugins?plugin=acme-reports');
    expect(view.container.textContent).toContain('From Acme reports');
    // The header adds no padding of its own (it is not inset), so at 320 pixels it and the panel's
    // gap fit in the 96 pixels the design allows (PL8-15, `tests/e2e/plugin-page.spec.ts`).
    expect(
      view.container.querySelector('.cinder-page-header')?.hasAttribute('data-cinder-inset'),
    ).toBe(false);
    expect(view.container.textContent).not.toContain('acme-reports');
    expect(view.container.textContent).not.toContain('reviews/queue');
    // The host serves the page once and the app does not ask again.
    expect(pageReads).toEqual(['acme-reports/queue']);
    // The page's own words never include McpApp's old ones.
    expect(view.queryByText('Loading app…')).toBeNull();
    expect(view.queryByText('This app could not be loaded.')).toBeNull();
  });

  test('names the page by its title in the breadcrumb, never by the plugin or the path', async () => {
    const view = open('/plugins/acme-reports/reviews/queue');
    await ready(view);
    expect(breadcrumbTrail(router.pathname).map(({ label }) => label)).toEqual(['Review queue']);
  });

  test('opens for a caller holding any one scope: a plugin page has no forbidden state of its own', async () => {
    const view = open('/plugins/acme-reports/reviews/queue', ['reviews:read']);
    await ready(view);
    expect(viewOf(view)?.getAttribute('data-state')).toBe('ready');
  });

  test('takes the first panel in the host’s order when two place a page at one path', async () => {
    panels = [
      ACME,
      pagePanel('acme-reports', 'duplicate', 'Second claim', 'reviews/queue', { group: 'work' }),
    ];
    const view = open('/plugins/acme-reports/reviews/queue');
    await ready(view);
    expect(view.getByRole('heading', { level: 1, name: 'Review queue' })).toBeTruthy();
    expect(pageReads).toEqual(['acme-reports/queue']);
  });

  test('waits in one skeleton named for the page, and the frame draws no loading of its own', async () => {
    let release!: () => void;
    heldPage = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = open('/plugins/acme-reports/reviews/queue');
    // The toast region is a status too, so the page's own is the one inside it.
    await waitFor(() =>
      expect(viewOf(view)?.querySelector('[role="status"]')?.textContent).toBe(
        'Loading Review queue',
      ),
    );
    expect(view.queryByText('Loading app…')).toBeNull();
    expect(view.container.querySelector('iframe')).toBeNull();
    // The frame knows the page is loading, though the page draws that state itself.
    expect(viewOf(view)?.getAttribute('data-state')).toBe('loading');
    release();
    await ready(view);
    expect(viewOf(view)?.querySelector('[role="status"]')).toBeNull();
  });

  test('says it could not open the page, with Try again and a way to the plugin’s place in Settings', async () => {
    pageFailures = 1;
    const view = open('/plugins/acme-reports/reviews/queue');
    await waitFor(() =>
      expect(view.getByRole('heading', { name: 'Couldn’t open Review queue' })).toBeTruthy(),
    );
    expect(
      view.getByText('Acme reports didn’t send this page. Nothing you did caused it.'),
    ).toBeTruthy();
    const settings = view.getByRole('link', { name: 'Open Acme reports in Settings' });
    expect(settings.getAttribute('href')).toBe('/settings/plugins?plugin=acme-reports');
    expect(view.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(view.container.querySelector('iframe')).toBeNull();
    // A page that failed to load is the frame's failed state, and reading it once is all it took.
    expect(viewOf(view)?.getAttribute('data-state')).toBe('error');
    expect(pageReads).toEqual(['acme-reports/queue']);
    await fireEvent.click(view.getByRole('button', { name: 'Try again' }));
    await ready(view);
    await waitFor(() => expect(viewOf(view)?.getAttribute('data-state')).toBe('ready'));
    expect(pageReads).toEqual(['acme-reports/queue', 'acme-reports/queue']);
  });

  test('keeps the failed state it showed when the shell already holds the panels and the host answers them slowly', async () => {
    // The sidebar has read the panels before a page opens, and the frame's probe reads them again
    // (`staleTime: 0`). The page mounts in that wait, so a second reader of the page would fetch
    // first, fail, and then lose to the probe's own read, which succeeds: the "Couldn’t open" state
    // would go away by itself with no one asking. The probe is the page's one reader.
    pageFailures = 1;
    let release!: () => void;
    heldPanels = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = open('/plugins/acme-reports/reviews/queue', AUTHORIZATION_SCOPES, (queryClient) =>
      queryClient.setQueryData(queryKeys.hostPanels(), panels),
    );
    // Until the probe has the panels, nothing reads the page.
    await quietFor(50);
    expect(pageReads).toEqual([]);
    release();
    // The frame reports the failure once the probe's read of the page has failed, and there is no
    // other read for it to lose to.
    await waitFor(() => expect(viewOf(view)?.getAttribute('data-state')).toBe('error'));
    expect(view.getByRole('heading', { name: 'Couldn’t open Review queue' })).toBeTruthy();
    expect(
      view.getByText('Acme reports didn’t send this page. Nothing you did caused it.'),
    ).toBeTruthy();
    expect(view.container.querySelector('iframe')).toBeNull();
    expect(pageReads).toEqual(['acme-reports/queue']);
  });

  test('shows the not-found state, with a way to Plugins, for an address no panel places a page at', async () => {
    const view = open('/plugins/acme-reports/missing');
    await waitFor(() => expect(viewOf(view)?.getAttribute('data-state')).toBe('not-found'));
    expect(view.getByRole('heading', { name: 'There’s no page here' })).toBeTruthy();
    expect(
      view.getByText(
        'No plugin offers a page at this address. A plugin’s pages go away while it is disabled.',
      ),
    ).toBeTruthy();
    expect(view.getByRole('link', { name: 'Open Plugins' }).getAttribute('href')).toBe(
      '/settings/plugins',
    );
    expect(view.queryByRole('button', { name: 'Search everything' })).toBeNull();
    expect(view.container.querySelector('iframe')).toBeNull();
  });

  test('says the plugin is disabled when the address names a plugin the host lists as disabled, and a plugin it does not list is only not found', async () => {
    panels = [];
    plugins = [{ name: 'acme-reports', title: 'Acme reports', status: 'disabled' }];
    const disabled = open('/plugins/acme-reports/reviews/queue');
    await waitFor(() =>
      expect(disabled.getByRole('heading', { name: 'Acme reports is disabled' })).toBeTruthy(),
    );
    expect(disabled.getByText('Its pages come back when you enable it and restart.')).toBeTruthy();
    expect(
      disabled.getByRole('link', { name: 'Open Acme reports in Settings' }).getAttribute('href'),
    ).toBe('/settings/plugins?plugin=acme-reports');
    expect(disabled.queryByText('There’s no page here')).toBeNull();
    cleanup();
    restoreHost?.();
    stub?.restore();

    const unknown = open('/plugins/nobody/reviews/queue');
    await waitFor(() =>
      expect(unknown.getByRole('heading', { name: 'There’s no page here' })).toBeTruthy(),
    );
  });

  test('answers not found once the host stops listing the panel, which is what disabling and restarting does', async () => {
    const first = open('/plugins/acme-reports/reviews/queue');
    await ready(first);
    cleanup();
    restoreHost?.();
    stub?.restore();
    panels = [];
    const second = open('/plugins/acme-reports/reviews/queue');
    await waitFor(() => expect(viewOf(second)?.getAttribute('data-state')).toBe('not-found'));
  });

  test('shows a host that cannot list its panels as the page’s own failure, with Try again', async () => {
    panelsStatus = 500;
    const view = open('/plugins/acme-reports/reviews/queue');
    await waitFor(() =>
      expect(view.getByRole('heading', { name: 'Couldn’t open this page' })).toBeTruthy(),
    );
    expect(viewOf(view)?.getAttribute('data-state')).toBe('error');
    panelsStatus = 200;
    await fireEvent.click(view.getByRole('button', { name: 'Try again' }));
    await ready(view);
    await waitFor(() => expect(viewOf(view)?.getAttribute('data-state')).toBe('ready'));
  });

  test('shows its panel under one note when its plugin needs setup, with the key’s dialog for one missing secret', async () => {
    plugins = [
      {
        name: 'acme-reports',
        title: 'Acme reports',
        status: 'needs-setup',
        secrets: [
          { key: 'acme-reports-key', set: false },
          { key: 'acme-reports-other', set: true },
        ],
      },
    ];
    const view = open('/plugins/acme-reports/reviews/queue');
    await ready(view);
    expect(
      view.getByText('Acme reports needs setup, so parts of this page may not work.'),
    ).toBeTruthy();
    expect(view.container.querySelectorAll('.cinder-callout')).toHaveLength(1);
    await fireEvent.click(view.getByRole('button', { name: PLUGIN_PAGE_COPY.needsSetup.addKey }));
    await waitFor(() => expect(view.getByRole('dialog')).toBeTruthy());
  });

  test('links to the plugin in Settings, with no dialog, when more than one secret is missing', async () => {
    plugins = [
      {
        name: 'acme-reports',
        title: 'Acme reports',
        status: 'needs-setup',
        secrets: [
          { key: 'one', set: false },
          { key: 'two', set: false },
        ],
      },
    ];
    const view = open('/plugins/acme-reports/reviews/queue');
    await ready(view);
    expect(view.queryByRole('button', { name: 'Add the key' })).toBeNull();
    expect(
      view.getByRole('link', { name: 'Open Acme reports in Settings' }).getAttribute('href'),
    ).toBe('/settings/plugins?plugin=acme-reports');
  });

  test('shows no note for a plugin that is running', async () => {
    const view = open('/plugins/acme-reports/reviews/queue');
    await ready(view);
    expect(view.container.querySelector('.cinder-callout')).toBeNull();
  });

  test('navigates the host router for a link inside the application, and blocks any other with a toast', async () => {
    const view = open('/plugins/acme-reports/reviews/queue');
    const frame = await ready(view);
    const source = frame.contentWindow as object;
    await initialize(source);

    fromApp(source, { id: 30, method: 'ui/open-link', params: { url: 'https://example.com/x' } });
    await waitFor(() => expect(responseTo(30)).toBeDefined());
    expect(responseTo(30)?.result).toEqual({ isError: true });
    expect(router.pathname).toBe('/plugins/acme-reports/reviews/queue');
    await waitFor(() =>
      expect(
        view.getByText(
          'Review queue tried to open an address outside Interborough, so it was blocked.',
        ),
      ).toBeTruthy(),
    );

    fromApp(source, { id: 31, method: 'ui/open-link', params: { url: '/runs?tab=steps' } });
    // The router moves at once, and the page that held the frame goes with it, so the answer to the
    // app (an empty result, which `mcp-app.test.ts` checks) has no frame left to reach.
    await waitUntil(() => router.pathname === '/runs');
    expect(router.current.search.get('tab')).toBe('steps');
  });

  test('keeps ui/message and resources/read refused', async () => {
    const view = open('/plugins/acme-reports/reviews/queue');
    const frame = await ready(view);
    const source = frame.contentWindow as object;
    await initialize(source);
    fromApp(source, { id: 40, method: 'ui/message', params: { role: 'user', content: [] } });
    fromApp(source, { id: 41, method: 'resources/read', params: { uri: 'ui://x' } });
    await waitFor(() => expect(framePayloads.find((message) => message.id === 41)).toBeDefined());
    expect(framePayloads.find((message) => message.id === 40)).toHaveProperty('error');
    expect(framePayloads.find((message) => message.id === 41)).toHaveProperty('error');
  });
});
