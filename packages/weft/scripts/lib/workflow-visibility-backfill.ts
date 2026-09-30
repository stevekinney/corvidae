/**
 * Library half of `scripts/rebuild-workflow-visibility-indexes.ts`. Lives
 * here so it can be exercised by unit tests against `MemoryStorage`
 * without spawning the CLI executable entrypoint.
 *
 * @module scripts/lib/workflow-visibility-backfill
 */

import { decode, encode } from '../../src/core/codec.ts';
import { decodeWorkflowState } from '../../src/core/engine/validation.ts';
import {
  WORKFLOW_VISIBILITY_INDEX_VERSION,
  WORKFLOW_VISIBILITY_WATERMARK_CACHE_TTL_MS,
  buildWorkflowVisibilityIndexOperations,
  decodeWorkflowVisibilityManifest,
} from '../../src/core/engine/workflow-indexes.ts';
import {
  KEYS,
  storageConditionalBatch,
  tryDecodeStorageKeyComponent,
  type BatchOperation,
  type Storage,
} from '../../src/storage/interface.ts';

const VISIBILITY_INDEX_PREFIXES = [
  'wf-idx-status:',
  'wf-idx-type:',
  'wf-idx-tenant:',
  'wf-idx-created:',
  'wf-idx-updated:',
  'wf-idx-deadline:',
  'wf-idx-manifest:',
];

/**
 * How long a run waits after announcing a change to whether engines must write
 * index rows (the `wf-idx-meta:building` marker going up, or the watermark and
 * marker coming down) before it depends on that change. Engines re-read the
 * decision at most every {@link WORKFLOW_VISIBILITY_WATERMARK_CACHE_TTL_MS}, so
 * twice that window covers the cache age plus the read itself.
 */
export const WORKFLOW_VISIBILITY_BACKFILL_SETTLE_MILLISECONDS =
  2 * WORKFLOW_VISIBILITY_WATERMARK_CACHE_TTL_MS;

export type BackfillReport = {
  processed: number;
  conflicts: number;
  watermarkWritten: boolean;
};

export type DropReport = {
  rowsDeleted: number;
};

/**
 * Test-friendly logger: receives every progress message the CLI would
 * print. Default is a no-op so unit tests stay quiet.
 */
export type BackfillLogger = (message: string) => void;

export type WorkflowVisibilityBackfillOptions = {
  logger?: BackfillLogger;
  checkpointEvery?: number;
  onWatermarkWritten?: () => void;
  /**
   * Milliseconds to wait, after writing the `wf-idx-meta:building` marker, for
   * running engines to notice it and start writing index rows. Defaults to
   * {@link WORKFLOW_VISIBILITY_BACKFILL_SETTLE_MILLISECONDS}; pass `0` only
   * when no engine can be running against the storage.
   */
  settleMilliseconds?: number;
};

async function settle(milliseconds: number, logger: BackfillLogger, reason: string): Promise<void> {
  if (milliseconds <= 0) return;
  logger(`Waiting ${milliseconds}ms for running engines to ${reason}.`);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isTopLevelWorkflowKey(key: string): boolean {
  const idPart = key.slice(3);
  return key.startsWith('wf:') && !idPart.includes(':');
}

async function loadCursor(storage: Storage): Promise<string | undefined> {
  const bytes = await storage.get(KEYS.workflowVisibilityMetaCursor());
  if (!bytes) return undefined;
  try {
    const decoded = decode(bytes);
    return typeof decoded === 'string' ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the workflow visibility indexes for every workflow in `storage`.
 * Refuses to run when the backend does not expose `conditionalBatch` so
 * a racing runtime write cannot leave a workflow below the cursor
 * un-indexed.
 *
 * Returns a {@link BackfillReport}. `watermarkWritten` is `true` only
 * when the full scan completed with no conditional-batch conflicts —
 * any conflicts indicate the engine wrote to a workflow during the
 * pass, in which case the caller should re-run the backfill.
 */
export async function runWorkflowVisibilityBackfill(
  storage: Storage,
  options: WorkflowVisibilityBackfillOptions = {},
): Promise<BackfillReport> {
  const logger = options.logger ?? (() => undefined);
  const checkpointEvery = options.checkpointEvery ?? 500;

  if (storage.conditionalBatch === undefined) {
    throw new Error(
      'Storage backend does not expose conditionalBatch(); backfill requires it to avoid racing the engine.',
    );
  }

  // Announce first. From here on, every engine that re-reads the marker writes
  // index rows with the workflow state, so a workflow created or changed after
  // the cursor passed it is already indexed. The marker goes up BEFORE the
  // watermark comes down so an engine never sees neither. Engines that skipped
  // index writes while the watermark was stale may have left stale or orphaned
  // rows, so a run with no saved cursor rebuilds from empty (readers already
  // take the scan path because the watermark is gone); a resumed run keeps its
  // own rows.
  const resumeCursor = await loadCursor(storage);
  await storage.put(KEYS.workflowVisibilityMetaBuilding(), encode(Date.now()));
  await storage.delete(KEYS.workflowVisibilityMetaVersion());
  await storage.delete(KEYS.workflowVisibilityMetaBuiltAt());
  await settle(
    options.settleMilliseconds ?? WORKFLOW_VISIBILITY_BACKFILL_SETTLE_MILLISECONDS,
    logger,
    'observe the backfill marker and start writing index rows',
  );
  if (resumeCursor === undefined) {
    const cleared = await sweepVisibilityIndexRows(storage, logger, 500);
    logger(`Cleared ${cleared} pre-existing index rows before the rebuild.`);
  }

  const { processed, conflicts } = await backfillWorkflowRows(storage, logger, checkpointEvery);

  if (conflicts > 0) {
    logger(
      `Backfill saw ${conflicts} conditional-batch conflicts. Re-run to process those workflows.`,
    );
    return { processed, conflicts, watermarkWritten: false };
  }

  // Advance the watermark, clear the cursor and lower the building marker
  // atomically. The engine either sees the new index version with no
  // in-progress marker, or it sees neither — never the partial state — and it
  // keeps writing index rows either way because the watermark is now current.
  await storage.batch([
    {
      type: 'put',
      key: KEYS.workflowVisibilityMetaVersion(),
      value: encode(WORKFLOW_VISIBILITY_INDEX_VERSION),
    },
    {
      type: 'put',
      key: KEYS.workflowVisibilityMetaBuiltAt(),
      value: encode(Date.now()),
    },
    { type: 'delete', key: KEYS.workflowVisibilityMetaCursor() },
    { type: 'delete', key: KEYS.workflowVisibilityMetaBuilding() },
  ]);
  options.onWatermarkWritten?.();

  return { processed, conflicts: 0, watermarkWritten: true };
}

async function backfillWorkflowRows(
  storage: Storage,
  logger: BackfillLogger,
  checkpointEvery: number,
): Promise<{ processed: number; conflicts: number }> {
  const startCursor = await loadCursor(storage);
  if (startCursor !== undefined) {
    logger(`Resuming backfill from cursor ${startCursor}`);
  }

  let processed = 0;
  let conflicts = 0;
  const scanOptions = startCursor !== undefined ? { gt: startCursor } : undefined;

  for await (const [key, value] of storage.scan('wf:', scanOptions)) {
    const result = await indexWorkflow(storage, key, value, conflicts === 0);
    if (result === 'skipped') continue;
    if (result === 'conflict') {
      conflicts += 1;
      logger(
        `Conflict on workflow ${tryDecodeStorageKeyComponent(key.slice(3))}; will retry on next pass.`,
      );
      continue;
    }

    processed += 1;
    if (processed % checkpointEvery === 0) {
      logger(
        `Processed ${processed} workflows (last: ${tryDecodeStorageKeyComponent(key.slice(3))})`,
      );
    }
  }

  return { processed, conflicts };
}

/** Keep the resume cursor behind the first conflict so a later pass retries that workflow. */
async function indexWorkflow(
  storage: Storage,
  key: string,
  value: Uint8Array,
  advanceCursor: boolean,
): Promise<'skipped' | 'committed' | 'conflict'> {
  if (!isTopLevelWorkflowKey(key)) return 'skipped';
  const workflowId = tryDecodeStorageKeyComponent(key.slice(3));
  if (workflowId === null) return 'skipped';

  const state = decodeWorkflowState(value);
  const manifestBytes = await storage.get(KEYS.workflowVisibilityManifest(workflowId));
  const currentManifest = decodeWorkflowVisibilityManifest(manifestBytes);
  const { batchOps } = buildWorkflowVisibilityIndexOperations(workflowId, currentManifest, state);
  const operations: BatchOperation[] = [...batchOps];
  if (advanceCursor) {
    operations.push({
      type: 'put',
      key: KEYS.workflowVisibilityMetaCursor(),
      value: encode(key),
    });
  }
  const committed = await storageConditionalBatch(
    storage,
    [{ key, expectedValue: value }],
    operations,
  );
  return committed ? 'committed' : 'conflict';
}

/**
 * Delete every visibility-index row (not the meta keys) and return how many
 * were removed.
 */
async function sweepVisibilityIndexRows(
  storage: Storage,
  logger: BackfillLogger,
  fallbackBatchSize: number,
): Promise<number> {
  let rowsDeleted = 0;
  for (const prefix of VISIBILITY_INDEX_PREFIXES) {
    if (storage.deletePrefix !== undefined) {
      const removed = await storage.deletePrefix(prefix);
      rowsDeleted += removed;
      logger(`Dropped prefix ${prefix} (${removed} rows)`);
      continue;
    }
    const toDelete: BatchOperation[] = [];
    for await (const [key] of storage.scan(prefix)) {
      toDelete.push({ type: 'delete', key });
      if (toDelete.length >= fallbackBatchSize) {
        await storage.batch(toDelete);
        rowsDeleted += toDelete.length;
        toDelete.length = 0;
      }
    }
    if (toDelete.length > 0) {
      await storage.batch(toDelete);
      rowsDeleted += toDelete.length;
    }
  }
  return rowsDeleted;
}

/**
 * Drop every visibility-index row plus the watermark. Order is
 * load-bearing: the watermark and the building marker go first so the
 * engine immediately falls back to the slow path and, once it re-reads them,
 * stops writing index rows; the script waits that out, then the rows
 * themselves are removed, then the cursor is cleared. Reversing this order
 * would leave a window where the engine trusts a watermark for indexes that
 * no longer exist, or writes rows back behind the sweep.
 */
export async function runWorkflowVisibilityDrop(
  storage: Storage,
  options: {
    logger?: BackfillLogger;
    fallbackBatchSize?: number;
    /** See {@link WorkflowVisibilityBackfillOptions.settleMilliseconds}. */
    settleMilliseconds?: number;
  } = {},
): Promise<DropReport> {
  const logger = options.logger ?? (() => undefined);
  const fallbackBatchSize = options.fallbackBatchSize ?? 500;

  await storage.delete(KEYS.workflowVisibilityMetaVersion());
  await storage.delete(KEYS.workflowVisibilityMetaBuiltAt());
  await storage.delete(KEYS.workflowVisibilityMetaBuilding());
  await settle(
    options.settleMilliseconds ?? WORKFLOW_VISIBILITY_BACKFILL_SETTLE_MILLISECONDS,
    logger,
    'observe the drop and stop writing index rows',
  );

  const rowsDeleted = await sweepVisibilityIndexRows(storage, logger, fallbackBatchSize);
  await storage.delete(KEYS.workflowVisibilityMetaCursor());
  return { rowsDeleted };
}
