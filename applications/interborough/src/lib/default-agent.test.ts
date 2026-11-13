/** The agent a new chat or a new workflow step starts with: the first one that can run. */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  CREATE_WORKFLOW_TOOL,
  findDefaultAgent,
  findWorkflowAuthor,
  listAgentsWithReadiness,
  workflowAuthorQuery,
} from './default-agent.ts';
import { installFetchImplementation } from './live-source/fetch.test-support.ts';
import { writePreferredAgent } from './preferred-agent.ts';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

function agent(name: string, tools?: readonly string[], hidden = false) {
  return {
    name,
    displayName: name,
    description: null,
    definitionRevision: 1,
    kind: 'code',
    a2a: false,
    ...(tools === undefined ? {} : { tools }),
    ...(hidden ? { visibility: 'hidden' } : {}),
  };
}

function plugin(name: string, status: string, agents: readonly string[]) {
  return {
    descriptor: {
      name,
      title: name,
      version: '1.0.0',
      description: '',
      required: false,
      enabledByDefault: false,
      secrets: [],
    },
    source: 'folder',
    location: `/plugins/${name}`,
    status,
    problems: [],
    contributions: agents.map((id) => ({
      kind: 'agent',
      id,
      references: { agents: 0, schedules: 0, waitingRuns: 0 },
    })),
    enabled: true,
    configuration: {},
    configurationSchema: null,
    running: { enabled: true, configuration: {} },
    secrets: [],
    restartRequired: false,
  };
}

/** A host that lists `agents` and reports `plugins`, or whose plugin route fails when `plugins` is null. */
function host(
  agents: readonly (string | { name: string; tools?: readonly string[]; hidden?: boolean })[],
  plugins: readonly unknown[] | null,
): void {
  restore = installFetchImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/host/plugins')) {
      return plugins === null
        ? new Response('down', { status: 500 })
        : Response.json({ configurationRevision: null, plugins, unloaded: [] });
    }
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: {
        agents: agents.map((entry) =>
          typeof entry === 'string'
            ? agent(entry)
            : agent(entry.name, entry.tools, entry.hidden === true),
        ),
      },
    });
  });
}

describe('the default agent', () => {
  test('is none on a fresh host, where the demo plugin is off and no agent is listed', async () => {
    host([], [plugin('demo', 'disabled', [])]);
    expect(await findDefaultAgent()).toBeNull();
  });

  test('is the first listed agent whose plugin is running', async () => {
    host(
      ['demo:assistant', 'demo:echo'],
      [plugin('demo', 'running', ['demo:assistant', 'demo:echo'])],
    );
    expect(await findDefaultAgent()).toBe('demo:assistant');
  });

  test('is never an agent of a plugin that needs setup', async () => {
    host(['demo:assistant', 'notes'], [plugin('demo', 'needs-setup', ['demo:assistant'])]);
    expect(await findDefaultAgent()).toBe('notes');
    expect(await listAgentsWithReadiness()).toMatchObject([
      { name: 'demo:assistant', ready: false },
      { name: 'notes', ready: true },
    ]);
  });

  test('is never an agent a plugin hides from Chat, even when it is listed first and can run (COR-2233)', async () => {
    host(
      [{ name: 'demo:internal', hidden: true }, 'demo:assistant'],
      [plugin('demo', 'running', ['demo:internal', 'demo:assistant'])],
    );
    expect(await findDefaultAgent()).toBe('demo:assistant');
    expect(await listAgentsWithReadiness()).toMatchObject([
      { name: 'demo:internal', visibility: 'hidden', ready: true },
      { name: 'demo:assistant', ready: true },
    ]);
  });

  test('is none when the only agent that can run is hidden from Chat', async () => {
    host([{ name: 'demo:internal', hidden: true }], []);
    expect(await findDefaultAgent()).toBeNull();
  });

  test('is none when every listed agent belongs to a plugin that needs setup', async () => {
    host(['demo:assistant'], [plugin('demo', 'needs-setup', ['demo:assistant'])]);
    expect(await findDefaultAgent()).toBeNull();
  });

  test('is the first listed agent when the host does not say what its plugins are doing', async () => {
    host(['demo:assistant'], null);
    expect(await findDefaultAgent()).toBe('demo:assistant');
  });

  test('is the agent the person chose in Settings when it can run, else the first that can', async () => {
    const store = new Map<string, string>();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => void store.set(key, value),
          removeItem: (key: string) => void store.delete(key),
        },
      },
    });
    try {
      host(
        ['demo:assistant', 'demo:echo', 'blocked:agent'],
        [
          plugin('demo', 'running', ['demo:assistant', 'demo:echo']),
          plugin('blocked', 'needs-setup', ['blocked:agent']),
        ],
      );
      writePreferredAgent('demo:echo');
      expect(await findDefaultAgent()).toBe('demo:echo');
      writePreferredAgent('blocked:agent');
      expect(await findDefaultAgent()).toBe('demo:assistant');
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'window');
      else Object.defineProperty(globalThis, 'window', original);
    }
  });
});

describe('the agent a chat started from Workflows begins with', () => {
  test('is the first agent that can run and has the Create workflow tool', async () => {
    host(
      [
        { name: 'tool-runner', tools: ['lookup-order'] },
        { name: 'workflow-author', tools: [CREATE_WORKFLOW_TOOL, 'bureau:discover-agents'] },
        { name: 'other-author', tools: [CREATE_WORKFLOW_TOOL] },
      ],
      [],
    );
    expect(await findWorkflowAuthor()).toBe('workflow-author');
  });

  test('is never an agent a plugin hides from Chat', async () => {
    host(
      [
        { name: 'hidden-author', tools: [CREATE_WORKFLOW_TOOL], hidden: true },
        { name: 'workflow-author', tools: [CREATE_WORKFLOW_TOOL] },
      ],
      [],
    );
    expect(await findWorkflowAuthor()).toBe('workflow-author');
  });

  test('is none when no agent has the tool, or the Bureau does not say what tools they have', async () => {
    host([{ name: 'tool-runner', tools: ['lookup-order'] }, 'assistant'], []);
    expect(await findWorkflowAuthor()).toBeNull();
  });

  test('is never an agent of a plugin that needs setup', async () => {
    host(
      [
        { name: 'demo:author', tools: [CREATE_WORKFLOW_TOOL] },
        { name: 'notes', tools: [CREATE_WORKFLOW_TOOL] },
      ],
      [plugin('demo', 'needs-setup', ['demo:author'])],
    );
    expect(await findWorkflowAuthor()).toBe('notes');
  });
});

describe('workflowAuthorQuery', () => {
  test('reads the workflow author, with the signal it was given, and trusts it for a moment', async () => {
    host([{ name: 'workflow-author', tools: [CREATE_WORKFLOW_TOOL] }, 'assistant'], []);
    const query = workflowAuthorQuery();

    expect(await query.queryFn({ signal: new AbortController().signal })).toBe('workflow-author');
    expect(await query.queryFn({})).toBe('workflow-author');
    expect(query.staleTime).toBeGreaterThan(0);
    expect(query.retry).toBe(false);
  });
});
