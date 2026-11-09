/**
 * COR-2009 — the versions of a built-in agent's saved overrides (`agent-override-store.ts`) and the
 * checks the catalog applies before saving them (`code-agent-overrides.ts`).
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createAgent, stopWhen } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import { AgentFileConflictError, AgentFileError } from './agent-file';
import {
  AGENT_OVERRIDE_VERSION_LIMIT,
  agentOverrideVersionKey,
  createAgentOverrideStore,
  hashAgentOverrides,
} from './agent-override-store';
import { createCodeAgentOverrides } from './code-agent-overrides';
import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import {
  createSqliteStorageFixture,
  type PersistentBureauStorageFixture,
} from './test/storage-fixtures';
import type { Bureau } from './types';

function clock() {
  let minute = 0;
  return () => new Date(Date.UTC(2026, 9, 12, 15, minute++)).toISOString();
}

function freshStore() {
  return createAgentOverrideStore({ store: textValueStore(new MemoryStorage()), nowISO: clock() });
}

const SAVED = { savedBy: 'anonymous:local', owner: 'anonymous:local' };

describe('the override versions of a built-in agent', () => {
  it('has no versions, and the hash of no overrides, for an agent nobody changed', async () => {
    const store = freshStore();
    expect(await store.list('tool-runner')).toEqual([]);
    expect(await store.current('tool-runner')).toEqual({
      hash: hashAgentOverrides({}),
      version: null,
      overrides: {},
    });
  });

  it('numbers each save from 1 and lists them newest first with the keys each changed', async () => {
    const store = freshStore();
    const first = await store.save(
      'tool-runner',
      { model: 'anthropic/claude-haiku-5-5', tools: ['lookup-order'] },
      { ...SAVED, expectedHash: hashAgentOverrides({}) },
    );
    expect(first.version).toBe(1);
    const second = await store.save(
      'tool-runner',
      { model: 'anthropic/claude-sonnet-5-5', tools: ['lookup-order'] },
      { ...SAVED, expectedHash: first.hash },
    );
    expect(second.version).toBe(2);

    const versions = await store.list('tool-runner');
    expect(versions.map((version) => [version.version, version.changedKeys])).toEqual([
      [2, ['model']],
      [1, ['tools', 'model']],
    ]);
    expect(versions[0]).toMatchObject({
      hash: second.hash,
      savedAt: '2026-10-12T15:01:00.000Z',
      savedBy: 'anonymous:local',
      owner: 'anonymous:local',
      overrides: { model: 'anthropic/claude-sonnet-5-5', tools: ['lookup-order'] },
    });
    expect(await store.current('tool-runner')).toMatchObject({ version: 2, hash: second.hash });
  });

  it('writes nothing for overrides equal to those in force', async () => {
    const store = freshStore();
    const first = await store.save(
      'tool-runner',
      { stepLimit: 20 },
      { ...SAVED, expectedHash: hashAgentOverrides({}) },
    );
    const again = await store.save(
      'tool-runner',
      { stepLimit: 20 },
      { ...SAVED, expectedHash: first.hash },
    );
    expect(again).toEqual(first);
    expect(await store.list('tool-runner')).toHaveLength(1);
  });

  it('refuses a save from a stale hash with the current one, and writes nothing', async () => {
    const store = freshStore();
    const first = await store.save(
      'tool-runner',
      { stepLimit: 20 },
      { ...SAVED, expectedHash: hashAgentOverrides({}) },
    );
    const stale = store.save(
      'tool-runner',
      { stepLimit: 30 },
      { ...SAVED, expectedHash: hashAgentOverrides({}) },
    );
    expect(await rejectionOf(stale)).toBeInstanceOf(AgentFileConflictError);
    expect(await rejectionOf(stale)).toMatchObject({ currentHash: first.hash });
    expect(await store.list('tool-runner')).toHaveLength(1);
  });

  it('lets one of two saves that read the same version commit', async () => {
    const store = freshStore();
    const expectedHash = hashAgentOverrides({});
    const results = await Promise.allSettled([
      store.save('tool-runner', { stepLimit: 20 }, { ...SAVED, expectedHash }),
      store.save('tool-runner', { stepLimit: 30 }, { ...SAVED, expectedHash }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await store.list('tool-runner')).toHaveLength(1);
  });

  it('restores a version as a new one with its content, and keeps the versions in between', async () => {
    const store = freshStore();
    const v1 = await store.save(
      'tool-runner',
      { instructions: 'Look orders up.' },
      { ...SAVED, expectedHash: hashAgentOverrides({}) },
    );
    const v2 = await store.save(
      'tool-runner',
      { instructions: 'Look orders up. Ask before a refund over $25.', tools: ['issue-refund'] },
      { ...SAVED, expectedHash: v1.hash },
    );

    const restored = await store.restore('tool-runner', 1, { ...SAVED, expectedHash: v2.hash });

    expect(restored).toEqual({ id: 'tool-runner', hash: v1.hash, version: 3 });
    const versions = await store.list('tool-runner');
    expect(versions.map((version) => version.version)).toEqual([3, 2, 1]);
    expect(versions[0]).toMatchObject({
      overrides: { instructions: 'Look orders up.' },
      changedKeys: ['instructions', 'tools'],
    });
  });

  it('refuses to restore a version it does not hold', async () => {
    const store = freshStore();
    const restoring = store.restore('tool-runner', 4, {
      ...SAVED,
      expectedHash: hashAgentOverrides({}),
    });
    expect(await rejectionOf(restoring)).toMatchObject({ code: 'agent-version-not-found' });
  });

  it('keeps the newest versions up to the limit, removing the oldest', async () => {
    const kv = textValueStore(new MemoryStorage());
    const store = createAgentOverrideStore({ store: kv, nowISO: clock() });
    let hash = hashAgentOverrides({});
    for (let step = 1; step <= AGENT_OVERRIDE_VERSION_LIMIT + 2; step += 1) {
      ({ hash } = await store.save(
        'tool-runner',
        { stepLimit: step },
        { ...SAVED, expectedHash: hash },
      ));
    }
    const versions = await store.list('tool-runner');
    expect(versions).toHaveLength(AGENT_OVERRIDE_VERSION_LIMIT);
    expect(versions.at(-1)?.version).toBe(3);
    expect(await kv.get(agentOverrideVersionKey('tool-runner', 2))).toBeNull();
  });
});

describe('the overrides the catalog saves', () => {
  function overridesFor() {
    return createCodeAgentOverrides({
      store: freshStore(),
      builtInAgents: new Map([
        ['tool-runner', { tools: ['lookup-order'] }],
        ['demo:release-helper', { tools: [] }],
      ]),
      listsOtherAgent: (id) => id === 'writer',
      toolNames: () => new Set(['lookup-order', 'issue-refund']),
      descriptors: () => [],
      modelPolicy: () => undefined,
    });
  }
  const expectedHash = hashAgentOverrides({});

  it('takes overrides only for a built-in agent', async () => {
    const overrides = overridesFor();
    expect(overrides.isBuiltIn('tool-runner')).toBe(true);
    expect(overrides.isBuiltIn('demo:release-helper')).toBe(false);
    expect(await overrides.get('demo:release-helper')).toBeUndefined();
    expect(await overrides.versions('demo:release-helper')).toEqual([]);

    expect(
      await rejectionOf(overrides.save('demo:release-helper', { stepLimit: 5 }, { expectedHash })),
    ).toMatchObject({ code: 'agent-file-read-only' });
    expect(
      await rejectionOf(overrides.save('writer', { stepLimit: 5 }, { expectedHash })),
    ).toMatchObject({ code: 'agent-file-read-only' });
    expect(
      await rejectionOf(overrides.save('nobody', { stepLimit: 5 }, { expectedHash })),
    ).toMatchObject({ code: 'agent-file-not-found' });
  });

  it('refuses a tool the deployment does not hold, and an Asks entry on a tool not allowed', async () => {
    const overrides = overridesFor();
    const unknownTool = overrides.save('tool-runner', { tools: ['wire-money'] }, { expectedHash });
    expect(await rejectionOf(unknownTool)).toBeInstanceOf(AgentFileError);
    expect(await rejectionOf(unknownTool)).toMatchObject({
      code: 'unknown-tool',
      problem: { issues: [{ path: 'tools.0', reference: 'wire-money' }] },
    });

    expect(
      await rejectionOf(
        overrides.save(
          'tool-runner',
          { tools: ['lookup-order'], toolApproval: { 'issue-refund': 'always' } },
          { expectedHash },
        ),
      ),
    ).toMatchObject({ code: 'unknown-approval-tool' });
    expect(await overrides.versions('tool-runner')).toEqual([]);
  });

  it('refuses a model the catalog does not hold', async () => {
    const overrides = overridesFor();
    expect(
      await rejectionOf(
        overrides.save('tool-runner', { model: 'anthropic/claude-sonnet-5-5' }, { expectedHash }),
      ),
    ).toMatchObject({ code: 'unknown-model' });
  });

  it('saves allowed tools and their Asks levels as version 1, by the caller', async () => {
    const overrides = overridesFor();
    const saved = await overrides.save(
      'tool-runner',
      { tools: ['lookup-order', 'issue-refund'], toolApproval: { 'issue-refund': 'always' } },
      { expectedHash, savedBy: 'api-key:operator' },
    );
    expect(saved.version).toBe(1);
    const [version] = await overrides.versions('tool-runner');
    expect(version).toMatchObject({ savedBy: 'api-key:operator', owner: 'anonymous:local' });
  });
});

describe('the override versions of a Bureau', () => {
  const bureaus: Bureau<AgentDefinitions>[] = [];
  const databases: PersistentBureauStorageFixture[] = [];
  afterEach(async () => {
    for (const bureau of bureaus.splice(0)) await bureau.dispose();
    for (const database of databases.splice(0)) await database.dispose();
  });

  async function open(database: PersistentBureauStorageFixture, first: boolean) {
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        'tool-runner': createAgent({
          name: 'Tool runner',
          generate: async () => ({ content: 'Done.', toolCalls: [] }),
          toolbox: createToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: first ? database.storage : database.open(),
      durable: true,
      durableOwnership: { ownership: 'none' },
    });
    bureaus.push(bureau);
    return bureau;
  }

  it('keeps a built-in agent’s versions across a restart, and restores one there', async () => {
    const database = createSqliteStorageFixture();
    databases.push(database);
    const bureau = await open(database, true);
    const first = await bureau.agents.overrides.save(
      'tool-runner',
      { stepLimit: 10 },
      { expectedHash: hashAgentOverrides({}) },
    );
    await bureau.agents.overrides.save(
      'tool-runner',
      { stepLimit: 20 },
      { expectedHash: first.hash },
    );
    await bureau.dispose();
    bureaus.splice(bureaus.indexOf(bureau), 1);

    const restarted = await open(database, false);
    const kept = await restarted.agents.overrides.versions('tool-runner');
    expect(kept.map((version) => [version.version, version.overrides])).toEqual([
      [2, { stepLimit: 20 }],
      [1, { stepLimit: 10 }],
    ]);
    const current = await restarted.agents.overrides.get('tool-runner');
    const restored = await restarted.agents.overrides.restore('tool-runner', 1, {
      expectedHash: current!.hash,
    });
    expect(restored).toEqual({ id: 'tool-runner', hash: first.hash, version: 3 });
  });
});
