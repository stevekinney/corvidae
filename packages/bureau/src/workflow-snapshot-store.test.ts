/**
 * COR-1527 — the stored revisions of workflow files: content addressed, written before a revision
 * is registered, stamped when an instance runs, listed newest first once they have run, and pruned
 * only when nothing holds them.
 */
import { MemoryStorage, textValueStore, type WorkflowDocument } from '@lostgradient/weft';
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
      lastActivityAt: async () => undefined,
    });
    expect(removed).toBe(1);
    expect(await snapshots.snapshotsOf('digest')).toHaveLength(1);
  });
});
