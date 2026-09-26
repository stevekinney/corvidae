import { describe, expect, it } from 'bun:test';

import { RevisionRealmPool } from './revision-realm-pool.ts';

const workerUrl = new URL('./__fixtures__/revision-realm-worker-entry.ts', import.meta.url);

function makePool(overrides: Partial<{ concurrency: number }> = {}): RevisionRealmPool {
  return new RevisionRealmPool({
    workflowRevision: 'revision-a',
    workerUrl,
    expectedWorkflowTypes: ['order-workflow'],
    expectedArtifactDigest: 'digest-a',
    workerName: 'digest-a',
    concurrency: overrides.concurrency ?? 2,
  });
}

describe('RevisionRealmPool', () => {
  it('warms a fresh realm on acquireForExecution and activates it', async () => {
    const pool = makePool();
    const outcome = await pool.acquireForExecution('execution-1');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.realm.lifecycle.state).toBe('active');
    expect(pool.activeRealmCount).toBe(1);
    pool.dispose();
  });

  it('warms up to but not beyond its concurrency limit', async () => {
    const pool = makePool({ concurrency: 1 });
    const first = await pool.acquireForExecution('execution-1');
    expect(first.ok).toBe(true);

    const second = await pool.acquireForExecution('execution-2');
    expect(second).toEqual({ ok: false, reason: 'pool-at-capacity' });
    pool.dispose();
  });

  it('reuses an idle Ready realm instead of warming a new one', async () => {
    const pool = makePool({ concurrency: 1 });
    const first = await pool.acquireForExecution('execution-1');
    if (!first.ok) throw new Error('unreachable');
    expect(pool.realmCount).toBe(1);

    pool.releaseAfterExecution(first.realm);
    // The one realm this pool warmed is now Terminated (drained after its
    // one execution), not idle-and-reusable -- a realm never serves two
    // executions in this slice. A second acquire must warm a fresh one.
    expect(pool.realmCount).toBe(0);
    expect(first.realm.lifecycle.state).toBe('terminated');

    const second = await pool.acquireForExecution('execution-2');
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.realm).not.toBe(first.realm);
    pool.dispose();
  });

  it('refuses a new execution once the revision is marked inactive', async () => {
    const pool = makePool();
    pool.markInactive();
    const outcome = await pool.acquireForExecution('execution-1');
    expect(outcome).toEqual({ ok: false, reason: 'revision-not-active' });
    pool.dispose();
  });

  it('keeps an in-flight execution running after markInactive -- the old realm remains available for runs pinned to it', async () => {
    const pool = makePool();
    const outcome = await pool.acquireForExecution('execution-1');
    if (!outcome.ok) throw new Error('unreachable');

    pool.markInactive();

    expect(outcome.realm.lifecycle.state).toBe('active');
    expect(pool.activeRealmCount).toBe(1);
    expect(pool.isDrained).toBe(false);

    pool.releaseAfterExecution(outcome.realm);
    expect(pool.isDrained).toBe(true);
  });

  it('is drained immediately by markInactive when it has no in-flight execution', () => {
    const pool = makePool();
    expect(pool.isDrained).toBe(false);
    pool.markInactive();
    expect(pool.isDrained).toBe(true);
  });

  it('discards a crashed realm and reflects zero active realms', async () => {
    const pool = makePool();
    const outcome = await pool.acquireForExecution('execution-1');
    if (!outcome.ok) throw new Error('unreachable');

    outcome.realm.crash();
    pool.forgetCrashedRealm(outcome.realm);

    expect(pool.activeRealmCount).toBe(0);
    expect(pool.realmCount).toBe(0);
  });
});
