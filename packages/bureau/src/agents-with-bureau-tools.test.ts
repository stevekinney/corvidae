/**
 * COR-2009 — a code-defined agent may hold Bureau's own tools: `agentsWithBureauTools` builds it
 * from the built-in plugin's tools once the Bureau has made them, and it joins the catalog as an
 * entry of `agents` does, among the users of the tools it holds.
 */
import { createAgent, createScriptedGenerate, stopWhen } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog.ts';
import type { BureauOwnTools } from './agents-with-bureau-tools.ts';
import { createBureau } from './create-bureau.ts';
import { disposeServed, serve } from './http/management/agent-definitions-fixtures.test-support.ts';
import type { Bureau } from './types.ts';

const bureaus: Bureau<AgentDefinitions>[] = [];

afterEach(async () => {
  await disposeServed();
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

/** An agent that calls Discover agents once, then answers. */
function finder(tools: BureauOwnTools) {
  const discover = tools['bureau:discover-agents'];
  if (discover === undefined) throw new Error('Bureau offered no bureau:discover-agents.');
  return createAgent({
    name: 'finder',
    generate: createScriptedGenerate([
      {
        kind: 'respond',
        response: {
          content: '',
          toolCalls: [{ id: 'call-1', name: 'bureau__discover-agents', arguments: {} }],
        },
      },
      { kind: 'respond', response: { content: 'found them', toolCalls: [] } },
    ]),
    tools: { 'bureau:discover-agents': discover },
    stopWhen: stopWhen.noToolCalls(),
  });
}

const helper = () =>
  createAgent({ name: 'helper', generate: async () => ({ content: 'hi', toolCalls: [] }) });

describe('agentsWithBureauTools', () => {
  it('builds the agent from Bureau’s own tools, which it can call', async () => {
    let offered: readonly string[] = [];
    const bureau = await createBureau<AgentDefinitions>({
      agents: { helper: helper() },
      agentsWithBureauTools: {
        finder: (tools) => {
          offered = Object.keys(tools);
          return finder(tools);
        },
      },
      storage: new MemoryStorage(),
    });
    bureaus.push(bureau);

    // Without a workflow directory the built-in plugin makes Discover and child-run agents.
    expect(offered).toEqual([
      'bureau:discover-agents',
      'bureau:child-runs-dispatch',
      'bureau:child-runs-list',
      'bureau:child-runs-get',
      'bureau:child-runs-wait',
      'bureau:child-runs-cancel',
      'bureau:assets-publish',
      'bureau:assets-read',
    ]);
    expect(bureau.agents.list().map(({ id }) => id)).toEqual(['helper', 'finder']);

    const task = await bureau.tasks.start('finder', 'Who is here?');
    const result = await task.result();
    const calls = result.steps.flatMap((step) => step.results);
    expect(calls.map((call) => [call.toolName, call.outcome])).toEqual([
      ['bureau:discover-agents', 'success'],
    ]);
    expect(String(calls[0]?.result)).toContain('helper');
    expect(result.content).toBe('found them');
  });

  it('counts the agent among the users of the tools it holds', async () => {
    const served = await serve({ overrides: { agentsWithBureauTools: { finder } } });

    const discover = served.bureau.agents
      .tools()
      .find((tool) => tool.name === 'bureau:discover-agents');
    expect(discover).toMatchObject({ source: 'bureau', title: 'Discover agents' });
    expect(discover?.users).toContain('finder');
  });

  it('refuses a name `agents` already holds, and the reserved `bureau`', async () => {
    const clash = await rejectionOf(
      createBureau<AgentDefinitions>({
        agents: { finder: helper() },
        agentsWithBureauTools: { finder },
        storage: new MemoryStorage(),
      }),
    );
    expect(clash).toMatchObject({ code: 'BAD_REQUEST' });
    expect(String(clash)).toContain('"finder"');

    const reserved = await rejectionOf(
      createBureau<AgentDefinitions>({
        agentsWithBureauTools: { bureau: finder },
        storage: new MemoryStorage(),
      }),
    );
    expect(reserved).toMatchObject({ code: 'BAD_REQUEST' });
  });
});
