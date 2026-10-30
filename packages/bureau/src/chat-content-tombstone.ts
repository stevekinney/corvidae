/**
 * COR-1934 — the fence a purged run's late writers are refused by.
 *
 * A chat's content is purged once its runs' workflows are terminal, but the process that drove a
 * run writes its last audit entry and durable event asynchronously after that, and in another
 * process nothing awaits them. A write that landed after the purge would bring the answer back.
 * So the purge writes one tombstone per run BEFORE it deletes anything, and every write of a
 * run's content carries {@link notPurgedCondition}: the audit trail then writes the entry with
 * its content redacted (the entry is kept as proof the run happened), and the durable event
 * history drops the event. The condition is in the same compare-and-set as the write, so a
 * tombstone written between a writer's read and its commit still refuses it.
 *
 * A tombstone holds the run id and when it was purged, nothing else. It is kept as long as the
 * audit trail's retention (`retention.audit`): `pruneTombstones` drops those older than the
 * cutoff of the same pass, because an audit entry or event older than that cutoff is pruned
 * anyway. With retention `forever`, tombstones are kept forever, like Weft's own per-run fences
 * (`wf-gen:`, `wf-owner-epoch:`).
 */
import { encodeStorageKeyComponent } from '@lostgradient/storage';

/** The reserved key prefix of the tombstones. */
export const CHAT_CONTENT_TOMBSTONE_PREFIX = 'chat-content-purge-tombstone:v1:';

/** The tombstone key of one run. */
export function runTombstoneKey(runId: string): string {
  return `${CHAT_CONTENT_TOMBSTONE_PREFIX}run:${encodeStorageKeyComponent(runId)}`;
}

/** What a tombstone records. */
export interface ChatContentTombstone {
  readonly runId: string;
  /** Epoch milliseconds the run's content was purged. */
  readonly purgedAt: number;
}

/** The stored text of a tombstone. */
export function tombstoneValue(tombstone: ChatContentTombstone): string {
  return JSON.stringify(tombstone);
}

/** Reads a stored tombstone, or `undefined` for text this module did not write. */
export function parseTombstone(text: string): ChatContentTombstone | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return undefined;
    const { runId, purgedAt } = value as Record<string, unknown>;
    if (typeof runId !== 'string' || typeof purgedAt !== 'number' || !Number.isFinite(purgedAt)) {
      return undefined;
    }
    return { runId, purgedAt };
  } catch {
    return undefined;
  }
}

/**
 * The condition a write of a run's content carries: the run's tombstone is absent. It fails the
 * batch once the run is purged, in the same compare-and-set as the write, so the writer can tell
 * a purged run (the tombstone is there) from an ordinary lost race (it is not).
 */
export function notPurgedCondition(runId: string): { key: string; expectedValue: null } {
  return { key: runTombstoneKey(runId), expectedValue: null };
}

/** The refusal of a write for a run whose content was purged: the write was dropped, by design. */
export class RunContentPurgedError extends Error {
  constructor(readonly runId: string) {
    super(`The content of run "${runId}" was purged with its chat; the write was dropped`);
    this.name = 'RunContentPurgedError';
  }
}
