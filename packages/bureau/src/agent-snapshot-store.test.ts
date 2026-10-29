/**
 * COR-1524 — the snapshots a file agent's runs start from, the references that keep them, and
 * when a snapshot is pruned: kept while any run that references it is retained, gone after the
 * last one's retention ends.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import { AgentSnapshotError, type AgentFileDefinition } from './agent-file';
import {
  AGENT_RUN_REFERENCE_KEY_PREFIX,
  AGENT_SNAPSHOT_KEY_PREFIX,
  createAgentSnapshotStore,
} from './agent-snapshot-store';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-10-01T00:00:00.000Z');

function definition(instructions: string): AgentFileDefinition {
  return {
    name: 'Helper',
    description: null,
    model: 'anthropic/claude-opus-5-5',
    tools: [],
    skillDescriptors: [],
    a2a: false,
    instructions,
  };
}

function setup() {
  const backing = textValueStore(new MemoryStorage());
  const clock = { now: START };
  const store = createAgentSnapshotStore({
    store: backing,
    nowISO: () => new Date(clock.now).toISOString(),
  });
  return { backing, clock, store };
}

describe('recordRun', () => {
  it('stores the definition under the identifier and hash and ties the run to it', async () => {
    const { backing, store } = setup();
    await store.recordRun({ id: 'helper', hash: 'aa', definition: definition('one') }, 'run-1');
    expect(await backing.list(AGENT_SNAPSHOT_KEY_PREFIX)).toEqual([
      `${AGENT_SNAPSHOT_KEY_PREFIX}helper:aa`,
    ]);
    expect(await backing.list(AGENT_RUN_REFERENCE_KEY_PREFIX)).toEqual([
      `${AGENT_RUN_REFERENCE_KEY_PREFIX}run-1`,
    ]);
    const loaded = await store.load('helper', 'aa');
    expect(loaded?.definition.instructions).toBe('one');
    expect(await store.load('helper', 'bb')).toBeUndefined();
  });

  it('keeps one snapshot for runs on the same hash, and the first definition it stored', async () => {
    const { clock, store } = setup();
    await store.recordRun({ id: 'helper', hash: 'aa', definition: definition('one') }, 'run-1');
    clock.now += 1000;
    await store.recordRun({ id: 'helper', hash: 'aa', definition: definition('one') }, 'run-2');
    const revisions = await store.revisions('helper');
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.firstRunAt).toBe(new Date(START).toISOString());
    expect(revisions[0]?.lastRunAt).toBe(new Date(START + 1000).toISOString());
  });

  it('keeps the records versioned', async () => {
    const { backing, store } = setup();
    await store.recordRun({ id: 'helper', hash: 'aa', definition: definition('one') }, 'run-1');
    for (const prefix of [AGENT_SNAPSHOT_KEY_PREFIX, AGENT_RUN_REFERENCE_KEY_PREFIX]) {
      const [key] = await backing.list(prefix);
      expect(JSON.parse((await backing.get(key ?? '')) ?? '{}').schemaVersion).toBe(1);
    }
  });
});

describe('revisions', () => {
  it('lists the snapshots that have run for an identifier, newest run first', async () => {
    const { clock, store } = setup();
    await store.recordRun({ id: 'helper', hash: 'aa', definition: definition('one') }, 'run-1');
    clock.now += 1000;
    await store.recordRun({ id: 'helper', hash: 'bb', definition: definition('two') }, 'run-2');
    clock.now += 1000;
    await store.recordRun({ id: 'other', hash: 'cc', definition: definition('x') }, 'run-3');
    const newestFirst = await store.revisions('helper');
    expect(newestFirst.map((revision) => revision.hash)).toEqual(['bb', 'aa']);
    // Running the first hash again makes it the newest.
    clock.now += 1000;
    await store.recordRun({ id: 'helper', hash: 'aa', definition: definition('one') }, 'run-4');
    const again = await store.revisions('helper');
    expect(again.map((revision) => revision.hash)).toEqual(['aa', 'bb']);
    expect(await store.revisions('nobody')).toEqual([]);
  });

  it('does not mix an identifier with one it is a prefix of', async () => {
    const { store } = setup();
    await store.recordRun({ id: 'help', hash: 'aa', definition: definition('x') }, 'run-1');
    await store.recordRun({ id: 'helper', hash: 'bb', definition: definition('y') }, 'run-2');
    const prefixed = await store.revisions('help');
    expect(prefixed.map((revision) => revision.hash)).toEqual(['aa']);
  });
});

describe('retention', () => {
  it('keeps a snapshot until every run that references it is past retention', async () => {
    const { clock, store } = setup();
    await store.recordRun({ id: 'helper', hash: 'aa', definition: definition('one') }, 'run-1');
    await store.recordRun({ id: 'helper', hash: 'aa', definition: definition('one') }, 'run-2');
    await store.settleRun('run-1');
    clock.now += 20 * DAY;
    await store.settleRun('run-2');
    clock.now += 15 * DAY;
    // run-1 settled 35 days ago and run-2 15: only the first is past a 30 day window.
    expect(await store.pruneSettledBefore(clock.now - 30 * DAY)).toBe(0);
    expect(await store.load('helper', 'aa')).toBeDefined();
    clock.now += 20 * DAY;
    expect(await store.pruneSettledBefore(clock.now - 30 * DAY)).toBe(1);
    expect(await store.load('helper', 'aa')).toBeUndefined();
    expect(await store.revisions('helper')).toEqual([]);
  });

  it('never prunes a run that has not settled', async () => {
    const { clock, store } = setup();
    await store.recordRun({ id: 'helper', hash: 'aa', definition: definition('one') }, 'run-1');
    clock.now += 365 * DAY;
    expect(await store.pruneSettledBefore(clock.now - 30 * DAY)).toBe(0);
    expect(await store.load('helper', 'aa')).toBeDefined();
  });

  it('prunes only the snapshot whose last reference ended', async () => {
    const { clock, store } = setup();
    await store.recordRun({ id: 'helper', hash: 'aa', definition: definition('one') }, 'run-1');
    await store.recordRun({ id: 'helper', hash: 'bb', definition: definition('two') }, 'run-2');
    await store.settleRun('run-1');
    clock.now += 40 * DAY;
    await store.settleRun('run-2');
    expect(await store.pruneSettledBefore(clock.now - 30 * DAY)).toBe(1);
    expect(await store.load('helper', 'aa')).toBeUndefined();
    expect(await store.load('helper', 'bb')).toBeDefined();
  });

  it('releases a deleted run’s reference and its snapshot when no other run holds it', async () => {
    const { store } = setup();
    await store.recordRun({ id: 'helper', hash: 'aa', definition: definition('one') }, 'run-1');
    await store.recordRun({ id: 'helper', hash: 'aa', definition: definition('one') }, 'run-2');
    await store.releaseRun('run-1');
    expect(await store.load('helper', 'aa')).toBeDefined();
    await store.releaseRun('run-2');
    expect(await store.load('helper', 'aa')).toBeUndefined();
    await store.releaseRun('run-2');
  });

  it('settles a run once, at the first settlement', async () => {
    const { backing, clock, store } = setup();
    await store.recordRun({ id: 'helper', hash: 'aa', definition: definition('one') }, 'run-1');
    await store.settleRun('run-1');
    const first = await backing.get(`${AGENT_RUN_REFERENCE_KEY_PREFIX}run-1`);
    clock.now += DAY;
    await store.settleRun('run-1');
    expect(await backing.get(`${AGENT_RUN_REFERENCE_KEY_PREFIX}run-1`)).toBe(first);
    await store.settleRun('unknown');
  });

  it('treats a record that is not a snapshot as absent', async () => {
    const { backing, store } = setup();
    await backing.set(`${AGENT_SNAPSHOT_KEY_PREFIX}helper:aa`, 'not json');
    expect(await store.load('helper', 'aa')).toBeUndefined();
    expect(await store.revisions('helper')).toEqual([]);
  });
});

describe('a start that has not been held', () => {
  it('writes the snapshot but no reference until the run is held', async () => {
    const { backing, store } = setup();
    const ticket = await store.begin({ id: 'helper', hash: 'aa', definition: definition('one') });
    expect(await backing.list(AGENT_SNAPSHOT_KEY_PREFIX)).toHaveLength(1);
    expect(await backing.list(AGENT_RUN_REFERENCE_KEY_PREFIX)).toEqual([]);
    await ticket.hold('run-1');
    expect(await backing.list(AGENT_RUN_REFERENCE_KEY_PREFIX)).toHaveLength(1);
  });

  it('abandoning removes a snapshot nothing holds, and leaves one a run holds', async () => {
    const { store } = setup();
    const lost = await store.begin({ id: 'helper', hash: 'aa', definition: definition('one') });
    await lost.abandon();
    expect(await store.load('helper', 'aa')).toBeUndefined();

    await store.recordRun({ id: 'helper', hash: 'bb', definition: definition('two') }, 'run-1');
    const second = await store.begin({ id: 'helper', hash: 'bb', definition: definition('two') });
    await second.abandon();
    expect(await store.load('helper', 'bb')).toBeDefined();
  });

  it('keeps the snapshot while another start of it is in flight, whoever abandons first', async () => {
    const { store } = setup();
    const winner = await store.begin({ id: 'helper', hash: 'aa', definition: definition('one') });
    const loser = await store.begin({ id: 'helper', hash: 'aa', definition: definition('one') });
    await loser.abandon();
    expect(await store.load('helper', 'aa')).toBeDefined();
    await winner.hold('run-1');
    expect(await store.load('helper', 'aa')).toBeDefined();
  });

  it('is not undone by a release or a prune that runs between the begin and the hold', async () => {
    const { clock, store } = setup();
    await store.recordRun({ id: 'helper', hash: 'aa', definition: definition('one') }, 'old');
    await store.settleRun('old');
    const ticket = await store.begin({ id: 'helper', hash: 'aa', definition: definition('one') });
    await store.releaseRun('old');
    clock.now += 400 * DAY;
    await store.pruneSettledBefore(clock.now);
    expect(await store.load('helper', 'aa')).toBeDefined();
    await ticket.hold('new');
    expect(await store.load('helper', 'aa')).toBeDefined();
  });

  it('holding a run that already holds the same snapshot keeps its start and settlement', async () => {
    const { clock, store } = setup();
    const first = await store.begin({ id: 'helper', hash: 'aa', definition: definition('one') });
    await first.hold('run-1');
    await store.settleRun('run-1');
    const before = await store.reference('run-1');
    clock.now += DAY;
    const again = await store.begin({ id: 'helper', hash: 'aa', definition: definition('one') });
    await again.hold('run-1');
    expect(await store.reference('run-1')).toEqual(before);
  });

  it('holding a run rebinds a reference that pointed at another hash', async () => {
    const { store } = setup();
    await store.recordRun({ id: 'helper', hash: 'aa', definition: definition('one') }, 'run-1');
    const ticket = await store.begin({ id: 'helper', hash: 'bb', definition: definition('two') });
    await ticket.hold('run-1');
    const rebound = await store.reference('run-1');
    expect(rebound?.hash).toBe('bb');
  });
});

/** The revision a run's reference holds, or `undefined`. */
async function revisionOf(store: ReturnType<typeof setup>['store'], runId: string) {
  const reference = await store.reference(runId);
  return reference?.definitionRevision;
}

describe('the revision a run started at (COR-1584)', () => {
  it('is kept on the run’s reference, with the hash it belongs to', async () => {
    const { store } = setup();
    await store.recordRun(
      { id: 'helper', hash: 'aa', definitionRevision: 2, definition: definition('one') },
      'run-1',
    );
    await store.recordRun(
      { id: 'helper', hash: 'aa', definitionRevision: 4, definition: definition('one') },
      'run-2',
    );

    expect(await revisionOf(store, 'run-1')).toBe(2);
    expect(await revisionOf(store, 'run-2')).toBe(4);
  });

  it('is absent from a reference written without one, which still reads', async () => {
    const { backing, store } = setup();
    await backing.set(
      `${AGENT_RUN_REFERENCE_KEY_PREFIX}run-old`,
      JSON.stringify({
        schemaVersion: 1,
        id: 'helper',
        hash: 'aa',
        startedAt: '2026-10-01T00:00:00.000Z',
      }),
    );

    const reference = await store.reference('run-old');

    expect(reference).toMatchObject({ id: 'helper', hash: 'aa' });
    expect(reference?.definitionRevision).toBeUndefined();
    const open = await store.unsettledReferences();
    expect(open.map((entry) => entry.runId)).toEqual(['run-old']);
  });

  it.each([0, -1, 1.5, '2', null])('is dropped from a reference that holds %p', async (stored) => {
    const { backing, store } = setup();
    await backing.set(
      `${AGENT_RUN_REFERENCE_KEY_PREFIX}run-odd`,
      JSON.stringify({
        schemaVersion: 1,
        id: 'helper',
        hash: 'aa',
        startedAt: '2026-10-01T00:00:00.000Z',
        definitionRevision: stored,
      }),
    );

    const reference = await store.reference('run-odd');

    expect(reference).toMatchObject({ id: 'helper', hash: 'aa' });
    expect(reference?.definitionRevision).toBeUndefined();
  });

  it('is filled by a hold of the same snapshot when the reference has none, keeping the start and the settlement', async () => {
    const { clock, store } = setup();
    await store.recordRun({ id: 'helper', hash: 'aa', definition: definition('one') }, 'run-1');
    await store.settleRun('run-1');
    const before = await store.reference('run-1');
    clock.now += DAY;

    await store.recordRun(
      { id: 'helper', hash: 'aa', definitionRevision: 3, definition: definition('one') },
      'run-1',
    );

    expect(await store.reference('run-1')).toEqual({
      ...before,
      definitionRevision: 3,
    } as typeof before);
  });

  it('is filled by a hold when the stored value was invalid and dropped on read', async () => {
    const { backing, store } = setup();
    await backing.set(
      `${AGENT_RUN_REFERENCE_KEY_PREFIX}run-odd`,
      JSON.stringify({
        schemaVersion: 1,
        id: 'helper',
        hash: 'aa',
        startedAt: '2026-10-01T00:00:00.000Z',
        definitionRevision: 0,
      }),
    );

    await store.recordRun(
      { id: 'helper', hash: 'aa', definitionRevision: 5, definition: definition('one') },
      'run-odd',
    );

    expect(await revisionOf(store, 'run-odd')).toBe(5);
  });

  it.each([2, 4])(
    'is never changed by a hold at revision %p once it is recorded',
    async (later) => {
      const { store } = setup();
      await store.recordRun(
        { id: 'helper', hash: 'aa', definitionRevision: 3, definition: definition('one') },
        'run-1',
      );

      await store.recordRun(
        { id: 'helper', hash: 'aa', definitionRevision: later, definition: definition('one') },
        'run-1',
      );

      expect(await revisionOf(store, 'run-1')).toBe(3);
    },
  );

  it('is not erased by a hold that names none', async () => {
    const { store } = setup();
    await store.recordRun(
      { id: 'helper', hash: 'aa', definitionRevision: 3, definition: definition('one') },
      'run-1',
    );

    await store.recordRun({ id: 'helper', hash: 'aa', definition: definition('one') }, 'run-1');

    expect(await revisionOf(store, 'run-1')).toBe(3);
  });
});

describe('reading references', () => {
  it('lists the references that have not settled, and settles one at a stated time', async () => {
    const { store } = setup();
    await store.recordRun({ id: 'helper', hash: 'aa', definition: definition('one') }, 'run-1');
    await store.recordRun({ id: 'helper', hash: 'aa', definition: definition('one') }, 'run-2');
    await store.settleRun('run-1', '2026-09-01T00:00:00.000Z');
    const open = await store.unsettledReferences();
    expect(open.map((reference) => reference.runId)).toEqual(['run-2']);
    const stamped = await store.reference('run-1');
    expect(stamped?.settledAt).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('a stored snapshot whose definition is not valid', () => {
  const invalid: unknown[] = [
    {},
    { model: 'anthropic/claude-opus-5-5' },
    { ...definition('x'), skillDescriptors: undefined, tools: 'lookup-order' },
    { ...definition('x'), a2a: 'yes' },
  ];

  it.each(invalid.map((value, index) => [index, value] as const))(
    'fails with snapshot-unresolvable on read, not with a TypeError (%i)',
    async (_index, value) => {
      const { backing, store } = setup();
      await backing.set(
        `${AGENT_SNAPSHOT_KEY_PREFIX}helper:aa`,
        JSON.stringify({
          schemaVersion: 1,
          id: 'helper',
          hash: 'aa',
          firstRunAt: '2026-10-01T00:00:00.000Z',
          lastRunAt: '2026-10-01T00:00:00.000Z',
          definition: value,
        }),
      );
      let thrown: unknown;
      try {
        await store.load('helper', 'aa');
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AgentSnapshotError);
      expect(thrown).toMatchObject({
        code: 'snapshot-unresolvable',
        agentId: 'helper',
        hash: 'aa',
      });
      // A listing skips it rather than failing.
      expect(await store.revisions('helper')).toEqual([]);
    },
  );

  it('fills the defaults a later field would need, so an older snapshot still resumes', async () => {
    const { backing, store } = setup();
    await backing.set(
      `${AGENT_SNAPSHOT_KEY_PREFIX}helper:aa`,
      JSON.stringify({
        schemaVersion: 1,
        id: 'helper',
        hash: 'aa',
        firstRunAt: '2026-10-01T00:00:00.000Z',
        lastRunAt: '2026-10-01T00:00:00.000Z',
        definition: { name: 'Helper', model: 'anthropic/claude-opus-5-5', instructions: 'Hi.\n' },
      }),
    );
    const filled = await store.load('helper', 'aa');
    expect(filled?.definition).toEqual({
      name: 'Helper',
      description: null,
      model: 'anthropic/claude-opus-5-5',
      tools: [],
      skillDescriptors: [],
      a2a: false,
      instructions: 'Hi.\n',
    });
  });

  it('loads a snapshot written before the A2A opt-in and `skillDescriptors` existed', async () => {
    const { backing, store } = setup();
    // The exact shape of a definition stored before COR-1864: `skills` and `published` keys.
    await backing.set(
      `${AGENT_SNAPSHOT_KEY_PREFIX}helper:aa`,
      JSON.stringify({
        schemaVersion: 1,
        id: 'helper',
        hash: 'aa',
        firstRunAt: '2026-10-01T00:00:00.000Z',
        lastRunAt: '2026-10-01T00:00:00.000Z',
        definition: {
          name: 'Helper',
          description: 'Helps',
          model: 'anthropic/claude-opus-5-5',
          tools: ['lookup-order'],
          skills: [{ id: 'cite', name: 'Cite', description: 'Cites', tags: ['research'] }],
          published: true,
          instructions: 'Hi.\n',
        },
      }),
    );
    const loaded = await store.load('helper', 'aa');
    // The old keys are dropped, and the new fields take their defaults: the run still resumes.
    expect(loaded?.definition).toEqual({
      name: 'Helper',
      description: 'Helps',
      model: 'anthropic/claude-opus-5-5',
      tools: ['lookup-order'],
      skillDescriptors: [],
      a2a: false,
      instructions: 'Hi.\n',
    });
    const revisions = await store.revisions('helper');
    expect(revisions.map((revision) => revision.hash)).toEqual(['aa']);
  });
});
