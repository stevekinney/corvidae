/**
 * COR-2009 — a built-in agent's saved overrides over the wire: `bureau.agents.overrides.get` and
 * `.update`, and the versions they make as `bureau.agents.versions.list` and `.restore` show them,
 * each save audited. `alpha` is the harness's code agent, defined by the host, so it is built in.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { createAgent } from '@lostgradient/operative';

import { lookupTool } from '../../testing/agent-file-fixtures.test-support.ts';
import {
  callAs,
  disposeServed,
  listOf,
  seed,
  serve,
  type Served,
} from './agent-definitions-fixtures.test-support.ts';

afterEach(disposeServed);

async function currentHash(served: Served, id = 'alpha'): Promise<string> {
  const response = await callAs(served.owner, 'bureau.agents.overrides.get', { id });
  expect(response.error).toBeUndefined();
  return (response.result as { hash: string }).hash;
}

async function save(served: Served, overrides: Record<string, unknown>) {
  return callAs(served.owner, 'bureau.agents.overrides.update', {
    id: 'alpha',
    expectedHash: await currentHash(served),
    overrides,
  });
}

describe('bureau.agents.overrides', () => {
  it('reads an agent nobody changed as no overrides and no version, with no versions listed', async () => {
    const served = await serve();
    const response = await callAs(served.owner, 'bureau.agents.overrides.get', { id: 'alpha' });

    expect(response.result).toMatchObject({
      id: 'alpha',
      version: null,
      overrides: {
        instructions: null,
        tools: null,
        approvals: null,
        guardrails: null,
        limits: null,
        model: null,
        models: null,
        effort: null,
      },
    });
    const versions = await callAs(served.owner, 'bureau.agents.versions.list', { id: 'alpha' });
    expect(versions.error).toBeUndefined();
    expect(listOf(versions, 'versions')).toEqual([]);
  });

  it('serves the agent’s own tools beside the overrides, so a tool the overrides removed can be added back', async () => {
    const served = await serve({
      agents: {
        alpha: createAgent({
          name: 'alpha',
          generate: async () => ({ content: 'alpha', toolCalls: [] }),
          tools: { 'lookup-order': lookupTool },
        }),
      },
    });
    const before = await callAs(served.owner, 'bureau.agents.overrides.get', { id: 'alpha' });
    expect(before.result).toMatchObject({ ownTools: ['lookup-order'], overrides: { tools: null } });

    const saved = await save(served, { tools: [] });
    expect(saved.error).toBeUndefined();

    const after = await callAs(served.owner, 'bureau.agents.overrides.get', { id: 'alpha' });
    expect(after.result).toMatchObject({ ownTools: ['lookup-order'], overrides: { tools: [] } });
    // The detail shows the tools in force, which no longer hold the removed one.
    const detail = await callAs(served.owner, 'bureau.agents.definitions.get', { id: 'alpha' });
    expect(detail.result).toMatchObject({ codeDefinition: { tools: [] } });
  });

  it('saves each change as the next version, listed newest first with its overrides', async () => {
    const served = await serve();
    const first = await save(served, { tools: ['lookup-order'], limits: { steps: 20 } });
    expect(first.result).toMatchObject({ id: 'alpha', version: 1 });
    const second = await save(served, {
      tools: ['lookup-order'],
      approvals: { 'lookup-order': 'always' },
      limits: { steps: 20, cost: { run: 2 } },
    });
    expect(second.result).toMatchObject({ version: 2 });

    const versions = listOf(
      await callAs(served.owner, 'bureau.agents.versions.list', { id: 'alpha' }),
      'versions',
    );
    expect(versions.map((entry) => [entry['revision'], entry['changedKeys']])).toEqual([
      [2, ['approvals', 'limits']],
      [1, ['tools', 'limits']],
    ]);
    expect(versions[0]).toMatchObject({
      hash: (second.result as { hash: string }).hash,
      savedBy: 'anonymous:local',
      owner: 'anonymous:local',
      definition: null,
      referenceDigests: null,
      overrides: {
        tools: ['lookup-order'],
        approvals: { 'lookup-order': 'always' },
        limits: { steps: 20, cost: { run: 2 } },
        model: null,
      },
    });
    const now = await callAs(served.owner, 'bureau.agents.overrides.get', { id: 'alpha' });
    expect(now.result).toMatchObject({ version: 2, overrides: { limits: { steps: 20 } } });
  });

  it('overrides only the limits a save states, and treats a limit left out or null as not overridden', async () => {
    const served = await serve();
    await save(served, { limits: { steps: null, cost: { run: 2 }, tools: null } });
    const now = await callAs(served.owner, 'bureau.agents.overrides.get', { id: 'alpha' });
    expect(now.result).toMatchObject({ version: 1, overrides: { limits: { cost: { run: 2 } } } });
    const stored = (now.result as { overrides: { limits: Record<string, unknown> } }).overrides;
    expect(Object.keys(stored.limits)).toEqual(['cost']);

    // Saving no limit at all is not an override of limits: it removes them.
    await save(served, { limits: { steps: null } });
    const cleared = await callAs(served.owner, 'bureau.agents.overrides.get', { id: 'alpha' });
    expect(cleared.result).toMatchObject({ overrides: { limits: null } });
  });

  it('refuses the old override keys and the old field names', async () => {
    const served = await serve();
    for (const overrides of [
      { stepLimit: 5 },
      { costBudget: { perRunUsd: 1 } },
      { toolBudget: { maxCalls: 1 } },
      { limits: { cost: { perRunUsd: 1 } } },
    ]) {
      const response = await save(served, overrides);
      expect([JSON.stringify(overrides), response.error?.data?.httpStatus]).toEqual([
        JSON.stringify(overrides),
        400,
      ]);
    }
  });

  it('restores a version as a new one and leaves the others listed', async () => {
    const served = await serve();
    await save(served, { limits: { steps: 20 } });
    await save(served, { limits: { steps: 20 }, tools: ['lookup-order'] });

    const restored = await callAs(served.owner, 'bureau.agents.versions.restore', {
      id: 'alpha',
      revision: 1,
      expectedHash: await currentHash(served),
    });

    expect(restored.error).toBeUndefined();
    expect(restored.result).toMatchObject({ id: 'alpha', revision: 3 });
    const versions = listOf(
      await callAs(served.owner, 'bureau.agents.versions.list', { id: 'alpha' }),
      'versions',
    );
    expect(versions.map((entry) => entry['revision'])).toEqual([3, 2, 1]);
    expect(versions[0]).toMatchObject({ overrides: { limits: { steps: 20 }, tools: null } });
  });

  it('audits every save and restore that made a version, naming the versions and the tools', async () => {
    const served = await serve();
    await save(served, { limits: { steps: 20 } });
    await save(served, { limits: { steps: 20 }, tools: ['lookup-order'] });
    // Saving the same overrides makes no version and no entry.
    await save(served, { limits: { steps: 20 }, tools: ['lookup-order'] });
    await callAs(served.owner, 'bureau.agents.versions.restore', {
      id: 'alpha',
      revision: 1,
      expectedHash: await currentHash(served),
    });

    const page = await served.bureau.audit.query({ runId: 'agent:alpha', type: 'agent.updated' });
    expect(page.records.map((record) => [record.principal, record.detail])).toEqual([
      ['anonymous:local', { agentName: 'alpha', revision: 1, changedKeys: 'limits' }],
      [
        'anonymous:local',
        {
          agentName: 'alpha',
          revision: 2,
          previousRevision: 1,
          changedKeys: 'tools',
          toolsAdded: 'lookup-order',
        },
      ],
      [
        'anonymous:local',
        {
          agentName: 'alpha',
          revision: 3,
          previousRevision: 2,
          changedKeys: 'tools',
          toolsRemoved: 'lookup-order',
        },
      ],
    ]);
  });

  it('refuses a stale save with the current hash and writes nothing', async () => {
    const served = await serve();
    const before = await currentHash(served);
    await save(served, { limits: { steps: 20 } });

    const stale = await callAs(served.owner, 'bureau.agents.overrides.update', {
      id: 'alpha',
      expectedHash: before,
      overrides: { limits: { steps: 30 } },
    });

    expect(stale.error?.data).toMatchObject({
      expectedRevision: before,
      currentRevision: await currentHash(served),
    });
    expect(
      listOf(
        await callAs(served.owner, 'bureau.agents.versions.list', { id: 'alpha' }),
        'versions',
      ),
    ).toHaveLength(1);
  });

  it('refuses an agent file and an unknown agent, and a tool the deployment lacks', async () => {
    const served = await serve();
    await seed(served);

    const file = await callAs(served.owner, 'bureau.agents.overrides.update', {
      id: 'researcher',
      expectedHash: 'x',
      overrides: { limits: { steps: 5 } },
    });
    expect(file.error?.data).toMatchObject({ reason: 'agent-file-read-only' });
    const read = await callAs(served.owner, 'bureau.agents.overrides.get', { id: 'researcher' });
    expect(read.error?.data?.httpStatus).toBe(404);
    const unknown = await callAs(served.owner, 'bureau.agents.overrides.get', { id: 'nobody' });
    expect(unknown.error?.data?.httpStatus).toBe(404);

    const tool = await save(served, { tools: ['wire-money'] });
    expect(tool.error?.data).toMatchObject({ reason: 'unknown-tool' });
    // A file agent's versions are still its file's.
    const versions = listOf(
      await callAs(served.owner, 'bureau.agents.versions.list', { id: 'researcher' }),
      'versions',
    );
    expect(versions[0]).toMatchObject({
      overrides: null,
      definition: { model: expect.any(String) },
    });
  });
});
