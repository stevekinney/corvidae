/**
 * The view frame (`view-frame.svelte`): every view has a loading, an empty, an error, and a
 * forbidden state, each carrying `data-state` and the words `copy.ts` holds, and a view that is
 * none of those shows its content. The matrix below drives every view into every state the way
 * the server would, with a stubbed `fetch` answering the view's probe.
 */
import { HttpClient } from '@lostgradient/weft';
import { type QueryClient } from '@tanstack/svelte-query';
import { render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, jest, test } from 'bun:test';

import { taskFixture, toolApprovalFixture } from '../lib/bureau-fixtures.test-support.ts';
import { settle, until } from '../lib/fake-timers.test-support.ts';
import { installFetchImplementation } from '../lib/live-source/fetch.test-support.ts';
import { router } from '../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES, type PrincipalStore } from '../lib/scopes.svelte.ts';
import {
  codeDefinition,
  emptyWorld,
  installWorkflowWorld,
  readyFile,
  sourceDefinition,
  workflowFaults,
  type WorkflowStub,
  type World,
} from '../lib/workflow-world.test-support.ts';
import { FORBIDDEN_COPY, RETRY_LABEL, VIEW_COPY } from './copy.ts';
import Harness from './view-frame.test-harness.svelte';
import { probeFor, RUNS_RECHECK_MS } from './view-probes.ts';
import { VIEW_NAMES, VIEWS, type ViewName } from './views.ts';

type Outcome = 'content' | 'empty' | 'error' | 'forbidden';

let restore: (() => void) | undefined;
afterEach(() => {
  jest.useRealTimers();
  restore?.();
  restore = undefined;
});

const CONTEXT = {
  id: 'session-1',
  owner: 'anonymous:local',
  agentName: 'assistant',
  title: 'Hello',
  lastMessagePreview: null,
  parentContextId: null,
  forkedFromMessageId: null,
  model: null,
  effort: null,
  permissionMode: 'on-changes',
  configVersion: 0,
  messageCount: 2,
  createdAt: '2026-10-19T00:00:00.000Z',
  updatedAt: '2026-10-19T00:00:00.000Z',
  activity: 'idle',
};

const AGENT = {
  name: 'assistant',
  displayName: 'Assistant',
  description: null,
  definitionRevision: 1,
  kind: 'code',
  a2a: false,
};

function codeSummary() {
  const {
    contractHash: _hash,
    contract: _contract,
    ...summary
  } = codeDefinition('order-processing');
  return summary;
}

const HOOK = {
  id: 'hook-1',
  owner: 'anonymous:local',
  name: null,
  action: { type: 'notify', title: null },
  events: ['review.requested'],
  scope: null,
  lastDelivery: null,
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  revision: 1,
};

const GOAL = {
  goalRunId: 'goal-1',
  owner: 'anonymous:local',
  agentName: 'assistant',
  status: 'running',
  terminalReason: null,
  revision: 1,
  createdAt: '2026-10-19T08:00:00.000Z',
  updatedAt: '2026-10-19T08:00:00.000Z',
  closedAt: null,
  cancellation: null,
  bounds: {
    maximumAttempts: 3,
    maximumTotalDurationMs: null,
    maximumTotalSteps: null,
    maximumTotalTokens: null,
    maximumTotalCostUsd: null,
  },
  usage: { attempts: 0, steps: 0, tokens: 0, costUsd: null, durationMs: 0 },
  attempts: [],
};

const AUDIT_RECORD = {
  sequence: 1,
  timestamp: '2026-10-19T08:00:00.000Z',
  type: 'run.completed',
  resource: 'run-1',
  principal: null,
  detail: null,
};

function requestUrl(input: RequestInfo | URL): URL {
  const text = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(text, 'http://localhost');
}

function operationOf(body: RequestInit['body']): { id: unknown; method: string } | undefined {
  if (typeof body !== 'string') return undefined;
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const method: unknown = Reflect.get(parsed, 'method');
  return typeof method === 'string' ? { id: Reflect.get(parsed, 'id'), method } : undefined;
}

/** What each view's probe asks for, and the answer that makes the view empty or not. */
function answer(view: ViewName, outcome: Outcome, input: RequestInfo | URL, init?: RequestInit) {
  if (outcome === 'error') return Response.json({ error: 'The server broke.' }, { status: 500 });
  if (outcome === 'forbidden') return Response.json({ error: 'Forbidden' }, { status: 403 });
  const empty = outcome === 'empty';
  const url = requestUrl(input);
  const call = operationOf(init?.body);
  if (call !== undefined && call.method === 'bureau.audit.query') {
    const records = empty ? [] : [AUDIT_RECORD];
    return Response.json({ jsonrpc: '2.0', id: call.id, result: { records, nextCursor: null } });
  }
  if (call !== undefined && call.method === 'bureau.settings.get') {
    // The settings are never empty: the probe only asks whether the Bureau answers them.
    const result = {
      values: {},
      effective: {},
      running: {},
      revision: 0,
      persisted: true,
      keys: {},
    };
    return Response.json({ jsonrpc: '2.0', id: call.id, result });
  }
  if (call !== undefined && call.method === 'bureau.goals.list') {
    const goals = empty ? [] : [GOAL];
    return Response.json({ jsonrpc: '2.0', id: call.id, result: { goals, nextOffset: null } });
  }
  if (call !== undefined && call.method === 'bureau.hooks.list') {
    const hooks = empty ? [] : [HOOK];
    return Response.json({ jsonrpc: '2.0', id: call.id, result: { hooks } });
  }
  if (call !== undefined) {
    // The Bureau's list operations answer their own shapes, and an empty one has nothing in it.
    const result =
      call.method === 'bureau.contexts.list'
        ? { contexts: empty ? [] : [{ ...CONTEXT }], nextOffset: null }
        : call.method === 'bureau.agents.list'
          ? { agents: empty ? [] : [{ ...AGENT }] }
          : call.method === 'bureau.agents.catalog'
            ? // The agent editor's probe parses the catalog, so it answers one.
              { models: [], tools: [] }
            : call.method === 'bureau.tasks.list'
              ? { tasks: empty ? [] : [taskFixture()], nextPageToken: null }
              : call.method === 'bureau.reviews.list'
                ? { reviews: empty ? [] : [toolApprovalFixture()] }
                : call.method === 'weft.workflows.definitions.list'
                  ? // The Workflows list joins the engine's definitions with the Bureau's files.
                    { definitions: empty ? [] : [codeSummary()] }
                  : call.method === 'bureau.workflows.list'
                    ? { workflows: [], nextOffset: null }
                    : { items: [] };
    return Response.json({ jsonrpc: '2.0', id: call.id, result });
  }
  if (url.pathname.endsWith('/schedules')) {
    return Response.json({ items: empty ? [] : [{ id: 'schedule-1' }], total: empty ? 0 : 1 });
  }
  if (url.pathname.endsWith('/reviews')) {
    return Response.json({ items: empty ? [] : [{ id: 'review-1' }] });
  }
  if (url.pathname.endsWith('/workflows')) {
    return Response.json({ items: empty ? [] : [{ id: 'run-1' }], total: empty ? 0 : 1 });
  }
  throw new Error(`The ${view} probe made an unexpected request: ${url.href}`);
}

function stub(view: ViewName, outcome: Outcome): { requests: URL[] } {
  const requests: URL[] = [];
  restore = installFetchImplementation(async (input, init) => {
    requests.push(requestUrl(input));
    return answer(view, outcome, input, init);
  });
  return { requests };
}

function mount(
  view: ViewName,
  options: {
    scopes?: readonly string[];
    parameters?: Record<string, string>;
    pattern?: string;
  } = {},
) {
  let store: PrincipalStore | undefined;
  let queryClient: QueryClient | undefined;
  const result = render(Harness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: options.scopes ?? AUTHORIZATION_SCOPES,
      view,
      parameters: options.parameters ?? {},
      ...(options.pattern === undefined ? {} : { pattern: options.pattern }),
      onStore: (created: PrincipalStore) => {
        store = created;
      },
      onQueryClient: (created: QueryClient) => {
        queryClient = created;
      },
    },
  } as never);
  return { ...result, store: () => store, queryClient: () => queryClient };
}

/**
 * How a view is mounted to read its probe's states. The list of chats asks no probe (it words its
 * own states in its pane), so the chat view's probe states are those of a new chat, which asks
 * whether an agent can run.
 */
function mountWithProbe(view: ViewName, options: Parameters<typeof mount>[1] = {}) {
  return mount(view, view === 'chat' ? { pattern: '/chats/new', ...options } : options);
}

function frame(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('.weft-view');
  if (element === null) throw new Error('The view frame did not render.');
  return element;
}

/**
 * The views whose probe turns a failure into the frame's error state. The reviews probe does not:
 * it lets only a refusal or a 401 through, and shows the Bureau's other failures in a banner beside
 * the engine's reviews (see "the Reviews view", which asserts that and the 401).
 */
const VIEWS_THAT_CAN_FAIL = VIEW_NAMES.filter(
  (view) =>
    view !== 'reviews' &&
    view !== 'health' &&
    view !== 'home' &&
    VIEWS[view].ownsStates !== true &&
    // A page that words its own failure shows itself, with its navigation and heading, instead.
    VIEWS[view].pageOwnsFailure !== true,
);

/** The views that draw their own loading, empty and failed states under their own header. */
const VIEWS_THAT_OWN_THEIR_STATES = VIEW_NAMES.filter((view) => VIEWS[view].ownsStates === true);

// Health is left out of the probe cases below: it asks the server nothing before it shows. Its
// bands each read with their own scope, so a probe needing one scope would turn away a principal
// holding the other (see "the Health view"). Home asks nothing either: each of its cards reads on
// its own, so one failing read shows inside its own card and never replaces the page.

describe('every view whose probe fails the page, when its probe fails', () => {
  for (const view of VIEWS_THAT_CAN_FAIL) {
    const copy = VIEW_COPY[view];

    // A new chat words its own failure: the agents it starts with could not be read.
    const words =
      view === 'chat' ? (copy.errorByPattern?.['/chats/new'] ?? copy.error) : copy.error;

    test(`${view} is failing when its probe fails`, async () => {
      stub(view, 'error');
      const { container, findByRole, getByRole } = mountWithProbe(view);
      expect(await findByRole('heading', { level: 1, name: words.title })).not.toBeNull();
      expect(frame(container).dataset['state']).toBe('error');
      expect(container.textContent).toContain(words.description);
      expect(getByRole('button', { name: RETRY_LABEL })).not.toBeNull();
    });
  }
});

describe('every view, in every state', () => {
  for (const view of VIEW_NAMES) {
    const copy = VIEW_COPY[view];

    test(`${view} is empty when its probe finds nothing, with its own words`, async () => {
      // The chat view is empty only where it asks a probe: a new chat, with no agent to start it.
      const emptyCopy = view === 'chat' ? copy.emptyByPattern?.['/chats/new'] : copy.empty;
      if (!VIEWS[view].canBeEmpty || emptyCopy === undefined || VIEWS[view].ownsStates) return;
      stub(view, 'empty');
      const { container, findByRole } = mountWithProbe(view);
      const heading = await findByRole('heading', { level: 1, name: emptyCopy.title });
      expect(heading).not.toBeNull();
      expect(frame(container).dataset['view']).toBe(view);
      expect(frame(container).dataset['state']).toBe('empty');
      expect(container.textContent).toContain(emptyCopy.description);
    });

    test(`${view} is forbidden when its probe is refused`, async () => {
      if (view === 'health' || view === 'home') return;
      stub(view, 'forbidden');
      const { container, findByRole } = mountWithProbe(view);
      expect(await findByRole('heading', { level: 1, name: copy.forbidden.title })).not.toBeNull();
      expect(frame(container).dataset['state']).toBe('forbidden');
    });

    test(`${view} is loading while its probe is pending`, async () => {
      if (view === 'health' || view === 'home' || VIEWS[view].ownsStates) return;
      restore = installFetchImplementation(() => new Promise<Response>(() => {}));
      if (VIEWS[view].pageOwnsLoading === true) {
        // The page draws its own loading, so its content is on screen and the frame's words are not.
        const { container, findByTestId, queryByRole } = mount(view);
        expect(await findByTestId('content')).not.toBeNull();
        expect(frame(container).dataset['state']).toBe('loading');
        expect(queryByRole('heading', { level: 1, name: copy.loading.title })).toBeNull();
        return;
      }
      const { container, findByRole, findByTestId } = mountWithProbe(view);
      // A new chat is drawn as its own page in placeholders, with the composer already there.
      if (view === 'chat') {
        expect(await findByTestId('new-chat-loading')).not.toBeNull();
      } else {
        expect(await findByRole('heading', { level: 1, name: copy.loading.title })).not.toBeNull();
        expect(container.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
      }
      expect(frame(container).dataset['state']).toBe('loading');
    });
  }

  test('a view whose scopes are missing is forbidden without asking the server anything', () => {
    for (const view of VIEW_NAMES) {
      if (VIEWS[view].scopes.length === 0) continue;
      const { requests } = stub(view, 'content');
      const { container, unmount } = mount(view, { scopes: [] });
      expect(frame(container).dataset['state']).toBe('forbidden');
      expect(container.textContent).toContain(`requires ${VIEWS[view].scopes.join(' or ')}`);
      expect(requests).toEqual([]);
      unmount();
      restore?.();
    }
  });
});

describe('the Home view', () => {
  test('opens with no scope and asks nothing before it shows', async () => {
    expect(VIEWS.home.scopes).toEqual([]);
    expect(VIEWS.home.canBeEmpty).toBe(false);
    const { requests } = stub('home', 'content');
    const { container, findByTestId } = mount('home', { scopes: [] });
    expect(await findByTestId('content')).not.toBeNull();
    expect(frame(container).dataset['state']).toBe('ready');
    expect(requests).toEqual([]);
  });
});

describe('the Health view', () => {
  test('opens for system:read alone and for workflows:read alone, and asks nothing to do so', async () => {
    expect(VIEWS.health.scopes).toEqual(['system:read', 'workflows:read']);
    for (const scope of ['system:read', 'workflows:read'] as const) {
      const { requests } = stub('health', 'content');
      const { container, findByTestId, unmount } = mount('health', { scopes: [scope] });
      expect(await findByTestId('content')).not.toBeNull();
      expect(frame(container).dataset['state']).toBe('ready');
      expect(requests).toEqual([]);
      unmount();
      restore?.();
    }
  });

  test('is forbidden for a principal holding neither scope, and names both', () => {
    const { requests } = stub('health', 'content');
    const { container } = mount('health', { scopes: ['schedules:read'] });
    expect(frame(container).dataset['state']).toBe('forbidden');
    expect(container.textContent).toContain('requires system:read or workflows:read');
    expect(requests).toEqual([]);
  });
});

describe('a view that finds something to show', () => {
  for (const view of VIEW_NAMES) {
    test(`${view} renders its content`, async () => {
      stub(view, 'content');
      const { container, findByTestId } = mount(view);
      expect(await findByTestId('content')).not.toBeNull();
      // A page that draws its own loading, or a view that owns its states, is on screen before the probe answers.
      await waitFor(() => expect(frame(container).dataset['state']).toBe('ready'));
    });
  }

  test('one run’s page has no probe and shows its content once its scope is held', async () => {
    const { requests } = stub('runs', 'content');
    const { container, findByTestId } = mount('runs', { parameters: { run: 'run-1' } });
    expect(await findByTestId('content')).not.toBeNull();
    expect(frame(container).dataset['state']).toBe('ready');
    expect(requests).toEqual([]);
  });
});

describe('a view that owns its states', () => {
  test('is a page that keeps its header: the schedules list and the Health Workers and Audit log tabs', () => {
    expect(VIEWS_THAT_OWN_THEIR_STATES).toEqual(['schedules', 'workers', 'audit']);
  });

  for (const view of VIEWS_THAT_OWN_THEIR_STATES) {
    const copy = VIEW_COPY[view];

    test(`${view} renders its page, and says empty in data-state, when its probe finds nothing`, async () => {
      // A view that cannot be empty has no empty state to say (the Workers tab draws its own).
      if (!VIEWS[view].canBeEmpty) return;
      stub(view, 'empty');
      const { container, findByTestId, queryByRole } = mount(view);
      expect(await findByTestId('content')).not.toBeNull();
      await waitFor(() => expect(frame(container).dataset['state']).toBe('empty'));
      // The frame says nothing of its own: the page draws the empty state under its header.
      expect(queryByRole('heading', { level: 1, name: copy.empty?.title ?? '' })).toBeNull();
    });

    test(`${view} renders its page, and says error in data-state, when its probe fails`, async () => {
      stub(view, 'error');
      const { container, findByTestId, queryByRole } = mount(view);
      expect(await findByTestId('content')).not.toBeNull();
      await waitFor(() => expect(frame(container).dataset['state']).toBe('error'));
      expect(queryByRole('heading', { name: copy.error.title })).toBeNull();
      expect(queryByRole('button', { name: RETRY_LABEL })).toBeNull();
    });

    test(`${view} renders its page, and says loading in data-state, while its probe is pending`, async () => {
      restore = installFetchImplementation(() => new Promise<Response>(() => {}));
      const { container, findByTestId, queryByRole } = mount(view);
      expect(await findByTestId('content')).not.toBeNull();
      expect(frame(container).dataset['state']).toBe('loading');
      expect(queryByRole('heading', { name: copy.loading.title })).toBeNull();
    });
  }
});

describe('a refused probe', () => {
  test('tells the principal store the scope is gone', async () => {
    stub('schedules', 'forbidden');
    const { store, findByRole } = mount('schedules');
    await findByRole('heading', { level: 1, name: VIEW_COPY.schedules.forbidden.title });
    await waitFor(() => expect(store()?.hasScope('schedules:read')).toBe(false));
  });

  test('is not retried automatically, and retrying asks again', async () => {
    const { requests } = stub('goals', 'error');
    const { findByRole, getByRole } = mount('goals');
    await findByRole('heading', { level: 1, name: VIEW_COPY.goals.error.title });
    expect(requests.length).toBe(1);
    getByRole('button', { name: RETRY_LABEL }).click();
    await waitFor(() => expect(requests.length).toBe(2));
  });
});

describe('one chat session’s page', () => {
  test('asks nothing before it shows: the pane words its own loading, failure, forbidden and not-found states, so the list beside it stays live', async () => {
    expect(probeFor('chat', { chat: 'session-1' }, '/chats/:chat')).toBeUndefined();
    const { requests } = stub('chat', 'content');
    const { container, findByTestId } = mount('chat', {
      parameters: { chat: 'session-1' },
      pattern: '/chats/:chat',
    });

    expect(await findByTestId('content')).not.toBeNull();
    expect(frame(container).dataset['state']).toBe('ready');
    expect(requests).toEqual([]);
  });
});

describe('the chat list, a new chat, and the agents', () => {
  const rpc = (method: string, result: unknown) =>
    Response.json({ jsonrpc: '2.0', id: method, result });
  /** Answers each Bureau operation the frame's probes ask, by name. */
  function stubBureau(answers: Record<string, () => Response>): void {
    restore = installFetchImplementation(async (_input, init) => {
      const method = operationOf(init?.body)?.method ?? '';
      const answer = answers[method];
      if (answer === undefined) throw new Error(`Unexpected request: ${method}`);
      return answer();
    });
  }

  const agents = (...entries: Array<Partial<typeof AGENT>>) =>
    rpc('bureau.agents.list', { agents: entries.map((entry) => ({ ...AGENT, ...entry })) });

  test('asks nothing before the list of chats shows: the list words its own loading, first use and failure', async () => {
    expect(probeFor('chat', {}, '/chats')).toBeUndefined();
    const { requests } = stub('chat', 'content');
    const { container, findByTestId } = mount('chat', { pattern: '/chats' });

    expect(await findByTestId('content')).not.toBeNull();
    expect(frame(container).dataset['state']).toBe('ready');
    expect(requests).toEqual([]);
  });

  test('a new chat is empty, with the Agents first-use words, when no agent can run (24q)', async () => {
    stubBureau({ 'bureau.agents.list': () => agents() });
    const words = VIEW_COPY.chat.emptyByPattern?.['/chats/new'];
    const { container, findByRole } = mount('chat', { pattern: '/chats/new' });

    expect(await findByRole('heading', { level: 1, name: 'No agents yet' })).not.toBeNull();
    expect(words?.title).toBe('No agents yet');
    expect(container.textContent).toContain(
      'An agent is a model with instructions and tools. Create one, or add a plugin that provides some.',
    );
    expect(frame(container).dataset['state']).toBe('empty');
    // A primary New agent and a secondary Browse agents, both buttons, and no composer or checklist.
    const create = container.querySelector('a[href="/agents/new"]');
    expect(create?.textContent?.trim()).toBe('New agent');
    expect(create?.getAttribute('data-cinder-variant')).toBe('primary');
    const browse = container.querySelector('a[href="/agents"]');
    expect(browse?.textContent?.trim()).toBe('Browse agents');
    expect(browse?.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(container.querySelectorAll('.weft-view__empty a.cinder-button')).toHaveLength(2);
    expect(container.querySelector('textarea, [data-testid="first-run"]')).toBeNull();
  });

  test('a new chat is ready for an agent the Bureau lists', async () => {
    stubBureau({ 'bureau.agents.list': () => agents({ name: 'demo:assistant' }) });
    const { container, findByTestId } = mount('chat', { pattern: '/chats/new' });

    expect(await findByTestId('content')).not.toBeNull();
    expect(frame(container).dataset['state']).toBe('ready');
  });

  /** A host that lists `names` as agents and reports `plugins`, or fails the plugin route when null. */
  function stubHostWithPlugins(names: readonly string[], plugins: readonly unknown[] | null): void {
    restore = installFetchImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/host/plugins')) {
        return plugins === null
          ? new Response('down', { status: 500 })
          : Response.json({ configurationRevision: null, plugins, unloaded: [] });
      }
      return agents(...names.map((name) => ({ name })));
    });
  }

  const demoPlugin = (status: string, agentNames: readonly string[]) => ({
    descriptor: {
      name: 'demo',
      title: 'demo',
      version: '1.0.0',
      description: '',
      required: false,
      enabledByDefault: false,
      secrets: [],
    },
    source: 'folder',
    location: '/plugins/demo',
    status,
    problems: [],
    contributions: agentNames.map((id) => ({
      kind: 'code-agent',
      id,
      references: { agents: 0, schedules: 0, waitingRuns: 0 },
    })),
    enabled: status !== 'disabled',
    configuration: {},
    configurationSchema: null,
    running: { enabled: status !== 'disabled', configuration: {} },
    secrets: [],
    restartRequired: false,
  });

  test('a new chat on a fresh host, with the demo plugin off and no agent listed, shows the empty state', async () => {
    stubHostWithPlugins([], [demoPlugin('disabled', [])]);
    const { container, findByRole } = mount('chat', { pattern: '/chats/new' });
    const words = VIEW_COPY.chat.emptyByPattern?.['/chats/new'];

    expect(await findByRole('heading', { level: 1, name: words?.title ?? '' })).not.toBeNull();
    expect(frame(container).dataset['state']).toBe('empty');
  });

  test('a new chat opens on the first agent that can run', async () => {
    stubHostWithPlugins(['notes'], [demoPlugin('running', ['demo:assistant'])]);
    const { container, findByTestId } = mount('chat', { pattern: '/chats/new' });

    expect(await findByTestId('content')).not.toBeNull();
    expect(frame(container).dataset['state']).toBe('ready');
  });

  test('a new chat never defaults to an agent of a plugin that needs setup', async () => {
    stubHostWithPlugins(['demo:assistant'], [demoPlugin('needs-setup', ['demo:assistant'])]);
    const { container, findByRole } = mount('chat', { pattern: '/chats/new' });
    const words = VIEW_COPY.chat.emptyByPattern?.['/chats/new'];

    expect(await findByRole('heading', { level: 1, name: words?.title ?? '' })).not.toBeNull();
    expect(frame(container).dataset['state']).toBe('empty');
  });

  test('a new chat is not found for an agent that does not exist', async () => {
    // The probe reads `?agent=` from the address; without one it would start from a default agent.
    router.navigate('/chats/new?agent=nobody', { replace: true });
    try {
      for (const entries of [[{ name: 'other' }], []]) {
        stubBureau({
          'bureau.agents.list': () => agents(...(entries as Array<Partial<typeof AGENT>>)),
        });
        const { container, findByRole, unmount } = mount('chat', { pattern: '/chats/new' });
        // It is the agent that is missing, so the words are about the agent and not the session.
        const words = VIEW_COPY.chat.notFoundByPattern?.['/chats/new'];

        expect(await findByRole('heading', { level: 1, name: words?.title ?? '' })).not.toBeNull();
        expect(container.textContent).toContain(words?.description ?? '');
        expect(words?.title).not.toBe(VIEW_COPY.chat.notFound?.title);
        expect(frame(container).dataset['state']).toBe('not-found');
        unmount();
        restore?.();
      }
    } finally {
      router.navigate('/', { replace: true });
    }
  });

  test('an agent’s page is not found for an identifier the Bureau does not list', async () => {
    stubBureau({ 'bureau.agents.list': () => agents({ name: 'assistant' }) });
    const missing = mount('agents', { parameters: { agent: 'nobody' } });
    expect(
      await missing.findByRole('heading', {
        level: 1,
        name: VIEW_COPY.agents.notFound?.title ?? '',
      }),
    ).not.toBeNull();
    expect(frame(missing.container).dataset['state']).toBe('not-found');
    missing.unmount();

    const found = mount('agents', { parameters: { agent: 'assistant' } });
    expect(await found.findByTestId('content')).not.toBeNull();
  });
});

describe('an agent’s memory page, under the Agents view', () => {
  const PATTERN = '/agents/:agent/memories';
  const rpc = (method: string, result: unknown) =>
    Response.json({ jsonrpc: '2.0', id: method, result });
  const fault = (status: number, code: string) =>
    Response.json({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message: 'No', data: { weftCode: code, httpStatus: status } },
    });
  const MEMORY = {
    id: 'memory-1',
    content: 'The user prefers aisle seats.',
    memoryClass: 'episodic',
    source: 'conversation',
    trust: 'untrusted',
    createdAt: '2026-10-19T08:00:00.000Z',
    sessionId: 'session-1',
  };
  const copy = VIEW_COPY.agents;

  /** Answers the two operations the memory page's probe asks, by name. */
  function stubBureau(memories: () => Response): void {
    restore = installFetchImplementation(async (_input, init) => {
      const method = operationOf(init?.body)?.method ?? '';
      if (method === 'bureau.agents.list') return rpc(method, { agents: [{ ...AGENT }] });
      if (method === 'bureau.memory.list') return memories();
      throw new Error(`Unexpected request: ${method}`);
    });
  }

  const mountMemory = () =>
    mount('agents', { pattern: PATTERN, parameters: { agent: 'assistant' } });

  test('is loading, with the memory words, while the Bureau is asked', async () => {
    restore = installFetchImplementation(() => new Promise<Response>(() => {}));
    const { container, findByRole } = mountMemory();
    const words = copy.loadingByPattern?.[PATTERN];

    expect(await findByRole('heading', { level: 1, name: words?.title ?? '' })).not.toBeNull();
    expect(container.textContent).toContain(words?.description ?? '');
    expect(frame(container).dataset['state']).toBe('loading');
    expect(words?.title).not.toBe(copy.loading.title);
  });

  test('shows the page when the agent has no memory, which is where the first one is added', async () => {
    stubBureau(() => rpc('bureau.memory.list', { memories: [], nextOffset: null }));
    const { container, findByTestId } = mountMemory();

    expect(await findByTestId('content')).not.toBeNull();
    expect(frame(container).dataset['state']).toBe('ready');
  });

  test('is failing, with a retry, when the Bureau cannot answer', async () => {
    stubBureau(() => fault(500, 'EngineFailure'));
    const { container, findByRole, getByRole } = mountMemory();
    const words = copy.errorByPattern?.[PATTERN];

    expect(await findByRole('heading', { level: 1, name: words?.title ?? '' })).not.toBeNull();
    expect(container.textContent).toContain(words?.description ?? '');
    expect(frame(container).dataset['state']).toBe('error');
    expect(getByRole('button', { name: RETRY_LABEL })).not.toBeNull();
  });

  test('is forbidden, in the words that name the scope, when the Bureau refuses the caller the memory', async () => {
    stubBureau(() => fault(403, 'Forbidden'));
    const { container, findByRole } = mountMemory();
    const words = copy.forbiddenByPattern?.[PATTERN];

    expect(await findByRole('heading', { level: 1, name: words?.title ?? '' })).not.toBeNull();
    expect(container.textContent).toContain('bureau.memory:read');
    expect(container.textContent).toContain(FORBIDDEN_COPY.description);
    expect(frame(container).dataset['state']).toBe('forbidden');
    expect(words?.title).not.toBe(copy.forbidden.title);
  });

  test('is ready when the agent remembers something', async () => {
    stubBureau(() => rpc('bureau.memory.list', { memories: [MEMORY], nextOffset: null }));
    const { container, findByTestId } = mountMemory();

    expect(await findByTestId('content')).not.toBeNull();
    expect(frame(container).dataset['state']).toBe('ready');
  });

  test('is worded and probed as the memory page when a memory is open in its path', async () => {
    stubBureau(() => fault(403, 'Forbidden'));
    const { container, findByRole } = mount('agents', {
      pattern: '/agents/:agent/memories/:memory',
      parameters: { agent: 'assistant', memory: 'memory-1' },
    });
    const words = copy.forbiddenByPattern?.[PATTERN];

    expect(await findByRole('heading', { level: 1, name: words?.title ?? '' })).not.toBeNull();
    expect(container.textContent).toContain('bureau.memory:read');
    expect(frame(container).dataset['state']).toBe('forbidden');
  });

  test('is not found for an agent the Bureau does not list, before the memory is asked for', async () => {
    const asked: string[] = [];
    restore = installFetchImplementation(async (_input, init) => {
      const method = operationOf(init?.body)?.method ?? '';
      asked.push(method);
      return rpc(method, { agents: [{ ...AGENT, name: 'other' }] });
    });
    const { container, findByRole } = mountMemory();

    expect(
      await findByRole('heading', { level: 1, name: copy.notFound?.title ?? '' }),
    ).not.toBeNull();
    expect(frame(container).dataset['state']).toBe('not-found');
    expect(asked).toEqual(['bureau.agents.list']);
  });
});

describe('the Workflows area', () => {
  const ROUTES = [
    { pattern: '/workflows', parameters: {} },
    { pattern: '/workflows/:workflow', parameters: { workflow: 'digest' } },
    { pattern: '/workflows/:workflow/runs', parameters: { workflow: 'digest' } },
    { pattern: '/workflows/:workflow/edit', parameters: { workflow: 'digest' } },
  ] as const;

  function world(overrides: Partial<World> = {}): WorkflowStub {
    const stub = installWorkflowWorld(
      emptyWorld({
        definitions: [codeDefinition('order-processing'), sourceDefinition('digest')],
        files: [readyFile('digest')],
        ...overrides,
      }),
    );
    restore = stub.restore;
    return stub;
  }

  test('is gated on the engine’s workflows:read, and says whether it can be empty', () => {
    const view = VIEWS.workflows;
    expect(view.scopes).toEqual(['workflows:read']);
    expect(view.canBeEmpty).toBe(true);
    // A view that can be empty has the words for it, and one for a type with no runs.
    expect(VIEW_COPY.workflows.empty).toBeDefined();
    expect(VIEW_COPY.workflows.emptyByPattern?.['/workflows/:workflow/runs']).toBeDefined();
  });

  for (const { pattern, parameters } of ROUTES) {
    test(`${pattern} is forbidden without workflows:read, and asks nothing`, () => {
      const stub = world();
      const { container } = mount('workflows', { scopes: [], parameters, pattern });
      expect(frame(container).dataset['state']).toBe('forbidden');
      expect(container.textContent).toContain('requires workflows:read');
      expect(stub.calls).toEqual([]);
    });

    test(`${pattern} is not found for a type neither service knows`, async () => {
      world({ definitions: [], files: [] });
      const { container, findByRole } = mount('workflows', { parameters, pattern });
      if (pattern === '/workflows') {
        await findByRole('heading', { level: 1, name: VIEW_COPY.workflows.empty?.title ?? '' });
        expect(frame(container).dataset['state']).toBe('empty');
        return;
      }
      const words =
        VIEW_COPY.workflows.notFoundByPattern?.[pattern] ?? VIEW_COPY.workflows.notFound;
      expect(await findByRole('heading', { level: 1, name: words?.title ?? '' })).not.toBeNull();
      expect(frame(container).dataset['state']).toBe('not-found');
    });

    test(`${pattern} is failing, not missing, when the Bureau breaks`, async () => {
      const stub = world();
      stub.on('bureau.workflows.get', () => {
        throw workflowFaults.unavailable();
      });
      stub.on('bureau.workflows.list', () => {
        throw workflowFaults.unavailable();
      });
      const { container, findByRole } = mount('workflows', { parameters, pattern });
      expect(
        await findByRole('heading', { level: 1, name: VIEW_COPY.workflows.error.title }),
      ).not.toBeNull();
      expect(frame(container).dataset['state']).toBe('error');
    });

    test(`${pattern} is failing, not missing, when the engine’s definitions break`, async () => {
      const stub = world();
      stub.on('weft.workflows.definitions.get', () => {
        throw workflowFaults.unavailable();
      });
      stub.on('weft.workflows.definitions.list', () => {
        throw workflowFaults.unavailable();
      });
      const { container, findByRole, findByTestId } = mount('workflows', { parameters, pattern });
      if (pattern === '/workflows/:workflow/edit') {
        // The editor reads only the Bureau's file, so the engine's failure is not its failure.
        expect(await findByTestId('content')).not.toBeNull();
        return;
      }
      expect(
        await findByRole('heading', { level: 1, name: VIEW_COPY.workflows.error.title }),
      ).not.toBeNull();
      expect(frame(container).dataset['state']).toBe('error');
    });
  }

  for (const { pattern } of ROUTES.filter((route) => route.pattern !== '/workflows')) {
    test(`${pattern} is not found for a name the engine refuses as malformed`, async () => {
      const stub = world({ definitions: [], files: [] });
      stub.on('weft.workflows.definitions.get', () => {
        throw workflowFaults.invalidParams();
      });
      const { container, findByRole } = mount('workflows', {
        parameters: { workflow: 'foo.bar' },
        pattern,
      });
      const words =
        VIEW_COPY.workflows.notFoundByPattern?.[pattern] ?? VIEW_COPY.workflows.notFound;
      await findByRole('heading', { level: 1, name: words?.title ?? '' });
      expect(frame(container).dataset['state']).toBe('not-found');
    });
  }

  test('the list is ready with only a file, and empty with nothing in either service', async () => {
    world({ definitions: [], files: [readyFile('digest')] });
    const ready = mount('workflows', { pattern: '/workflows' });
    expect(await ready.findByTestId('content')).not.toBeNull();
    ready.unmount();
    restore?.();

    world({ definitions: [sourceDefinition('deleted-yesterday')], files: [] });
    const { container, findByRole } = mount('workflows', { pattern: '/workflows' });
    // A source with no file is left out, so the list is empty and reads as it will after a restart.
    await findByRole('heading', { level: 1, name: VIEW_COPY.workflows.empty?.title ?? '' });
    expect(frame(container).dataset['state']).toBe('empty');
  });

  test('a type’s page is not found when the file is gone and the engine holds only its source', async () => {
    world({ definitions: [sourceDefinition('digest')], files: [] });
    const { container, findByRole } = mount('workflows', {
      parameters: { workflow: 'digest' },
      pattern: '/workflows/:workflow',
    });
    const words =
      VIEW_COPY.workflows.notFoundByPattern?.['/workflows/:workflow'] ??
      VIEW_COPY.workflows.notFound;
    await findByRole('heading', { level: 1, name: words?.title ?? '' });
    expect(frame(container).dataset['state']).toBe('not-found');
  });

  test('a code-defined type’s page is ready, and its editor is not found, because it has no file', async () => {
    world();
    const page = mount('workflows', {
      parameters: { workflow: 'order-processing' },
      pattern: '/workflows/:workflow',
    });
    expect(await page.findByTestId('content')).not.toBeNull();
    page.unmount();
    restore?.();

    world();
    const editor = mount('workflows', {
      parameters: { workflow: 'order-processing' },
      pattern: '/workflows/:workflow/edit',
    });
    const words =
      VIEW_COPY.workflows.notFoundByPattern?.['/workflows/:workflow/edit'] ??
      VIEW_COPY.workflows.notFound;
    await editor.findByRole('heading', { level: 1, name: words?.title ?? '' });
    expect(frame(editor.container).dataset['state']).toBe('not-found');
  });

  test('the runs of a type with none are empty, in words about runs, and with some are ready', async () => {
    world({ runs: [] });
    const none = mount('workflows', {
      parameters: { workflow: 'order-processing' },
      pattern: '/workflows/:workflow/runs',
    });
    const words = VIEW_COPY.workflows.emptyByPattern?.['/workflows/:workflow/runs'];
    await none.findByRole('heading', { level: 1, name: words?.title ?? '' });
    expect(frame(none.container).dataset['state']).toBe('empty');
    expect(none.container.textContent).toContain(words?.description ?? '');
    expect(words?.title).not.toBe(VIEW_COPY.workflows.empty?.title);
    none.unmount();
    restore?.();

    const stub = world({
      runs: [
        { id: 'run-1', type: 'order-processing', status: 'completed', createdAt: 1, updatedAt: 1 },
      ],
    });
    const some = mount('workflows', {
      parameters: { workflow: 'order-processing' },
      pattern: '/workflows/:workflow/runs',
    });
    expect(await some.findByTestId('content')).not.toBeNull();
    // The probe asks for this type's runs, and only the first.
    expect(stub.callsTo('GET /workflows')[0]?.params).toMatchObject({ type: 'order-processing' });
  });

  test('the runs of a type with none ask again while they are empty, and show a run that starts', async () => {
    const empty = emptyWorld({
      definitions: [codeDefinition('order-processing'), sourceDefinition('digest')],
      files: [readyFile('digest')],
      runs: [],
    });
    const stub = installWorkflowWorld(empty);
    restore = stub.restore;
    // The page's own timers are the fake clock's, so the recheck can be advanced.
    jest.useFakeTimers();
    const { container } = mount('workflows', {
      parameters: { workflow: 'order-processing' },
      pattern: '/workflows/:workflow/runs',
    });
    await until(() => expect(frame(container).dataset['state']).toBe('empty'));
    const asked = stub.callsTo('GET /workflows').length;

    // The workflow starts, and the page that is already open finds out by itself.
    empty.runs.push({
      id: 'run-1',
      type: 'order-processing',
      status: 'completed',
      createdAt: 1,
      updatedAt: 1,
    });
    jest.advanceTimersByTime(RUNS_RECHECK_MS);
    await until(() => expect(frame(container).dataset['state']).toBe('ready'));
    expect(stub.callsTo('GET /workflows').length).toBeGreaterThan(asked);

    // With a run to show it asks no more.
    const settled = stub.callsTo('GET /workflows').length;
    jest.advanceTimersByTime(RUNS_RECHECK_MS * 3);
    await settle();
    expect(stub.callsTo('GET /workflows').length).toBe(settled);
  });

  test('a view whose probe sets no recheck is asked once, however long it stays empty', async () => {
    jest.useFakeTimers();
    const { requests } = stub('audit', 'empty');
    const { container } = mount('audit');
    await until(() => expect(frame(container).dataset['state']).toBe('empty'));
    const asked = requests.length;

    jest.advanceTimersByTime(60_000);
    await settle();

    expect(frame(container).dataset['state']).toBe('empty');
    expect(requests.length).toBe(asked);
  });
});

describe('the Reviews view', () => {
  test('holds no console scope, because the console drops the Bureau’s and the Bureau gates its own list', () => {
    expect(VIEWS.reviews.scopes).toEqual([]);
  });

  test('is forbidden when the Bureau refuses the caller the list of reviews, with data-state forbidden', async () => {
    restore = installFetchImplementation(async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32000,
          message: 'No',
          data: { weftCode: 'Forbidden', httpStatus: 403 },
        },
      }),
    );
    const { container, findByRole } = mount('reviews', { pattern: '/reviews' });
    expect(
      await findByRole('heading', { level: 1, name: VIEW_COPY.reviews.forbidden.title }),
    ).not.toBeNull();
    expect(frame(container).dataset['state']).toBe('forbidden');
  });

  test('is failing, with its error words and Retry, when the Bureau does not know the caller (a 401)', async () => {
    restore = installFetchImplementation(async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32000,
          message: 'No',
          data: { weftCode: 'Unauthorized', httpStatus: 401 },
        },
      }),
    );
    const { container, findByRole, getByRole } = mount('reviews', { pattern: '/reviews' });
    expect(
      await findByRole('heading', { level: 1, name: VIEW_COPY.reviews.error.title }),
    ).not.toBeNull();
    expect(frame(container).dataset['state']).toBe('error');
    expect(container.textContent).toContain(VIEW_COPY.reviews.error.description);
    expect(getByRole('button', { name: RETRY_LABEL })).not.toBeNull();
  });

  test('asks the Bureau for its list and nothing of the engine, because the page reads the engine itself', async () => {
    const methods: string[] = [];
    const paths: string[] = [];
    restore = installFetchImplementation(async (input, init) => {
      paths.push(requestUrl(input).pathname);
      methods.push(operationOf(init?.body)?.method ?? '');
      return Response.json({ jsonrpc: '2.0', id: 1, result: { reviews: [] } });
    });
    const { container, findByTestId } = mount('reviews', { pattern: '/reviews' });
    // The page shows its own empty state, so the frame is ready even when nothing is waiting.
    expect(await findByTestId('content')).not.toBeNull();
    expect(frame(container).dataset['state']).toBe('ready');
    expect(methods).toEqual(['bureau.reviews.list']);
    expect(paths).toEqual(['/bureau/jsonrpc']);
  });

  test('is ready when the Bureau fails with a 5xx, because the page shows what its other source can', async () => {
    restore = installFetchImplementation(async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32000,
          message: 'The Bureau broke.',
          data: { weftCode: 'EngineFailure', httpStatus: 500 },
        },
      }),
    );
    const { container, findByTestId } = mount('reviews', { pattern: '/reviews' });
    expect(await findByTestId('content')).not.toBeNull();
    expect(frame(container).dataset['state']).toBe('ready');
  });

  test('is ready when the Bureau cannot be reached at all', async () => {
    restore = installFetchImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    const { container, findByTestId } = mount('reviews', { pattern: '/reviews' });
    expect(await findByTestId('content')).not.toBeNull();
    expect(frame(container).dataset['state']).toBe('ready');
  });

  test('has no empty state of its own, so a page with nothing waiting says so itself', () => {
    expect(VIEWS.reviews.canBeEmpty).toBe(false);
    expect(VIEW_COPY.reviews.empty).toBeUndefined();
  });
});

describe('the Settings sections that read the settings', () => {
  test('show the page when the probe fails, so the section words its own failure beside its navigation', async () => {
    stub('settings', 'error');
    const { container, findByTestId, queryByRole } = mount('settings');
    expect(await findByTestId('content')).not.toBeNull();
    await waitFor(() => expect(frame(container).dataset['state']).toBe('error'));
    expect(await findByTestId('content')).not.toBeNull();
    // Not the frame's own error: the page is on screen and the frame's heading is not.
    expect(queryByRole('heading', { level: 1, name: VIEW_COPY.settings.error.title })).toBeNull();
  });

  test('are still the frame’s forbidden state when the Bureau refuses the caller', async () => {
    stub('settings', 'forbidden');
    const { container, findByRole } = mount('settings');
    expect(
      await findByRole('heading', { level: 1, name: VIEW_COPY.settings.forbidden.title }),
    ).not.toBeNull();
    expect(frame(container).dataset['state']).toBe('forbidden');
  });
});

describe('the Settings API reference route', () => {
  test('shows its content when the engine fails, because no probe stands in front of it', async () => {
    const { requests } = stub('settings', 'error');
    const { container, findByTestId } = mount('settings', {
      pattern: '/settings/api-reference',
    });
    expect(await findByTestId('content')).not.toBeNull();
    expect(frame(container).dataset['state']).toBe('ready');
    expect(requests).toEqual([]);
  });

  test('shows its content when the engine refuses the caller', async () => {
    const { requests } = stub('settings', 'forbidden');
    const { container, findByTestId } = mount('settings', {
      pattern: '/settings/api-reference',
    });
    expect(await findByTestId('content')).not.toBeNull();
    expect(frame(container).dataset['state']).toBe('ready');
    expect(requests).toEqual([]);
  });

  test('shows its content while the engine is still answering', async () => {
    restore = installFetchImplementation(() => new Promise<Response>(() => {}));
    const { container, findByTestId } = mount('settings', {
      pattern: '/settings/api-reference',
    });
    expect(await findByTestId('content')).not.toBeNull();
    expect(frame(container).dataset['state']).toBe('ready');
  });
});
