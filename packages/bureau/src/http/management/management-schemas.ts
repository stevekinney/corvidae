/**
 * The wire schemas the management operations share, and the conventions they all
 * follow (`documentation/external-control-plane.md`, "Management operations").
 *
 * Every management operation is declared `authenticated`, with the owner predicate
 * applied inside `invoke` through the handler's host (`owner-predicate.ts`), so a
 * denial is decided in one place and writes no audit entry. A caller who may not
 * see a resource is answered with the same fault as for one that does not exist.
 *
 * @module management-schemas
 */

import type { OperationFault } from '@lostgradient/weft';
import { z } from 'zod';

/** Unary management operations are served over JSON-RPC HTTP only. */
export const unaryTransports = {
  http: false,
  jsonRpcHttp: true,
  jsonRpcWebSocket: false,
  jsonRpcStdio: false,
} as const;

/** A payload key that is not declared is `InvalidParams`, so a client cannot name a `principal`. */
export const unknownKeyPolicy = { http: 'reject', jsonRpc: 'reject' } as const;

/** A task's state. `rejected` and `auth-required` cannot arise in v1 and are left out. */
export const taskStateSchema = z.enum([
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
]);

/** Where a task's cancellation and cleanup stand. */
export const taskCleanupSchema = z.enum([
  'cancel-requested',
  'canceled',
  'cleanup-pending',
  'cleaned-up',
  'cleanup-failed',
  'cleanup-unresolved',
  'unknown-outcome',
]);

/** One task, as the management plane shows it. Message text is never part of it. */
export const taskViewSchema = z.object({
  id: z.string(),
  contextId: z.string(),
  agentName: z.string().nullable(),
  owner: z.string(),
  /** The service principal that started the task for its owner (a schedule's fire), or `null`. */
  actor: z.string().nullable(),
  status: taskStateSchema,
  finishReason: z.string().nullable(),
  statusMessage: z.string().max(1000).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  cleanup: taskCleanupSchema.nullable(),
  /** Open waits by identifier only; prompts and tool arguments stay with `bureau.reviews.*`. */
  openWaits: z.array(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('human-wait'), reviewId: z.string(), signalName: z.string() }),
      z.object({ kind: z.literal('tool-approval'), reviewId: z.string(), callId: z.string() }),
    ]),
  ),
});

/** The paging fields the list operations share. */
export const pageFields = {
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
};

export const DEFAULT_PAGE_LIMIT = 50;

/** The longest a cancel or delete may wait for a cleanup acknowledgement. */
export const MAX_WAIT_MILLISECONDS = 60_000;

export const waitMillisecondsField = z.number().int().min(0).max(MAX_WAIT_MILLISECONDS).optional();

/** The fault a missing resource, and a resource the caller may not see, both answer with. */
export function resourceNotFound(
  resource:
    | 'task'
    | 'context'
    | 'agent'
    | 'workflow'
    | 'run'
    | 'schedule'
    | 'goal'
    | 'asset'
    | 'upload'
    | 'memory',
  identifier: string,
): OperationFault {
  return {
    code: 'NotFound',
    message: `No ${resource} with id "${identifier}"`,
    data: { resource, identifier },
  };
}
