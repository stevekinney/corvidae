/**
 * COR-1894: a plugin's panel on `/runs/:run`. The run page mounts the run inspector through Chat's
 * `McpApp`, labelled with its plugin and sandboxed to `allow-scripts`. The host is a table of
 * answers holding one finished run; the frame's window is a double, and the test plays the app by
 * posting the MCP Apps bridge's messages to the page. The real host serving the same run through
 * the real Bureau is `src/host/host-panels.test.ts`.
 */
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { HttpClient } from '@lostgradient/weft';
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

import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import { taskFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorldStub,
} from '../../../lib/bureau-world.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { landAt } from '../../chat/pages.test-support.ts';
import { panelHasSomethingToSay } from './run-panel-scope.ts';
import RunPanelsHarness from './run-panels.test-harness.svelte';

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
/** Panels the host lists beside the fixture's own, for the tests of which kind of run each is mounted on. */
let extraPanels: readonly unknown[] = [];
let framePayloads: FrameMessage[] = [];
const frameWindows = new WeakMap<object, { postMessage: (message: FrameMessage) => void }>();
const originalContentWindow = Object.getOwnPropertyDescriptor(
  HTMLIFrameElement.prototype,
  'contentWindow',
);
let debug: ReturnType<typeof spyOn<Console, 'debug'>>;

/** What the host answers for the finished run: `bureau.tasks.inspect`'s result, or a refusal. */
function hostAnswer(path: string, init: RequestInit | undefined): Response | undefined {
  if (path === '/host/panels') {
    hostRequests.push(path);
    if (!panelsListed) return new Response('Not found', { status: 404 });
    return Response.json({
      apps: [
        // Listed first, but ordered last: plugin names sort ahead of the order the host lists them in.
        {
          plugin: 'zebra',
          app: 'summary',
          title: 'Zebra summary',
          uri: 'ui://zebra/summary/v1',
          placements: [{ kind: 'run' }],
        },
        {
          plugin: 'inspectors',
          app: 'run-inspector',
          title: 'Run inspector',
          uri: 'ui://inspectors/run-inspector/v1',
          opensFromTool: 'bureau.tasks.inspect',
          placements: [{ kind: 'run' }],
        },
        {
          plugin: 'inspectors',
          app: 'pending-review',
          title: 'Pending reviews',
          uri: 'ui://inspectors/pending-review/v1',
          opensFromTool: 'bureau.reviews.list',
          placements: [],
        },
        // The same plugin's second run panel, which opens from no tool at all.
        {
          plugin: 'inspectors',
          app: 'run-notes',
          title: 'Run notes',
          uri: 'ui://inspectors/run-notes/v1',
          placements: [{ kind: 'page', path: 'notes' }, { kind: 'run' }],
        },
        // Opens from the run inspector's tool, but declares no run placement: not on the page.
        {
          plugin: 'inspectors',
          app: 'legacy-inspector',
          title: 'Legacy inspector',
          uri: 'ui://inspectors/legacy-inspector/v1',
          opensFromTool: 'bureau.tasks.inspect',
          placements: [{ kind: 'chat-tool', agentTool: 'bureau:legacy' }],
        },
        ...extraPanels,
      ],
    });
  }
  if (
    path.startsWith('/host/plugins/') &&
    path.includes('/apps/') &&
    !path.endsWith('/tool-calls')
  ) {
    return Response.json({ html: PAGE_HTML, ui: {} });
  }
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

/**
 * The panels sit in the Inspector tab of How it ran (row 54i), which a finished run's page gives
 * closed, so a person opens it and then chooses the tab to reach them.
 */
async function openInspector(view: ReturnType<typeof openRun>): Promise<void> {
  const trigger = await view.findByRole('button', { name: RUN_DETAIL_COPY.howItRan.heading });
  if (trigger.getAttribute('aria-expanded') !== 'true') await fireEvent.click(trigger);
  await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'));
  const tab = await view.findByRole('tab', { name: RUN_DETAIL_COPY.howItRan.tabs.inspector });
  if (tab.getAttribute('aria-selected') !== 'true') await fireEvent.click(tab);
  await waitFor(() => expect(tab.getAttribute('aria-selected')).toBe('true'));
}

async function panelFrame(view: ReturnType<typeof openRun>): Promise<HTMLIFrameElement> {
  await openInspector(view);
  await waitFor(() =>
    expect(view.container.querySelector('[data-section="plugin-panel"] iframe')).not.toBeNull(),
  );
  return view.container.querySelector('[data-section="plugin-panel"] iframe') as HTMLIFrameElement;
}

describe('the run inspector on a run’s page', () => {
  test('renders in a frame sandboxed to allow-scripts, in a region named for the panel, with no card title or plugin line', async () => {
    const view = openRun();
    const frame = await panelFrame(view);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('srcdoc')).toContain(PAGE_HTML);
    const panel = view.container.querySelector('[data-section="plugin-panel"]') as HTMLElement;
    expect(panel.dataset['plugin']).toBe('inspectors');
    // The panel draws its own heading, so the host adds neither a title nor a "From the … plugin"
    // line; the region keeps the panel's name for a screen reader.
    expect(panel.getAttribute('aria-label')).toBe('Run inspector');
    expect(panel.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    expect(panel.textContent).toBe('');
    expect(view.container.textContent).not.toContain('plugin');
  });

  test('shows every panel with a run placement, ordered by plugin name and then declaration order', async () => {
    const view = openRun();
    await panelFrame(view);
    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-section="plugin-panel"] iframe')).toHaveLength(
        3,
      ),
    );
    const sections = [
      ...view.container.querySelectorAll<HTMLElement>('[data-section="plugin-panel"]'),
    ];
    expect(sections.map((section) => section.dataset['plugin'])).toEqual([
      'inspectors',
      'inspectors',
      'zebra',
    ]);
    expect(sections.map((section) => section.getAttribute('aria-label'))).toEqual([
      'Run inspector',
      'Run notes',
      'Zebra summary',
    ]);
    // Each section names its own app, so two panels of one plugin can be told apart.
    expect(new Set(sections.map((section) => section.dataset['app'])).size).toBe(3);
    expect(sections[0]?.dataset['app']).toBe('run-inspector');
    // A panel with no run placement stays off the page, whatever tool it opens from.
    expect(view.container.textContent).not.toContain('Pending reviews');
    expect(view.container.textContent).not.toContain('Legacy inspector');
  });

  test('renders a fixture plugin’s second run panel next to the run inspector, each sent the run', async () => {
    const view = openRun();
    await panelFrame(view);
    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-section="plugin-panel"] iframe')).toHaveLength(
        3,
      ),
    );
    const titles = [...view.container.querySelectorAll('[data-section="plugin-panel"] iframe')].map(
      (frame) => frame.getAttribute('title'),
    );
    expect(titles).toEqual(['Run inspector', 'Run notes', 'Zebra summary']);
    for (const frame of view.container.querySelectorAll<HTMLIFrameElement>(
      '[data-section="plugin-panel"] iframe',
    )) {
      await initialize(frame.contentWindow as object);
    }
    const toolInputs = () =>
      framePayloads.filter((message) => message.method === 'ui/notifications/tool-input');
    await waitFor(() => expect(toolInputs()).toHaveLength(3));
    for (const input of toolInputs()) {
      expect(input['params']).toMatchObject({ arguments: { taskId: 'run-1' } });
    }
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

/** Mounts the panels for a run the test names, on a host that answers only the panel routes. */
function openPanels(run: { taskId: string } | { workflowId: string; fork: boolean }) {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        hostAnswer(pathOf(input), init) ?? new Response('Not found', { status: 404 }),
      ),
    { preconnect: original.preconnect },
  );
  restoreHost = () => {
    globalThis.fetch = original;
  };
  return render(RunPanelsHarness, { props: run } as never);
}

/** The arguments each panel's frame is sent as its tool input, once every frame has initialized. */
async function toolInputsOf(
  view: ReturnType<typeof openPanels>,
  count: number,
): Promise<unknown[]> {
  await waitFor(() =>
    expect(view.container.querySelectorAll('[data-section="plugin-panel"] iframe')).toHaveLength(
      count,
    ),
  );
  for (const frame of view.container.querySelectorAll<HTMLIFrameElement>(
    '[data-section="plugin-panel"] iframe',
  )) {
    await initialize(frame.contentWindow as object);
  }
  const inputs = () =>
    framePayloads.filter((message) => message.method === 'ui/notifications/tool-input');
  await waitFor(() => expect(inputs()).toHaveLength(count));
  return inputs().map((message) => (message['params'] as { arguments: unknown }).arguments);
}

/** The two inspectors panels whose mounting depends on the kind of run, listed beside the fixture's. */
const SCOPED_PANELS = [
  {
    plugin: 'inspectors',
    app: 'schedule-editor',
    title: 'Schedule editor',
    uri: 'ui://inspectors/schedule-editor/v1',
    placements: [{ kind: 'page', path: 'schedules' }, { kind: 'run' }],
  },
  {
    plugin: 'inspectors',
    app: 'run-comparison',
    title: 'Run comparison',
    uri: 'ui://inspectors/run-comparison/v1',
    opensFromTool: 'bureau.runs.compare',
    placements: [{ kind: 'run' }],
  },
];

/** The `data-app` of every panel the page mounted for the run, once the host's list has landed. */
async function mountedApps(
  view: ReturnType<typeof openPanels>,
  expectedCount: number,
): Promise<string[]> {
  await waitFor(() =>
    expect(view.container.querySelectorAll('[data-section="plugin-panel"]')).toHaveLength(
      expectedCount,
    ),
  );
  return [...view.container.querySelectorAll<HTMLElement>('[data-section="plugin-panel"]')].map(
    (section) => section.dataset['app'] ?? '',
  );
}

describe('the panels on a workflow instance’s run page (COR-2544, owner 2026-11-22)', () => {
  test('mounts the panels that have something to say about an instance, each sent the engine’s run and no task', async () => {
    const view = openPanels({ workflowId: 'wf-fork-1', fork: false });
    const inputs = await toolInputsOf(view, 2);
    // The run inspector reads an agent task, and a workflow instance has none: it is not mounted.
    expect(inputs).toEqual([
      { runId: 'wf-fork-1', runKind: 'workflow' },
      { runId: 'wf-fork-1', runKind: 'workflow' },
    ]);
    const sections = [
      ...view.container.querySelectorAll<HTMLElement>('[data-section="plugin-panel"]'),
    ];
    expect(sections.map((section) => section.dataset['app'])).toEqual(['run-notes', 'summary']);
  });

  test('sends an agent run its task, as it always was', async () => {
    const view = openPanels({ taskId: 'run-1' });
    expect(await toolInputsOf(view, 3)).toEqual([
      { taskId: 'run-1' },
      { taskId: 'run-1' },
      { taskId: 'run-1' },
    ]);
  });
});

describe('which panels have something to say about a run', () => {
  beforeEach(() => {
    extraPanels = SCOPED_PANELS;
  });
  afterEach(() => {
    extraPanels = [];
  });

  test('a fork gets the run comparison, and neither the run inspector nor the schedule editor', async () => {
    const view = openPanels({ workflowId: 'wf-fork-1', fork: true });
    // Plugin by name, then the order the host lists a plugin's panels in.
    expect(await mountedApps(view, 3)).toEqual(['run-notes', 'run-comparison', 'summary']);
    // The comparison is sent the fork's own run, to compare with its source.
    const comparison = view.container.querySelector<HTMLIFrameElement>(
      '[data-section="plugin-panel"][data-app="run-comparison"] iframe',
    );
    expect(comparison).not.toBeNull();
    await initialize(comparison?.contentWindow as object);
    await waitFor(() =>
      expect(
        framePayloads.find((m) => m.method === 'ui/notifications/tool-input')?.['params'],
      ).toEqual({
        arguments: { runId: 'wf-fork-1', runKind: 'workflow' },
      }),
    );
  });

  test('a workflow instance that is not a fork gets no comparison, no run inspector and no schedule editor', async () => {
    const view = openPanels({ workflowId: 'wf-plain-1', fork: false });
    const apps = await mountedApps(view, 2);
    expect(apps).toEqual(['run-notes', 'summary']);
    expect(apps).not.toContain('run-comparison');
    expect(apps).not.toContain('run-inspector');
    // The schedule editor lists every schedule and cannot narrow them to this run's workflow.
    expect(apps).not.toContain('schedule-editor');
  });

  test('an agent run gets the run inspector and the schedule editor, and no comparison', async () => {
    const view = openPanels({ taskId: 'run-1' });
    const apps = await mountedApps(view, 4);
    expect(apps).toEqual(['run-inspector', 'run-notes', 'schedule-editor', 'summary']);
    expect(apps).not.toContain('run-comparison');
  });
});

describe('the mounting rules, as data', () => {
  test('say what each inspectors panel has to say, and leave a panel with no rule on every run', () => {
    const task = { kind: 'task' } as const;
    const fork = { kind: 'workflow', fork: true } as const;
    const plain = { kind: 'workflow', fork: false } as const;
    const table = (plugin: string, app: string) =>
      [task, plain, fork].map((run) => panelHasSomethingToSay(plugin, app, run));
    expect(table('inspectors', 'run-inspector')).toEqual([true, false, false]);
    expect(table('inspectors', 'schedule-editor')).toEqual([true, false, false]);
    expect(table('inspectors', 'run-comparison')).toEqual([false, false, true]);
    // A third party's panel, and a name that only looks like an inherited key, have no rule.
    expect(table('zebra', 'summary')).toEqual([true, true, true]);
    expect(table('inspectors', 'constructor')).toEqual([true, true, true]);
  });
});

describe('a run on a host with no panels', () => {
  test('shows no panel when the host cannot list them', async () => {
    panelsListed = false;
    const view = openRun();
    await openInspector(view);
    await waitUntil(() => hostRequests.includes('/host/panels'));
    await waitFor(() => expect(view.container.querySelector('article')).not.toBeNull());
    // Nothing is going to appear, so the check is that the page stays as it was.
    await quietFor(50);
    expect(view.container.querySelector('[data-section="plugin-panel"]')).toBeNull();
  });
});
