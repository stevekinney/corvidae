import { currentExecutionAttempt } from './execution-attempts.ts';
import type { EngineInternals } from './internals.ts';

/**
 * The identity of one scheduled launch's seed. A fresh symbol per seed, compared by
 * reference and never reused, so a token that has stopped owning an entry can never own it
 * again.
 */
export type ScheduledSeedToken = symbol;

/**
 * Which seed put each in-memory entry of one workflow id there. A slot is `undefined` when
 * the entry is not a seed's: it was already in memory when the seed ran, another path
 * installed it since, or a launch adopted a checkpoint under the id since.
 */
export type ScheduledSeedOwnership = {
  services: ScheduledSeedToken | undefined;
  cleanupMembership: ScheduledSeedToken | undefined;
};

type OwnershipSlot = keyof ScheduledSeedOwnership;

/**
 * Who owns what a scheduled occurrence seeds before its start (COR-1408).
 *
 * `startScheduledRun` puts an occurrence's services and its terminal-cleanup membership in
 * engine memory ahead of `startWorkflow`, so a run that completes inline still schedules the
 * durable cleanup timer. The id can belong to another launch by the time the start rejects:
 * a start still in flight that reserved it first, a live run, or a launch that began after
 * this one's start rolled itself back. A release that removed what it merely observed would
 * strip that launch of its services and of the obligation to schedule the cleanup.
 *
 * The engine therefore records, per id and per entry, the token of the seed that added it.
 * The returned release removes an entry only while its own token still owns that entry. An
 * entry the id already held belongs to someone else, so the seed claims nothing for it.
 *
 * A start can reject before it adopts a checkpoint (a failed read, say), which rolls nothing
 * back, so its seed stays in memory until the release in `startScheduledRun`'s catch runs. A
 * launch that seeds the same id in that window would find those entries present, claim
 * nothing, and be stripped by the stale release. So a seed first takes over the seeds of a
 * launch that no longer holds the id, meaning no start is in flight for it and this engine
 * holds no execution attempt for it: it removes them and seeds afresh, which leaves the stale
 * release a slot owned by someone else. A start in flight and a run this engine launched keep
 * their seeds.
 *
 * Any launch that adopts a checkpoint under the id takes the id over, the seeding launch
 * included, and `adoptLaunchCheckpoint` forgets both owners at that moment. A scheduled launch
 * that was rejected before it adopted leaves its seed in memory until its release runs, and a
 * live `engine.start` run, a resume, a recovery or a fork can adopt in that window; that run
 * then installs its own services over the seed's, or joins the membership the seed already
 * holds, and the stale release must not remove them. The adoption leaves the entries where they
 * are, since for the seeding launch they are the run's own. A start that fails after adopting
 * is rolled back outright by its `LaunchAdoption`, so no release is needed for it.
 *
 * `scheduledSeedOwners` mirrors the entries it names. Every other path that removes one
 * also forgets its slot, through {@link forgetSeededServices} and
 * {@link forgetSeededCleanupMembership}: the rollback of a start that adopted a checkpoint,
 * terminal cleanup, purge and retention collection (which reach the services through
 * `cleanupWaiters`), and disposal. So no record outlives its entry, and a stale token finds
 * its slot empty or owned by whoever seeded the id since. A record is made by a seed and ends
 * at the first adoption under the id, or sooner when its entry is removed.
 *
 * The seed and the release are synchronous: they add no await to a launch, persist, or
 * termination path.
 */
export function seedScheduledRunState(
  internals: EngineInternals,
  workflowId: string,
  services: { readonly value: unknown } | null,
): () => void {
  const token: ScheduledSeedToken = Symbol(`scheduled-seed:${workflowId}`);
  if (!launchHoldsId(internals, workflowId)) takeOverOrphanedSeeds(internals, workflowId);
  if (services !== null && !internals.workflowServices.has(workflowId)) {
    internals.workflowServices.set(workflowId, services.value);
    claim(internals, workflowId, 'services', token);
  }
  if (!internals.workflowsNeedingTerminalCleanup.has(workflowId)) {
    internals.workflowsNeedingTerminalCleanup.add(workflowId);
    claim(internals, workflowId, 'cleanupMembership', token);
  }

  return () => {
    if (internals.scheduledSeedOwners.get(workflowId)?.services === token) {
      internals.workflowServices.delete(workflowId);
      forget(internals, workflowId, 'services');
    }
    if (internals.scheduledSeedOwners.get(workflowId)?.cleanupMembership === token) {
      internals.workflowsNeedingTerminalCleanup.delete(workflowId);
      forget(internals, workflowId, 'cleanupMembership');
    }
  };
}

/** Forget who seeded the id's services; call wherever the services entry is removed. */
export function forgetSeededServices(internals: EngineInternals, workflowId: string): void {
  forget(internals, workflowId, 'services');
}

/** Forget who seeded the id's terminal-cleanup membership; call wherever it is removed. */
export function forgetSeededCleanupMembership(
  internals: EngineInternals,
  workflowId: string,
): void {
  forget(internals, workflowId, 'cleanupMembership');
}

/** Whether a start is in flight for the id, or this engine holds a run it launched under it. */
function launchHoldsId(internals: EngineInternals, workflowId: string): boolean {
  return (
    internals.pendingStarts.has(workflowId) ||
    currentExecutionAttempt(internals, workflowId) !== undefined
  );
}

/**
 * Remove the entries a launch seeded and then abandoned without adopting a checkpoint. Its
 * own release, still to run, then finds nothing it owns.
 */
function takeOverOrphanedSeeds(internals: EngineInternals, workflowId: string): void {
  if (internals.scheduledSeedOwners.get(workflowId)?.services !== undefined) {
    internals.workflowServices.delete(workflowId);
    forget(internals, workflowId, 'services');
  }
  if (internals.scheduledSeedOwners.get(workflowId)?.cleanupMembership !== undefined) {
    internals.workflowsNeedingTerminalCleanup.delete(workflowId);
    forget(internals, workflowId, 'cleanupMembership');
  }
}

function claim(
  internals: EngineInternals,
  workflowId: string,
  slot: OwnershipSlot,
  token: ScheduledSeedToken,
): void {
  const ownership = internals.scheduledSeedOwners.get(workflowId) ?? {
    services: undefined,
    cleanupMembership: undefined,
  };
  ownership[slot] = token;
  internals.scheduledSeedOwners.set(workflowId, ownership);
}

function forget(internals: EngineInternals, workflowId: string, slot: OwnershipSlot): void {
  const ownership = internals.scheduledSeedOwners.get(workflowId);
  if (ownership === undefined) return;
  ownership[slot] = undefined;
  if (ownership.services === undefined && ownership.cleanupMembership === undefined) {
    internals.scheduledSeedOwners.delete(workflowId);
  }
}
