/**
 * The seed ownership record itself (COR-1408): what a seed claims, what its release removes,
 * and which engine paths forget a claim. `schedule-run-seed-ownership.test.ts` drives the
 * same record through whole launches; these tests pin each rule on its own.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { noCallbacks } from './checkpoint-conflict.test-support.ts';
import { beginExecutionAttempt } from './execution-attempts.ts';
import { Engine } from './index.ts';
import { getInternals, type EngineInternals } from './internals.ts';
import {
  forgetSeededCleanupMembership,
  forgetSeededServices,
  seedScheduledRunState,
} from './scheduled-seed-ownership.ts';
import { cleanupTerminalWorkflowMemory, cleanupWaiters } from './termination/cleanup.ts';

const id = 'seeded-run';

async function createInternals() {
  const engine = await Engine.create({ storage: new MemoryStorage(), recover: false });
  return { engine, internals: getInternals(engine) };
}

/** What an adopted launch's rollback does to the id, before its seed's release runs. */
function removeAsRollbackDoes(internals: EngineInternals): void {
  internals.workflowServices.delete(id);
  forgetSeededServices(internals, id);
  internals.workflowsNeedingTerminalCleanup.delete(id);
  forgetSeededCleanupMembership(internals, id);
}

describe('seedScheduledRunState', () => {
  it('claims the entries it adds, and its release takes them back along with the record', async () => {
    const { engine, internals } = await createInternals();
    try {
      const services = { owner: 'the seed' };

      const release = seedScheduledRunState(internals, id, { value: services });

      expect(internals.workflowServices.get(id)).toBe(services);
      expect(internals.workflowsNeedingTerminalCleanup.has(id)).toBe(true);
      expect(internals.scheduledSeedOwners.has(id)).toBe(true);

      release();

      expect(internals.workflowServices.has(id)).toBe(false);
      expect(internals.workflowsNeedingTerminalCleanup.has(id)).toBe(false);
      expect(internals.scheduledSeedOwners.size).toBe(0);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('claims nothing for entries the id already holds, so its release leaves them alone', async () => {
    const { engine, internals } = await createInternals();
    try {
      const held = { owner: 'a live run' };
      internals.workflowServices.set(id, held);
      internals.workflowsNeedingTerminalCleanup.add(id);

      const release = seedScheduledRunState(internals, id, { value: { owner: 'the seed' } });
      expect(internals.scheduledSeedOwners.size).toBe(0);

      release();

      expect(internals.workflowServices.get(id)).toBe(held);
      expect(internals.workflowsNeedingTerminalCleanup.has(id)).toBe(true);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('owns the services and the membership independently', async () => {
    const { engine, internals } = await createInternals();
    try {
      internals.workflowsNeedingTerminalCleanup.add(id);
      const services = { owner: 'the seed' };

      const release = seedScheduledRunState(internals, id, { value: services });
      expect(internals.workflowServices.get(id)).toBe(services);

      release();

      expect(internals.workflowServices.has(id)).toBe(false);
      expect(internals.workflowsNeedingTerminalCleanup.has(id)).toBe(true);
      expect(internals.scheduledSeedOwners.size).toBe(0);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('seeds the membership alone when there are no services to seed', async () => {
    const { engine, internals } = await createInternals();
    try {
      const release = seedScheduledRunState(internals, id, null);

      expect(internals.workflowServices.has(id)).toBe(false);
      expect(internals.workflowsNeedingTerminalCleanup.has(id)).toBe(true);

      release();

      expect(internals.workflowsNeedingTerminalCleanup.has(id)).toBe(false);
      expect(internals.scheduledSeedOwners.size).toBe(0);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('releases nothing once another seed owns the id, even for the same services value', async () => {
    const { engine, internals } = await createInternals();
    try {
      const shared = { owner: 'one value for both seeds' };
      const staleRelease = seedScheduledRunState(internals, id, { value: shared });
      removeAsRollbackDoes(internals);
      const currentRelease = seedScheduledRunState(internals, id, { value: shared });

      staleRelease();

      expect(internals.workflowServices.get(id)).toBe(shared);
      expect(internals.workflowsNeedingTerminalCleanup.has(id)).toBe(true);
      expect(internals.scheduledSeedOwners.has(id)).toBe(true);

      currentRelease();

      expect(internals.workflowServices.has(id)).toBe(false);
      expect(internals.workflowsNeedingTerminalCleanup.has(id)).toBe(false);
      expect(internals.scheduledSeedOwners.size).toBe(0);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('releases nothing a different path installed after the seed was forgotten', async () => {
    const { engine, internals } = await createInternals();
    try {
      const staleRelease = seedScheduledRunState(internals, id, { value: { owner: 'the seed' } });
      removeAsRollbackDoes(internals);
      const installed = { owner: 'a live run' };
      internals.workflowServices.set(id, installed);
      internals.workflowsNeedingTerminalCleanup.add(id);

      staleRelease();

      expect(internals.workflowServices.get(id)).toBe(installed);
      expect(internals.workflowsNeedingTerminalCleanup.has(id)).toBe(true);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('keeps a record that still owns one entry after the other is forgotten', async () => {
    const { engine, internals } = await createInternals();
    try {
      seedScheduledRunState(internals, id, { value: { owner: 'the seed' } });

      forgetSeededServices(internals, id);
      expect(internals.scheduledSeedOwners.has(id)).toBe(true);

      forgetSeededCleanupMembership(internals, id);
      expect(internals.scheduledSeedOwners.size).toBe(0);

      // Forgetting what is not recorded is a no-op.
      forgetSeededServices(internals, id);
      forgetSeededCleanupMembership(internals, id);
      expect(internals.scheduledSeedOwners.size).toBe(0);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});

describe('a seed that finds the seeds of an earlier launch', () => {
  it('takes over the seeds of a launch whose start ended before it adopted a checkpoint', async () => {
    const { engine, internals } = await createInternals();
    try {
      // The earlier start rejected before adopting, so nothing rolled its seed back, and its
      // release has not run yet.
      const staleRelease = seedScheduledRunState(internals, id, { value: { owner: 'launch A' } });
      const seededByB = { owner: 'launch B' };

      const currentRelease = seedScheduledRunState(internals, id, { value: seededByB });
      expect(internals.workflowServices.get(id)).toBe(seededByB);
      expect(internals.workflowsNeedingTerminalCleanup.has(id)).toBe(true);

      staleRelease();
      expect(internals.workflowServices.get(id)).toBe(seededByB);
      expect(internals.workflowsNeedingTerminalCleanup.has(id)).toBe(true);

      currentRelease();
      expect(internals.workflowServices.has(id)).toBe(false);
      expect(internals.workflowsNeedingTerminalCleanup.has(id)).toBe(false);
      expect(internals.scheduledSeedOwners.size).toBe(0);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('drops the services of an abandoned seed when the new seed has none', async () => {
    const { engine, internals } = await createInternals();
    try {
      seedScheduledRunState(internals, id, { value: { owner: 'launch A' } });

      const release = seedScheduledRunState(internals, id, null);
      expect(internals.workflowServices.has(id)).toBe(false);
      expect(internals.workflowsNeedingTerminalCleanup.has(id)).toBe(true);

      release();
      expect(internals.workflowsNeedingTerminalCleanup.has(id)).toBe(false);
      expect(internals.scheduledSeedOwners.size).toBe(0);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('leaves the seeds of a start still in flight alone', async () => {
    const { engine, internals } = await createInternals();
    try {
      const seededByA = { owner: 'launch A' };
      const releaseA = seedScheduledRunState(internals, id, { value: seededByA });
      internals.pendingStarts.add(id);

      const releaseB = seedScheduledRunState(internals, id, { value: { owner: 'launch B' } });
      releaseB();
      expect(internals.workflowServices.get(id)).toBe(seededByA);
      expect(internals.workflowsNeedingTerminalCleanup.has(id)).toBe(true);

      releaseA();
      expect(internals.workflowServices.has(id)).toBe(false);
      expect(internals.scheduledSeedOwners.size).toBe(0);
    } finally {
      internals.pendingStarts.delete(id);
      await engine[Symbol.asyncDispose]();
    }
  });

  it('leaves the seeds of a run this engine launched alone', async () => {
    const { engine, internals } = await createInternals();
    try {
      const seededByA = { owner: 'launch A' };
      seedScheduledRunState(internals, id, { value: seededByA });
      beginExecutionAttempt(internals, id, 'the-launched-generation');

      const releaseB = seedScheduledRunState(internals, id, { value: { owner: 'launch B' } });
      releaseB();

      expect(internals.workflowServices.get(id)).toBe(seededByA);
      expect(internals.workflowsNeedingTerminalCleanup.has(id)).toBe(true);
      expect(internals.scheduledSeedOwners.has(id)).toBe(true);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});

describe('the paths that remove a seeded entry forget its owner', () => {
  it('forgets the services owner where cleanupWaiters removes the services', async () => {
    const { engine, internals } = await createInternals();
    try {
      seedScheduledRunState(internals, id, { value: { owner: 'the seed' } });

      cleanupWaiters(internals, id, noCallbacks);

      expect(internals.workflowServices.has(id)).toBe(false);
      expect(internals.scheduledSeedOwners.get(id)?.services).toBeUndefined();
      // The membership is still the seed's: only terminal cleanup removes it.
      expect(internals.workflowsNeedingTerminalCleanup.has(id)).toBe(true);
      expect(internals.scheduledSeedOwners.get(id)?.cleanupMembership).toBeDefined();
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('forgets both owners through terminal cleanup, which also runs cleanupWaiters', async () => {
    const { engine, internals } = await createInternals();
    try {
      seedScheduledRunState(internals, id, { value: { owner: 'the seed' } });

      cleanupTerminalWorkflowMemory(internals, id, noCallbacks);

      expect(internals.workflowServices.has(id)).toBe(false);
      expect(internals.workflowsNeedingTerminalCleanup.has(id)).toBe(false);
      expect(internals.scheduledSeedOwners.size).toBe(0);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('forgets both owners when a terminal run is purged, which retention collection also does', async () => {
    const { engine, internals } = await createInternals();
    try {
      engine.register(
        workflow({ name: 'purged-run' }).execute(async function* (_context: WorkflowContext) {
          return 'done';
        }),
      );
      const handle = await engine.start('purged-run', null, { id });
      await handle.result();
      // A seed that outlived its run's terminal cleanup: here it is put back by hand.
      seedScheduledRunState(internals, id, { value: { owner: 'the seed' } });
      expect(internals.scheduledSeedOwners.has(id)).toBe(true);

      const purged = await engine.purge({ status: 'completed' });
      expect(purged.deleted).toBe(1);

      expect(internals.workflowServices.has(id)).toBe(false);
      expect(internals.scheduledSeedOwners.size).toBe(0);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('clears every record when the engine is disposed', async () => {
    const { engine, internals } = await createInternals();
    seedScheduledRunState(internals, id, { value: { owner: 'the seed' } });
    seedScheduledRunState(internals, 'another-run', null);
    expect(internals.scheduledSeedOwners.size).toBe(2);

    await engine[Symbol.asyncDispose]();

    expect(internals.scheduledSeedOwners.size).toBe(0);
  });
});
