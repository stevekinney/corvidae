/**
 * Resumable saved file-agent identifier cutover (COR-2428).
 *
 * The agent source and its references do not share one transaction.  The
 * durable intent is therefore the authority for every retry.  Callers supply
 * fenced capture and write adapters for their own stores: a source adapter
 * compares the file hash, schedules compare their revisions, workflows their
 * hashes, and hooks their revisions.
 */

import type { AgentIdRenameRecord, AgentIdRenameStore } from './agent-id-rename-store';

export interface AgentIdRenameAdapter {
  /** Capture every dependent mutation and confirm the source hash before reserving the target. */
  capture(from: string, expectedHash: string): Promise<void>;
  /** Publish the unchanged source bytes to the absent target. Must be idempotent for this intent. */
  publishTarget(record: AgentIdRenameRecord): Promise<void>;
  /** Rewrite schedules, workflows, and hooks using their captured conditional fences. */
  rewriteDependents(record: AgentIdRenameRecord): Promise<void>;
  /** Remove the old source after all references have committed. Must be idempotent for this intent. */
  retireSource(record: AgentIdRenameRecord): Promise<void>;
}

export interface AgentIdRenameExecutor {
  /**
   * Resume or begin the exact source/target request.  A completed request
   * returns its receipt before reading mutable stores.  A conflicting active
   * request is refused by the rename store.
   */
  rename(from: string, to: string, expectedHash: string): Promise<AgentIdRenameRecord>;
}

export function createAgentIdRenameExecutor(
  store: AgentIdRenameStore,
  adapter: AgentIdRenameAdapter,
): AgentIdRenameExecutor {
  return {
    async rename(from, to, expectedHash) {
      const completed = await store.completed(from, to);
      if (completed !== undefined) {
        if (completed.sourceHash !== expectedHash)
          throw new Error(
            `The completed identifier change from "${from}" has another source hash.`,
          );
        return completed;
      }

      await adapter.capture(from, expectedHash);
      let record = await store.reserve({ from, to, sourceHash: expectedHash });
      if (record.phase === 'prepared') {
        await adapter.publishTarget(record);
        record = await store.advance(record, 'target-published');
      }
      if (record.phase === 'target-published') {
        await adapter.rewriteDependents(record);
        record = await store.advance(record, 'cutover');
      }
      await adapter.retireSource(record);
      if (!(await store.complete(record))) {
        const replay = await store.completed(from, to);
        if (replay !== undefined) return replay;
        throw new Error(`The identifier change from "${from}" changed while completing.`);
      }
      return record;
    },
  };
}
