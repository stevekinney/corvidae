/**
 * COR-1527 — the stored revisions of workflow files: content addressed, written before a revision
 * is registered, stamped when an instance runs, listed newest first once they have run, and pruned
 * only when nothing holds them.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { type WorkflowDocument } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import {
  createWorkflowSnapshotStore,
  WORKFLOW_SNAPSHOT_KEY_PREFIX,
  WorkflowSnapshotError,
} from './workflow-snapshot-store';
import { workflowVersionOf } from './workflow-file';

function document(steps: number, name = 'digest'): WorkflowDocument {
  return {
    name,
    trigger: { kind: 'schedule', spec: '1s' },
    steps: Array.from({ length: steps }, () => ({ kind: 'sleep', duration: 1 })),
  };
}

function setup() {
  const store = textValueStore(new MemoryStorage());
  let clock = 0;
  const snapshots = createWorkflowSnapshotStore({
    store,
    nowISO: () => new Date(Date.UTC(2026, 9, 18, 0, 0, clock++)).toISOString(),
  });
  return { store, snapshots };
}

describe('the workflow snapshot store', () => {
  it('keys a snapshot by identifier and the Weft version, and reads it back', async () => {
    const { store, snapshots } = setup();
    const first = document(1);
    await snapshots.ensure('digest', first);
    const version = workflowVersionOf(first);
    expect(await store.list(WORKFLOW_SNAPSHOT_KEY_PREFIX)).toEqual([
      `bureau-workflow-snapshot:v1:digest:${version}`,
    ]);
    const loaded = await snapshots.load('digest', version);
    expect(loaded).toMatchObject({ id: 'digest', workflowVersion: version, document: first });
    expect(loaded?.firstRunAt).toBeUndefined();
  });

  it('does not rewrite a snapshot that is already stored', async () => {
    const { snapshots } = setup();
    const first = document(1);
    await snapshots.ensure('digest', first);
    const before = await snapshots.load('digest', workflowVersionOf(first));
    await snapshots.ensure('digest', first);
    const after = await snapshots.load('digest', workflowVersionOf(first));
    expect(after?.registeredAt).toBe(before?.registeredAt);
  });

  it('lists the identifiers that have snapshots, and each identifier’s snapshots apart', async () => {
    const { snapshots } = setup();
    await snapshots.ensure('b-flow', document(1, 'b-flow'));
    await snapshots.ensure('a-flow', document(1, 'a-flow'));
    await snapshots.ensure('a-flow', document(2, 'a-flow'));
    expect(await snapshots.identifiers()).toEqual(['a-flow', 'b-flow']);
    expect(await snapshots.snapshotsOf('a-flow')).toHaveLength(2);
    expect(await snapshots.snapshotsOf('b-flow')).toHaveLength(1);
    expect(await snapshots.snapshotsOf('a')).toEqual([]);
  });

  it('refuses a stored record whose document is not valid or does not hash to its key', async () => {
    const { store, snapshots } = setup();
    const first = document(1);
    await snapshots.ensure('digest', first);
    const version = workflowVersionOf(first);
    const key = `bureau-workflow-snapshot:v1:digest:${version}`;
    const stored = JSON.parse((await store.get(key)) ?? '{}');
    await store.set(key, JSON.stringify({ ...stored, document: document(2) }));
    expect(await snapshots.load('digest', version).catch((error: unknown) => error)).toBeInstanceOf(
      WorkflowSnapshotError,
    );
    await store.set(key, JSON.stringify({ ...stored, document: { name: 1 } }));
    expect(await snapshots.load('digest', version).catch((error: unknown) => error)).toBeInstanceOf(
      WorkflowSnapshotError,
    );
    expect(await snapshots.snapshotsOf('digest')).toEqual([]);
  });

  it('lists only the revisions that have run, most recently run first', async () => {
    const { snapshots } = setup();
    const a = document(1);
    const b = document(2);
    const c = document(3);
    for (const doc of [a, b, c]) await snapshots.ensure('digest', doc);
    expect(await snapshots.revisions('digest')).toEqual([]);
    await snapshots.stampRun('digest', workflowVersionOf(a), '2026-10-18T01:00:00.000Z');
    await snapshots.stampRun('digest', workflowVersionOf(b), '2026-10-18T02:00:00.000Z');
    const revisions = await snapshots.revisions('digest');
    expect(revisions.map((revision) => revision.workflowVersion)).toEqual([
      workflowVersionOf(b),
      workflowVersionOf(a),
    ]);
    expect(revisions[0]?.document).toEqual(b);
  });

  it('keeps the earliest first run and the latest last run, whatever order stamps arrive in', async () => {
    const { snapshots } = setup();
    const a = document(1);
    await snapshots.ensure('digest', a);
    const version = workflowVersionOf(a);
    await snapshots.stampRun('digest', version, '2026-10-18T05:00:00.000Z');
    await snapshots.stampRun('digest', version, '2026-10-18T03:00:00.000Z');
    await snapshots.stampRun('digest', version, '2026-10-18T09:00:00.000Z');
    const [revision] = await snapshots.revisions('digest');
    expect(revision).toMatchObject({
      firstRunAt: '2026-10-18T03:00:00.000Z',
      lastRunAt: '2026-10-18T09:00:00.000Z',
    });
  });

  it('ignores a stamp for a revision it never stored', async () => {
    const { snapshots } = setup();
    await snapshots.stampRun('digest', workflowVersionOf(document(1)), '2026-10-18T01:00:00.000Z');
    expect(await snapshots.identifiers()).toEqual([]);
  });

  it('prunes only what nothing holds and nothing used since the cutoff', async () => {
    const { snapshots } = setup();
    const a = document(1);
    const b = document(2);
    const c = document(3);
    for (const doc of [a, b, c]) await snapshots.ensure('digest', doc);
    await snapshots.stampRun('digest', workflowVersionOf(a), '2026-10-18T00:00:00.000Z');
    const cutoff = Date.parse('2027-01-01T00:00:00.000Z');
    const removed = await snapshots.pruneUnheld({
      cutoff,
      isHeld: (snapshot) => snapshot.workflowVersion === workflowVersionOf(b),
      hasInFlight: () => false,
      lastActivityAt: async (snapshot) =>
        snapshot.workflowVersion === workflowVersionOf(c)
          ? Date.parse('2027-02-01T00:00:00.000Z')
          : undefined,
    });
    // `a` is unheld and idle, `b` is held, `c` had engine activity after the cutoff.
    expect(removed).toBe(1);
    const remaining = await snapshots.snapshotsOf('digest');
    const left = remaining.map((snapshot) => snapshot.workflowVersion);
    expect(left.toSorted()).toEqual([workflowVersionOf(b), workflowVersionOf(c)].toSorted());
  });

  it('keeps a snapshot inside the window and deletes one that cannot be read', async () => {
    const { store, snapshots } = setup();
    await snapshots.ensure('digest', document(1));
    await store.set(`${WORKFLOW_SNAPSHOT_KEY_PREFIX}digest:sha256:broken`, '{');
    const removed = await snapshots.pruneUnheld({
      cutoff: Date.parse('2020-01-01T00:00:00.000Z'),
      isHeld: () => false,
      hasInFlight: () => false,
      lastActivityAt: async () => undefined,
    });
    expect(removed).toBe(1);
    expect(await snapshots.snapshotsOf('digest')).toHaveLength(1);
  });
});

describe('pruning while an instance is in flight (COR-1583)', () => {
  it('keeps an unreadable snapshot record only for a workflow that has an instance in flight', async () => {
    const { store, snapshots } = setup();
    await store.set(`${WORKFLOW_SNAPSHOT_KEY_PREFIX}busy:sha256:broken`, '{');
    await store.set(`${WORKFLOW_SNAPSHOT_KEY_PREFIX}idle:sha256:broken`, '{');
    const asked: string[] = [];
    const removed = await snapshots.pruneUnheld({
      cutoff: Date.parse('2020-01-01T00:00:00.000Z'),
      isHeld: () => false,
      hasInFlight: (id) => {
        asked.push(id);
        return id === 'busy';
      },
      lastActivityAt: async () => undefined,
    });
    expect(removed).toBe(1);
    expect(asked.toSorted()).toEqual(['busy', 'idle']);
    expect(await store.list(WORKFLOW_SNAPSHOT_KEY_PREFIX)).toEqual([
      `${WORKFLOW_SNAPSHOT_KEY_PREFIX}busy:sha256:broken`,
    ]);
  });

  it('keeps an old cancellation record only for a workflow that has an instance in flight', async () => {
    const { store, snapshots } = setup();
    const old = {
      schemaVersion: 1,
      workflowVersion: 'sha256:abc',
      reason: 'Cancelled at startup because it cannot resume: nothing is stored.',
      cancelledAt: '2026-10-18T00:00:00.000Z',
    } as const;
    await snapshots.recordCancellation({ ...old, runId: 'busy-run', id: 'busy' });
    await snapshots.recordCancellation({ ...old, runId: 'idle-run', id: 'idle' });
    // A record that cannot be read names no workflow, so nothing can hold it.
    await store.set('bureau-workflow-cancelled-run:v1:unreadable', '{');
    await snapshots.pruneUnheld({
      cutoff: Date.parse('2027-01-01T00:00:00.000Z'),
      isHeld: () => false,
      hasInFlight: (id) => id === 'busy',
      lastActivityAt: async () => undefined,
    });
    expect(await snapshots.cancellationOf('busy-run')).toBeDefined();
    expect(await snapshots.cancellationOf('idle-run')).toBeUndefined();
    expect(await store.get('bureau-workflow-cancelled-run:v1:unreadable')).toBeNull();
  });
});

describe('the cancellation records', () => {
  const cancellation = {
    schemaVersion: 1,
    runId: 'run-1',
    id: 'gone',
    workflowVersion: 'sha256:abc',
    reason: 'Cancelled at startup because it cannot resume: nothing is stored.',
    cancelledAt: '2026-10-18T00:00:00.000Z',
  } as const;

  it('keeps the reason of a cancelled instance and names its workflow among the identifiers', async () => {
    const { snapshots } = setup();
    expect(await snapshots.cancellationOf('run-1')).toBeUndefined();
    await snapshots.recordCancellation(cancellation);
    expect(await snapshots.cancellationOf('run-1')).toEqual(cancellation);
    expect(await snapshots.identifiers()).toEqual(['gone']);
  });

  it('ignores a record that is not a cancellation', async () => {
    const { store, snapshots } = setup();
    await store.set('bureau-workflow-cancelled-run:v1:run-2', '{"runId":"run-2"}');
    await store.set('bureau-workflow-cancelled-run:v1:run-3', '{');
    expect(await snapshots.cancellationOf('run-2')).toBeUndefined();
    expect(await snapshots.cancellationOf('run-3')).toBeUndefined();
    expect(await snapshots.identifiers()).toEqual([]);
  });

  it('is deleted by the pass that prunes snapshots once it is older than the cutoff, and not before', async () => {
    const { snapshots } = setup();
    await snapshots.recordCancellation(cancellation);
    const prune = (cutoff: string) =>
      snapshots.pruneUnheld({
        cutoff: Date.parse(cutoff),
        isHeld: () => false,
        hasInFlight: () => false,
        lastActivityAt: async () => undefined,
      });
    await prune('2026-10-17T00:00:00.000Z');
    expect(await snapshots.cancellationOf('run-1')).toBeDefined();
    await prune('2026-10-19T00:00:00.000Z');
    expect(await snapshots.cancellationOf('run-1')).toBeUndefined();
  });
});
