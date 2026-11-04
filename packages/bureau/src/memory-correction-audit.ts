/**
 * COR-2009 — the audit log's "Corrected a memory": one `memory.corrected` record for each correction
 * governed memory makes, whoever made it. A person's correction (`bureau.memory.correct`) and an
 * agent's (a run superseding what it remembered) both supersede the original, and memory's
 * `memory.forgotten` notification for a supersession names the original and its successor, the
 * collection (the agent whose memory it is) and the successor's source. The record carries no
 * memory text: the audit records actions, and the text is the memory's own, read on the Memory page.
 *
 * @module memory-correction-audit
 */

import type { GovernedMemory, MemoryGovernanceNotification } from '@lostgradient/memory';

import { auditTrailAgentOwnerId } from './audit-trail.ts';
import type { DiagnosticSink } from './types.ts';

/** The audit type a correction is recorded under. */
export const MEMORY_CORRECTED_AUDIT_TYPE = 'memory.corrected';

/** One `memory.corrected` record, as the audit trail's out-of-band `record` takes it. */
export interface MemoryCorrectionAuditEntry {
  /** The run that corrected the memory, or `agent:<id>` for a correction made outside a run. */
  readonly runId: string;
  readonly type: typeof MEMORY_CORRECTED_AUDIT_TYPE;
  /** Who acted, as memory attributed it: the run, or the person's owner string. */
  readonly principal?: string;
  readonly detail: {
    /** The agent whose memory was corrected. */
    readonly agentName: string;
    /** The memory the correction wrote. */
    readonly memoryId: string;
    /** The memory it replaced, which stays readable as its history. */
    readonly correctsId: string;
    /** `person` when a person corrected it, `agent` when the agent did. */
    readonly writer: 'person' | 'agent';
    /** The chat the correction was made in, when one was named. */
    readonly sessionId?: string;
  };
  /** When memory recorded the correction. */
  readonly timestampMs: number;
  /** One record per correction, however often the notification is heard. */
  readonly dedupeKey: string;
}

/** The audit entry for `notification`, or `undefined` when it is not a correction. */
export function memoryCorrectionAuditEntry(
  notification: MemoryGovernanceNotification,
): MemoryCorrectionAuditEntry | undefined {
  const { supersession } = notification;
  if (notification.type !== 'memory.forgotten' || supersession === undefined) return undefined;
  const [correctsId, memoryId] = notification.recordIds;
  if (correctsId === undefined || memoryId === undefined) return undefined;
  const sessionId = notification.correlation?.sessionId;
  return {
    runId: notification.correlation?.runId ?? auditTrailAgentOwnerId(supersession.collection),
    type: MEMORY_CORRECTED_AUDIT_TYPE,
    ...(notification.principalId === undefined ? {} : { principal: notification.principalId }),
    detail: {
      agentName: supersession.collection,
      memoryId,
      correctsId,
      writer: supersession.source === 'operator' ? 'person' : 'agent',
      ...(sessionId === undefined ? {} : { sessionId }),
    },
    timestampMs: notification.at,
    dedupeKey: `${MEMORY_CORRECTED_AUDIT_TYPE}:${memoryId}`,
  };
}

/**
 * Records each correction `memory` makes with `record`, from the moment of the call, and returns
 * the unsubscribe. A record that cannot be written is diagnosed, never thrown into memory's call.
 */
export function auditMemoryCorrections(
  memory: Pick<GovernedMemory, 'subscribe'>,
  record: (entry: MemoryCorrectionAuditEntry) => Promise<unknown> | undefined,
  diagnose: DiagnosticSink,
): () => void {
  return memory.subscribe((notification) => {
    const entry = memoryCorrectionAuditEntry(notification);
    if (entry === undefined) return;
    return Promise.resolve(record(entry)).catch((error: unknown) => {
      diagnose({
        level: 'error',
        scope: 'audit-trail',
        message: `[audit-trail] Failed to persist the "memory.corrected" audit record for memory "${entry.detail.memoryId}":`,
        cause: error,
      });
    });
  });
}
