/**
 * Catalog run recovery (COR-2376 slice R1): the durable recovery record of a catalog-dispatched run
 * (persisting, claiming, loading and deleting it, and fencing a goal attempt's claim), and classifying
 * a recovered run as catalog territory from the record or the boot recovery pass's cache. Built by
 * `buildRuntimeComposition` and reached only through `createRuntimeComposition`; the returned
 * composition and `resolveRunServices` call into it.
 */
import {
  type CatalogRunRecoveryLoad,
  type CatalogRunRecoveryRecord,
  type GoalAttemptClaimFence,
  type GoalAttemptClaimOwner,
  catalogRunRecoveryKey,
  isCatalogRunRecoveryRecord,
} from '../catalog-run-recovery-record';
import type { CompositionCore } from './core';
import { decode, encode } from '@lostgradient/weft';
import { storageConditionalBatch } from '@lostgradient/storage';

/**
 * What catalog run recovery reads from elsewhere in `buildRuntimeComposition`: nothing. The factory
 * still takes `peers`, so every seam factory has the one `(core, peers)` shape the
 * construction-window guard looks for.
 */
export type CatalogRunRecoveryPeers = Record<never, never>;

/**
 * Builds the catalog run recovery of one composition. It reads no peer. Synchronous, and registers
 * nothing.
 */
export function createCatalogRunRecovery(core: CompositionCore, _peers: CatalogRunRecoveryPeers) {
  const { catalogRunRecoveryCache, durableStorage } = core;

  /**
   * AB-240: persist the catalog-run recovery record. Called from
   * `create-bureau.ts`'s `runAgent` durable branch BEFORE `createActiveRun`
   * starts the durable engine, so a crash immediately after start still has,
   * on the next boot, enough to reattach against the catalog agent's own
   * run options — see `resolveRunServices`'s catalog branch below. A no-op
   * when this composition has no durable storage (nothing to reattach
   * across a restart without one, matching the schedule-marker precedent
   * above); the caller only reaches this inside an `if (runtime.durable)`
   * guard, so `durableStorage` is defined whenever it actually matters.
   */
  async function persistCatalogRunRecoveryRecord(
    runId: string,
    record: Omit<CatalogRunRecoveryRecord, 'schemaVersion'>,
  ): Promise<void> {
    if (!durableStorage) return;
    const fullRecord: CatalogRunRecoveryRecord = { schemaVersion: 1, ...record };
    await durableStorage.put(catalogRunRecoveryKey(runId), encode(fullRecord));
  }

  async function claimCatalogRunRecoveryRecord(
    runId: string,
    record: Omit<CatalogRunRecoveryRecord, 'schemaVersion'>,
  ): Promise<boolean> {
    if (!durableStorage) return true;
    const key = catalogRunRecoveryKey(runId);
    const fullRecord: CatalogRunRecoveryRecord = { schemaVersion: 1, ...record };
    return storageConditionalBatch(
      durableStorage,
      [{ key, expectedValue: null }],
      [{ type: 'put', key, value: encode(fullRecord) }],
    );
  }

  async function loadCatalogRunRecoveryRecord(runId: string): Promise<CatalogRunRecoveryLoad> {
    if (!durableStorage) return { status: 'missing' };
    try {
      const value = await durableStorage.get(catalogRunRecoveryKey(runId));
      if (!value) return { status: 'missing' };
      const decoded = decode(value);
      return isCatalogRunRecoveryRecord(decoded)
        ? { status: 'found', record: decoded }
        : { status: 'corrupt' };
    } catch (error) {
      return { status: 'read-error', error };
    }
  }

  async function deleteCatalogRunRecoveryRecord(runId: string): Promise<void> {
    await durableStorage?.delete(catalogRunRecoveryKey(runId));
    catalogRunRecoveryCache.delete(runId);
  }

  /** How many times a tombstone retries against a record that changed under it. */
  const FENCE_WRITE_TRIES = 5;

  async function fenceGoalAttemptRecoveryRecord(
    runId: string,
    owner: GoalAttemptClaimOwner,
    tombstonedAt: string,
  ): Promise<GoalAttemptClaimFence> {
    // No durable storage, nothing to claim: a claim cannot exist to be raced.
    if (!durableStorage) return 'fenced';
    const key = catalogRunRecoveryKey(runId);
    const tombstoned = {
      goalRunId: owner.goalRunId,
      attemptIndex: owner.attemptIndex,
      tombstonedAt,
    };
    for (let attempt = 0; attempt < FENCE_WRITE_TRIES; attempt += 1) {
      const bytes = await durableStorage.get(key);
      if (!bytes) {
        // Nothing claimed yet. The tombstone is the claim, written whole, so a
        // start that reaches its own claim next finds this one and starts nothing.
        // The estimator is the "declared none" selection a valid attempt record
        // must carry; the record is never the source of a run, so nothing reads it.
        const created: CatalogRunRecoveryRecord = {
          schemaVersion: 1,
          agentName: owner.agentName,
          definitionRevision: 0,
          input: '',
          ...(owner.principal === undefined ? {} : { principal: owner.principal }),
          goalAttempt: tombstoned,
          costEstimation: null,
        };
        if (
          await storageConditionalBatch(
            durableStorage,
            [{ key, expectedValue: null }],
            [{ type: 'put', key, value: encode(created) }],
          )
        ) {
          return 'fenced';
        }
        continue;
      }
      const decoded = decode(bytes);
      if (!isCatalogRunRecoveryRecord(decoded)) {
        throw new Error(
          `The recovery record for run "${runId}" exists but is not valid, so its attempt cannot be fenced.`,
        );
      }
      const claimed = decoded.goalAttempt;
      if (
        claimed?.goalRunId !== owner.goalRunId ||
        claimed.attemptIndex !== owner.attemptIndex ||
        decoded.agentName !== owner.agentName ||
        decoded.principal !== owner.principal
      ) {
        return 'foreign';
      }
      if (claimed.tombstonedAt !== undefined) return 'fenced';
      const next: CatalogRunRecoveryRecord = {
        ...decoded,
        goalAttempt: { ...claimed, tombstonedAt },
      };
      if (
        await storageConditionalBatch(
          durableStorage,
          [{ key, expectedValue: bytes }],
          [{ type: 'put', key, value: encode(next) }],
        )
      ) {
        return 'fenced';
      }
    }
    throw new Error(
      `The recovery record for run "${runId}" kept changing while its attempt was being fenced.`,
    );
  }

  /**
   * AB-240: whether `runId` has a persisted catalog-run recovery record —
   * `create-bureau.ts`'s boot-recovery classification uses this to route a
   * catalog-dispatched run to a headless monitor (mirroring a native
   * scheduled fire) instead of the session-ownership classification, which
   * would otherwise treat it as an orphaned run and cancel it (a catalog run
   * deliberately owns no bureau session).
   *
   * True for `'read-error'` as well as `'found'` (review finding): a corrupt
   * record still marks this workflow id as catalog territory. `'missing'`
   * is the only status that means "genuinely not a catalog run" — treating
   * `'read-error'` as `false` would let a merely-corrupt (not absent) record
   * fall through to the session-ownership classification below, which would
   * then cancel the run as an unowned orphan instead of leaving it to the
   * `{ status: 'unavailable', reason: '... unreadable' }` outcome
   * `resolveRunServices`'s catalog branch already produced for it.
   */
  async function isCatalogRecoveredRun(runId: string): Promise<boolean> {
    // AB-241 review finding: consult the cache `resolveRunServices` already
    // populated FIRST — `recoverDurableRuns`'s post-recovery loop calls this
    // for every handle `onRecoveredWorkflow` didn't already register, so a
    // catalog run's classification here must stay consistent with the
    // resolver's own earlier, successful read rather than risk a fresh,
    // independent one transiently disagreeing with it (a `false` from a
    // flaky second read would fall through to session-ownership
    // classification and cancel an already-resolved-and-monitored catalog
    // run as an orphan). See `catalogRunRecoveryCache`'s own doc comment for
    // why entries are NOT evicted here — only `classifyCatalogRecoveredRun`
    // (a second, later consumer of the same cache — see its own doc
    // comment for why entries are retained for the whole recovery pass,
    // never evicted per-read).
    if (catalogRunRecoveryCache.has(runId)) return true;
    const load = await loadCatalogRunRecoveryRecord(runId);
    return load.status !== 'missing' && load.status !== 'corrupt';
  }

  /**
   * AB-241 review finding: `create-bureau.ts`'s `onRecoveredWorkflow` calls
   * this ONCE to both classify a recovered workflow as catalog territory
   * and reseed `runAttribution` — see this function's own doc comment on
   * the `RuntimeComposition` interface for why a single combined read
   * replaces what would otherwise be two independent ones.
   *
   * Fresh review finding: `resolveRunServices`'s catalog branch ALREADY
   * reads and decodes this exact record, earlier, for the same workflow
   * (Weft always resolves a recovered workflow's services before invoking
   * the awaited `onRecoveredWorkflow` hook this function is called from).
   * Rather than issue a THIRD independent storage read here, this consumes
   * `catalogRunRecoveryCache`'s entry from that earlier, already-successful
   * read — a transient failure on a fresh read can no longer diverge from
   * the classification `resolveRunServices` already committed to. Falls
   * back to a fresh read only when the cache holds nothing for `runId`
   * (e.g. a direct caller of this function outside the normal recovery
   * hook ordering, or a test exercising it in isolation).
   *
   * Second fresh review finding: does NOT evict the cache entry after
   * reading it. `recoverDurableRuns`'s own post-recovery loop calls
   * `isCatalogRecoveredRun` for the SAME workflow id, AFTER this function
   * already ran for it (via the awaited `onRecoveredWorkflow` hook, which
   * happens during `recoverAll()`, strictly before the post-recovery loop
   * that iterates its returned handles) — evicting here would have starved
   * that second, later consumer of the exact same already-successful read
   * this function exists to reuse, sending it back to an independent
   * storage read whose transient failure could misclassify an
   * already-resolved-and-monitored catalog run as an orphan. The whole
   * cache is cleared in one call at the end of the boot recovery pass
   * instead — see `clearCatalogRunRecoveryCache`.
   */
  async function classifyCatalogRecoveredRun(runId: string): Promise<{
    isCatalogRun: boolean;
    attribution?: { agentName: string; principal?: string };
  }> {
    const cached = catalogRunRecoveryCache.get(runId);
    if (cached) {
      return {
        isCatalogRun: true,
        attribution: {
          agentName: cached.agentName,
          ...(cached.principal !== undefined ? { principal: cached.principal } : {}),
        },
      };
    }
    const load = await loadCatalogRunRecoveryRecord(runId);
    if (load.status === 'missing' || load.status === 'corrupt') return { isCatalogRun: false };
    if (load.status === 'read-error') return { isCatalogRun: true };
    return {
      isCatalogRun: true,
      attribution: {
        agentName: load.record.agentName,
        ...(load.record.principal !== undefined ? { principal: load.record.principal } : {}),
      },
    };
  }

  /**
   * AB-241 review finding: see `catalogRunRecoveryCache`'s own doc comment.
   */
  function clearCatalogRunRecoveryCache(): void {
    catalogRunRecoveryCache.clear();
  }

  return {
    persistCatalogRunRecoveryRecord,
    claimCatalogRunRecoveryRecord,
    loadCatalogRunRecoveryRecord,
    deleteCatalogRunRecoveryRecord,
    fenceGoalAttemptRecoveryRecord,
    isCatalogRecoveredRun,
    classifyCatalogRecoveredRun,
    clearCatalogRunRecoveryCache,
  };
}
