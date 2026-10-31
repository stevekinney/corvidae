/** The agent a new chat or a new workflow step starts with: the first one that can run. */
import { afterEach, describe, expect, test } from 'bun:test';

import { findDefaultAgent, listAgentsWithReadiness } from './default-agent.ts';
import { installFetchImplementation } from './live-source/fetch.test-support.ts';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

function agent(name: string) {
  return {
    name,
    displayName: name,
    description: null,
    definitionRevision: 1,
    kind: 'code',
    a2a: false,
  };
}

function plugin(name: string, status: string, agents: readonly string[]) {
  return {
    descriptor: {
      name,
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
function host(agents: readonly string[], plugins: readonly unknown[] | null): void {
  restore = installFetchImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/host/plugins')) {
      return plugins === null
        ? new Response('down', { status: 500 })
        : Response.json({ plugins, unloaded: [] });
    }
    return Response.json({ jsonrpc: '2.0', id: 1, result: { agents: agents.map(agent) } });
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
