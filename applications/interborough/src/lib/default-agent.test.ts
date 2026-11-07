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

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

function agent(name: string, tools?: readonly string[]) {
  return {
    name,
    displayName: name,
    description: null,
    definitionRevision: 1,
    kind: 'code',
    a2a: false,
    ...(tools === undefined ? {} : { tools }),
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
      kind: 'code-agent',
      id,
      references: { agents: 0, schedules: 0, waitingRuns: 0 },
    })),
    enabled: true,
    configuration: {},
    secrets: [],
    restartRequired: false,
  };
}

/** A host that lists `agents` and reports `plugins`, or whose plugin route fails when `plugins` is null. */
function host(
  agents: readonly (string | { name: string; tools?: readonly string[] })[],
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
          typeof entry === 'string' ? agent(entry) : agent(entry.name, entry.tools),
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

  test('is none when every listed agent belongs to a plugin that needs setup', async () => {
    host(['demo:assistant'], [plugin('demo', 'needs-setup', ['demo:assistant'])]);
    expect(await findDefaultAgent()).toBeNull();
  });

  test('is the first listed agent when the host does not say what its plugins are doing', async () => {
    host(['demo:assistant'], null);
    expect(await findDefaultAgent()).toBe('demo:assistant');
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
