/**
 * `engine.purge` with the bulk confirmation-token protocol (COR-2521): the preview of what a purge
 * would remove, and the commit that removes exactly those runs. Split from `bulk-operations.ts` and
 * `bulk-operations-purge.ts`, which are at the repository's file-size ceiling.
 *
 * @module core/engine/bulk-operations-purge-commit
 */
import type {
  BulkOperationDryRunResult,
  BulkOperationOptions,
  ListFilter,
  PurgeResult,
} from '../types.ts';
import {
  purgeInternal,
  purgeWorkflowById,
  resolvePurgeWindow,
  shouldPurgeWorkflowState,
  type CleanupWaiters,
} from './bulk-operations-purge.ts';
import {
  buildBulkOperationPreparation,
  normalizeBulkOperationOptions,
  persistFailedBulkAuditEvent,
  resolveBulkOperationConcurrency,
  runBulkWorkflowPool,
  shouldPersistBulkAudit,
  toBulkOperationError,
  validateBulkConfirmation,
  withBulkAuditEvent,
  workflowStateToBulkSnapshot,
  type BulkWorkflowSnapshot,
} from './bulk-operations-shared.ts';
import type { EngineInternals } from './internals.ts';
import { streamWorkflowStates } from './listing.ts';

/**
 * The runs a purge of `filter` would remove right now, in the order it would remove them: terminal,
 * owing no finalizer, past the filter's `offset` and within its `limit`. It reads and writes
 * nothing else, so a preview and the token derived from it describe exactly what a commit with
 * that token deletes (a commit that finds a run changed skips it; see `purgeWorkflowById`).
 */
export async function collectPurgeCandidates(
  internals: EngineInternals,
  filter: ListFilter | undefined,
): Promise<BulkWorkflowSnapshot[]> {
  const { effectiveLimit, manualOffset } = resolvePurgeWindow(filter, undefined);
  const candidates: BulkWorkflowSnapshot[] = [];
  if (effectiveLimit === 0) return candidates;

  let remainingOffset = manualOffset;
  for await (const state of streamWorkflowStates(internals, filter)) {
    if (!(await shouldPurgeWorkflowState(internals, state, false, 0))) continue;
    if (remainingOffset > 0) {
      remainingOffset -= 1;
      continue;
    }
    candidates.push(workflowStateToBulkSnapshot(state));
    if (effectiveLimit !== undefined && candidates.length >= effectiveLimit) break;
  }
  return candidates;
}

/**
 * `engine.purge`: removes the terminal runs that match `filter`. Called with no `options` it
 * removes them at once, as it always has. Called with `options` it follows the bulk
 * confirmation-token protocol of the other bulk operations: `dryRun: true` previews what a purge
 * would remove and writes nothing, and a commit with a `confirmationToken` removes exactly that
 * preview's runs, refusing a token the filter no longer produces.
 */
export async function purge(
  internals: EngineInternals,
  filter: ListFilter | undefined,
  cleanupWaiters: CleanupWaiters,
  options?: BulkOperationOptions,
): Promise<PurgeResult | BulkOperationDryRunResult> {
  if (options === undefined) {
    return purgeInternal(
      internals,
      filter,
      { expiredOnly: false, now: internals.options.getNow() },
      cleanupWaiters,
    );
  }
  return runBulkPurge(internals, filter, cleanupWaiters, options);
}

async function runBulkPurge(
  internals: EngineInternals,
  filter: ListFilter | undefined,
  cleanupWaiters: CleanupWaiters,
  options: BulkOperationOptions,
): Promise<PurgeResult | BulkOperationDryRunResult> {
  options = normalizeBulkOperationOptions(options);
  const candidates = await collectPurgeCandidates(internals, filter);
  // An empty filter purges every terminal run, which no other bulk operation allows; the token
  // is what stands between that and a purge nobody previewed.
  const preparation = buildBulkOperationPreparation('purge', filter ?? {}, {}, candidates, options);
  if (options.dryRun === true) return preparation.preview;

  validateBulkConfirmation(options, preparation);
  const results = await runBulkWorkflowPool(
    preparation.workflowIds,
    resolveBulkOperationConcurrency(options),
    // `false` is a run that moved after the preview (replaced by a `start-new`, reactivated, or
    // purged by someone else, or one that now owes a finalizer): skipped, never deleted.
    (workflowId) => purgeWorkflowById(internals, workflowId, cleanupWaiters),
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  const deleted = results.filter((result) => result.status === 'fulfilled' && result.value).length;
  if (failures.length > 0) {
    const failedWorkflows = failures.length;
    // The deletes that did commit are irreversible, so the record of them is written before the
    // failure is surfaced, with the failure on it. A record that cannot be written joins the
    // failures, so the caller still learns what failed.
    if (shouldPersistBulkAudit(options)) {
      try {
        await persistFailedBulkAuditEvent(
          internals,
          preparation,
          options,
          deleted,
          results.flatMap((result) =>
            result.status === 'rejected'
              ? [toBulkOperationError(internals, result.item, result.reason)]
              : [],
          ),
        );
      } catch (auditFailure) {
        failures.push(auditFailure);
      }
    }
    throw new AggregateError(
      failures,
      `Purge failed for ${failedWorkflows} workflow(s) after deleting ${deleted} workflow(s)`,
    );
  }

  const result: PurgeResult = { deleted };
  if (!shouldPersistBulkAudit(options)) return result;
  return withBulkAuditEvent(internals, preparation, options, result, deleted);
}
