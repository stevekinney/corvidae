import type { EngineInternals } from './internals.ts';

/**
 * The identity of one scheduled launch's seed. A fresh symbol per seed, compared by
 * reference and never reused, so a token that has stopped owning an entry can never own it
 * again.
 */
export type ScheduledSeedToken = symbol;

/**
 * Which seed put each in-memory entry of one workflow id there. A slot is `undefined` when
 * the entry is not a seed's: it was already in memory when the seed ran, or another path
 * installed it since.
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
 * `scheduledSeedOwners` mirrors the entries it names. Every other path that removes one
 * also forgets its slot, through {@link forgetSeededServices} and
 * {@link forgetSeededCleanupMembership}: the rollback of a start that adopted a checkpoint,
 * terminal cleanup, purge and retention collection (which reach the services through
 * `cleanupWaiters`), and disposal. So no record outlives its entry, and a stale token finds
 * its slot empty or owned by whoever seeded the id since.
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
