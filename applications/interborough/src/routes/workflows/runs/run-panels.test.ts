/**
 * COR-1894: a plugin's panel on `/runs/:run`. The run page mounts the run inspector through Chat's
 * `McpApp`, labelled with its plugin and sandboxed to `allow-scripts`. The host is a table of
 * answers holding one finished run; the frame's window is a double, and the test plays the app by
 * posting the MCP Apps bridge's messages to the page. The real host serving the same run through
 * the real Bureau is `src/host/host-mcp-apps.test.ts`.
 */
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { HttpClient } from '@lostgradient/weft';
import { cleanup, render, waitFor } from '@testing-library/svelte';
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

import { RUN_PAGE_COPY } from '../../../app/copy.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import { taskFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorldStub,
} from '../../../lib/bureau-world.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { landAt } from '../../chat/pages.test-support.ts';

type FrameMessage = { jsonrpc?: string; id?: number; method?: string; result?: unknown } & Record<
  string,
  unknown
>;

const RUN = taskFixture({ id: 'run-1', status: 'completed', finishReason: 'stop' });
const APP = '/host/plugins/inspectors/apps/run-inspector';
const PAGE_HTML = '<div id="root"></div>';

let stub: BureauWorldStub | undefined;
let restoreHost: (() => void) | undefined;
let toolCalls: { name: string; arguments: unknown }[] = [];
let hostRequests: string[] = [];
let panelsListed = true;
let framePayloads: FrameMessage[] = [];
const frameWindows = new WeakMap<object, { postMessage: (message: FrameMessage) => void }>();
const originalContentWindow = Object.getOwnPropertyDescriptor(
  HTMLIFrameElement.prototype,
  'contentWindow',
);
let debug: ReturnType<typeof spyOn<Console, 'debug'>>;

/** What the host answers for the finished run: `bureau.tasks.inspect`'s result, or a refusal. */
function hostAnswer(path: string, init: RequestInit | undefined): Response | undefined {
  if (path === '/host/mcp-apps') {
    hostRequests.push(path);
    if (!panelsListed) return new Response('Not found', { status: 404 });
    return Response.json({
      apps: [
        {
          plugin: 'inspectors',
          app: 'run-inspector',
          title: 'Run inspector',
          uri: 'ui://bureau/run-inspector/v1',
          opensFromTool: 'bureau.tasks.inspect',
        },
        {
          plugin: 'inspectors',
          app: 'pending-review',
          title: 'Pending reviews',
          uri: 'ui://bureau/pending-review/v1',
          opensFromTool: 'bureau.reviews.list',
        },
      ],
    });
  }
  if (path === APP) return Response.json({ html: PAGE_HTML, ui: {} });
  if (path === `${APP}/tool-calls`) {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as {
      name: string;
      arguments: unknown;
    };
    toolCalls.push(body);
    if (body.name !== 'bureau.tasks.inspect') return Response.json({ error: 'x' }, { status: 403 });
    return Response.json({
      content: [{ type: 'text', text: 'Run run-1: completed' }],
      structuredContent: { task: { id: RUN.id, status: RUN.status }, children: [] },
    });
  }
  return undefined;
}

beforeAll(() => {
  debug = spyOn(console, 'debug').mockImplementation(() => {});
});
afterAll(() => debug.mockRestore());

beforeEach(() => {
  sessionStorage.clear();
  toolCalls = [];
  hostRequests = [];
  panelsListed = true;
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

/** The path a request names, whichever form the client passed it in. */
const pathOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;

function openRun() {
  stub = installBureauWorld(emptyBureauWorld({ tasks: [RUN] }));
  stub.on('bureau.goals.list', () => ({ goals: [], nextOffset: null }));
  stub.on('bureau.contexts.list', () => ({ contexts: [], nextOffset: null }));
  stub.on('bureau.agents.list', () => ({ agents: [] }));
  // The Bureau's stub answers 404 to anything it does not serve; the host's panel routes go first.
  const bureauFetch = globalThis.fetch;
  const withHost = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(hostAnswer(pathOf(input), init) ?? bureauFetch(input, init)),
    { preconnect: bureauFetch.preconnect },
  );
  globalThis.fetch = withHost;
  restoreHost = () => {
    globalThis.fetch = bureauFetch;
  };
  landAt('/runs/run-1');
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

/** Plays the app: posts a JSON-RPC message to the host from the iframe's window. */
function fromApp(source: object, data: Record<string, unknown>): void {
  // happy-dom's `MessageEvent` takes only a real `MessagePort` as its source, and the frame here is
  // a double, so the event is a plain one carrying the two fields the bridge reads.
  window.dispatchEvent(
    Object.assign(new window.Event('message'), { data: { jsonrpc: '2.0', ...data }, source }),
  );
}

async function initialize(source: object): Promise<void> {
  fromApp(source, {
    id: 1,
    method: 'ui/initialize',
    params: {
      appInfo: { name: 'bureau-run-inspector', version: '1.0.0' },
      appCapabilities: {},
      protocolVersion: '2026-01-26',
    },
  });
  await waitFor(() => expect(responseTo(1)).toBeDefined());
  fromApp(source, { method: 'ui/notifications/initialized' });
  await waitFor(() =>
    expect(framePayloads.some((message) => message.method === 'ui/notifications/tool-input')).toBe(
      true,
    ),
  );
}

const responseTo = (id: number) =>
  framePayloads.find((message) => message.id === id && !('method' in message));

async function panelFrame(view: ReturnType<typeof openRun>): Promise<HTMLIFrameElement> {
  await waitFor(() =>
    expect(view.container.querySelector('[data-section="plugin-panel"] iframe')).not.toBeNull(),
  );
  return view.container.querySelector('[data-section="plugin-panel"] iframe') as HTMLIFrameElement;
}

describe('the run inspector on a run’s page', () => {
  test('renders in a frame sandboxed to allow-scripts, labelled with its plugin', async () => {
    const view = openRun();
    const frame = await panelFrame(view);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('srcdoc')).toContain(PAGE_HTML);
    const panel = view.container.querySelector('[data-section="plugin-panel"]') as HTMLElement;
    expect(panel.dataset['plugin']).toBe('inspectors');
    expect(panel.textContent).toContain('Run inspector');
    expect(panel.textContent).toContain(RUN_PAGE_COPY.panelFromPlugin('inspectors'));
  });

  test('shows only the panels that open from the run inspector’s tool', async () => {
    const view = openRun();
    await panelFrame(view);
    expect(view.container.querySelectorAll('[data-section="plugin-panel"]')).toHaveLength(1);
    expect(view.container.textContent).not.toContain('Pending reviews');
  });

  test('opens the panel on the run, and loads the run’s data through bureau.tasks.inspect', async () => {
    const view = openRun();
    const frame = await panelFrame(view);
    const source = frame.contentWindow as object;
    await initialize(source);
    const input = framePayloads.find((message) => message.method === 'ui/notifications/tool-input');
    expect(input?.['params']).toMatchObject({ arguments: { taskId: 'run-1' } });

    fromApp(source, {
      id: 7,
      method: 'tools/call',
      params: { name: 'bureau.tasks.inspect', arguments: { taskId: 'run-1' } },
    });
    await waitFor(() => expect(responseTo(7)).toBeDefined());
    expect(toolCalls).toEqual([{ name: 'bureau.tasks.inspect', arguments: { taskId: 'run-1' } }]);
    expect(responseTo(7)?.result).toMatchObject({
      structuredContent: { task: { id: 'run-1', status: 'completed' } },
    });
  });

  test('tells the app a tool it may not call failed, and says nothing of why', async () => {
    const view = openRun();
    const frame = await panelFrame(view);
    const source = frame.contentWindow as object;
    await initialize(source);
    fromApp(source, {
      id: 8,
      method: 'tools/call',
      params: { name: 'bureau.reviews.resolve', arguments: {} },
    });
    await waitFor(() => expect(responseTo(8)).toBeDefined());
    expect(responseTo(8)?.result).toMatchObject({ isError: true });
  });
});

describe('a run on a host with no panels', () => {
  test('shows no panel when the host cannot list them', async () => {
    panelsListed = false;
    const view = openRun();
    await waitUntil(() => hostRequests.includes('/host/mcp-apps'));
    await waitFor(() => expect(view.container.querySelector('article')).not.toBeNull());
    // Nothing is going to appear, so the check is that the page stays as it was.
    await quietFor(50);
    expect(view.container.querySelector('[data-section="plugin-panel"]')).toBeNull();
  });
});
