/**
 * COR-1524 — the snapshots a file agent's runs start from, the references that keep them, and
 * when a snapshot is pruned: kept while any run that references it is retained, gone after the
 * last one's retention ends.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import type { AgentFileDefinition } from './agent-file';
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
    skills: [],
    published: false,
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
