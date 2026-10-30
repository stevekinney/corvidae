/**
 * COR-1815 — the saved versions of a file agent, at the store: one version is written in the same
 * conditional batch that raises the revision, the diff names the keys that changed, and the oldest
 * versions beyond the limit are pruned unless a retained run references them.
 */
import {
  type ConditionalTextValueStore,
  MemoryStorage,
  textValueStore,
} from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';

import type { AgentFileDefinition } from './agent-file';
import { AGENT_REVISION_KEY_PREFIX, createAgentRevisionStore } from './agent-revision-store';
import {
  AGENT_VERSION_KEY_PREFIX,
  AGENT_VERSION_LIMIT,
  agentVersionKey,
  changedDefinitionKeys,
  createAgentVersionStore,
  encodeAgentVersion,
  parseAgentVersion,
  versionKeysToPrune,
} from './agent-version-store';

const DEFINITION: AgentFileDefinition = {
  name: 'Helper',
  description: null,
  model: 'anthropic/claude-opus-5-5',
  tools: [],
  skillDescriptors: [],
  a2a: false,
  instructions: 'One.\n',
};

/** A distinct valid hash for the nth change. */
const hashOf = (n: number): string => n.toString(16).padStart(64, '0');

function newStore(): ConditionalTextValueStore {
  return textValueStore(new MemoryStorage());
}

/** The revisions stored for `helper`, newest first. */
async function keptRevisions(store: ConditionalTextValueStore): Promise<number[]> {
  const stored = await createAgentVersionStore({ store }).list('helper');
  return stored.map((entry) => entry.revision);
}

function version(
  overrides: Partial<{
    definition: AgentFileDefinition;
    savedBy: string | null;
    retainedRevisions: () => Promise<ReadonlySet<number>>;
  }> = {},
) {
  return {
    definition: DEFINITION,
    savedAt: '2026-10-29T00:00:00.000Z',
    savedBy: null,
    owner: 'anonymous:local',
    ...overrides,
  };
}

describe('changedDefinitionKeys', () => {
  it('names only the instructions for a change to the body alone', () => {
    expect(changedDefinitionKeys(DEFINITION, { ...DEFINITION, instructions: 'Two.\n' })).toEqual([
      'instructions',
    ]);
  });

  it('names every key that differs, in the definition’s own order, comparing lists by value', () => {
    expect(
      changedDefinitionKeys(DEFINITION, {
        ...DEFINITION,
        instructions: 'Two.\n',
        tools: ['lookup-order'],
        name: 'Renamed',
        skillDescriptors: [],
      }),
    ).toEqual(['name', 'tools', 'instructions']);
    expect(changedDefinitionKeys(DEFINITION, { ...DEFINITION, tools: [] })).toEqual([]);
  });

  it('lists every key the definition has when there is no previous version', () => {
    expect(changedDefinitionKeys(undefined, DEFINITION)).toEqual([
      'name',
      'description',
      'model',
      'tools',
      'skillDescriptors',
      'a2a',
      'instructions',
    ]);
  });
});

describe('versionKeysToPrune', () => {
  const keys = (...revisions: number[]) => revisions.map((n) => agentVersionKey('helper', n));

  it('removes nothing while the new version fits in the limit', () => {
    expect(
      versionKeysToPrune({
        id: 'helper',
        existingKeys: keys(1, 2, 3),
        newest: 4,
        retained: new Set(),
        limit: 4,
      }),
    ).toEqual([]);
  });

  it('compares revisions as numbers: 9 is older than 10', () => {
    expect(
      versionKeysToPrune({
        id: 'helper',
        existingKeys: keys(10, 11, 9),
        newest: 12,
        retained: new Set(),
        limit: 3,
      }),
    ).toEqual(keys(9));
  });

  it('skips a retained revision even when it is the oldest, and takes the next oldest', () => {
    expect(
      versionKeysToPrune({
        id: 'helper',
        existingKeys: keys(1, 2, 3),
        newest: 4,
        retained: new Set([1]),
        limit: 3,
      }),
    ).toEqual(keys(2));
  });

  it('keeps more than the limit when every older version is retained', () => {
    expect(
      versionKeysToPrune({
        id: 'helper',
        existingKeys: keys(1, 2),
        newest: 3,
        retained: new Set([1, 2]),
        limit: 2,
      }),
    ).toEqual([]);
  });
});

describe('a stored version', () => {
  it('reads back what was written, and reads as absent when it is not valid', () => {
    const record = {
      revision: 3,
      hash: hashOf(3),
      savedAt: '2026-10-29T00:00:00.000Z',
      savedBy: 'api-key:alice',
      owner: 'anonymous:local',
      definition: DEFINITION,
      changedKeys: ['instructions'],
    };
    expect(parseAgentVersion(encodeAgentVersion(record))).toEqual(record);
    expect(parseAgentVersion(null)).toBeUndefined();
    expect(parseAgentVersion('not json')).toBeUndefined();
    expect(
      parseAgentVersion(JSON.stringify({ ...record, definition: { ...DEFINITION, model: '' } })),
    ).toBeUndefined();
    expect(parseAgentVersion(JSON.stringify({ ...record, revision: 0 }))).toBeUndefined();
    expect(parseAgentVersion(JSON.stringify({ ...record, savedBy: 7 }))).toBeUndefined();
  });
});

describe('advance with a version', () => {
  it('writes the version in the same batch as the revision, and nothing for a call that raises nothing', async () => {
    const store = newStore();
    const revisions = createAgentRevisionStore({ store });
    const versions = createAgentVersionStore({ store });

    await revisions.advance('helper', hashOf(1), { version: version() });
    await revisions.advance('helper', hashOf(1), { version: version({ savedBy: 'someone' }) });

    const stored = await versions.list('helper');
    expect(stored.map((entry) => [entry.revision, entry.hash, entry.savedBy])).toEqual([
      [1, hashOf(1), null],
    ]);
    expect(stored[0]?.owner).toBe('anonymous:local');
  });

  it('diffs against the previous version', async () => {
    const store = newStore();
    const revisions = createAgentRevisionStore({ store });
    await revisions.advance('helper', hashOf(1), { version: version() });
    await revisions.advance('helper', hashOf(2), {
      version: version({ definition: { ...DEFINITION, instructions: 'Two.\n' } }),
    });

    const [second] = await createAgentVersionStore({ store }).list('helper');
    expect(second).toMatchObject({ revision: 2, changedKeys: ['instructions'] });
  });

  it('leaves neither the revision nor the version when the batch does not commit', async () => {
    const store = newStore();
    const failing: ConditionalTextValueStore = {
      ...store,
      conditionalBatch: async () => {
        throw new Error('the process stopped between the writes');
      },
    };

    const failure = await rejectionOf(
      createAgentRevisionStore({ store: failing }).advance('helper', hashOf(1), {
        version: version(),
      }),
    );

    expect(failure).toMatchObject({ message: expect.stringContaining('stopped') });

    expect(await store.list(AGENT_REVISION_KEY_PREFIX)).toEqual([]);
    expect(await store.list(AGENT_VERSION_KEY_PREFIX)).toEqual([]);
  });

  it('records two concurrent changes as two versions with distinct revisions', async () => {
    const store = newStore();
    const first = createAgentRevisionStore({ store });
    const second = createAgentRevisionStore({ store });

    const [one, two] = await Promise.all([
      first.advance('helper', hashOf(1), { version: version() }),
      second.advance('helper', hashOf(2), { version: version() }),
    ]);

    expect(new Set([one.revision, two.revision])).toEqual(new Set([1, 2]));
    const stored = await createAgentVersionStore({ store }).list('helper');
    expect(stored.map((entry) => entry.revision)).toEqual([2, 1]);
    expect(new Set(stored.map((entry) => entry.hash))).toEqual(new Set([hashOf(1), hashOf(2)]));
  });

  it('records two processes that see one change as one version', async () => {
    const store = newStore();
    const [one, two] = await Promise.all([
      createAgentRevisionStore({ store }).advance('helper', hashOf(1), { version: version() }),
      createAgentRevisionStore({ store }).advance('helper', hashOf(1), { version: version() }),
    ]);

    expect([one.revision, two.revision]).toEqual([1, 1]);
    expect(await createAgentVersionStore({ store }).list('helper')).toHaveLength(1);
  });

  it('prunes the oldest version when the 51st is written, and numbers revisions past 99 correctly', async () => {
    const store = newStore();
    const revisions = createAgentRevisionStore({ store });

    for (let n = 1; n <= AGENT_VERSION_LIMIT; n += 1) {
      await revisions.advance('helper', hashOf(n), { version: version() });
    }
    const atLimit = await keptRevisions(store);
    expect(atLimit).toHaveLength(50);
    expect(atLimit.at(-1)).toBe(1);

    await revisions.advance('helper', hashOf(51), { version: version() });
    const afterOne = await keptRevisions(store);
    expect(afterOne).toHaveLength(50);
    expect(afterOne.at(0)).toBe(51);
    expect(afterOne.at(-1)).toBe(2);

    for (let n = 52; n <= 120; n += 1) {
      await revisions.advance('helper', hashOf(n), { version: version() });
    }
    const afterMany = await keptRevisions(store);
    expect(afterMany).toHaveLength(50);
    expect([afterMany.at(0), afterMany.at(-1)]).toEqual([120, 71]);
  });

  it('keeps a version a retained run references even when it is the oldest', async () => {
    const store = newStore();
    const revisions = createAgentRevisionStore({ store });
    const retainedRevisions = async () => new Set([1]);

    for (let n = 1; n <= 52; n += 1) {
      await revisions.advance('helper', hashOf(n), { version: version({ retainedRevisions }) });
    }

    const stored = await createAgentVersionStore({ store }).list('helper');
    const kept = stored.map((entry) => entry.revision);
    expect(kept).toHaveLength(50);
    expect(kept.at(-1)).toBe(1);
    expect(kept).not.toContain(2);
    expect(kept).not.toContain(3);
    expect(kept).toContain(52);
  });

  it('prunes only the agent whose version is written', async () => {
    const store = newStore();
    const revisions = createAgentRevisionStore({ store });
    await revisions.advance('other', hashOf(1), { version: version() });
    for (let n = 1; n <= 52; n += 1) {
      await revisions.advance('helper', hashOf(n), { version: version() });
    }

    expect(await createAgentVersionStore({ store }).list('other')).toHaveLength(1);
  });
});
