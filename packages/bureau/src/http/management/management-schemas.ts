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

import { TASK_PERSON_SURFACES } from '../../task-origin.ts';

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

/** Where a task came from. Mirrors `TaskOrigin` (`task-origin.ts`). */
export const taskOriginSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('chat'),
    contextId: z.string(),
    agentName: z.string(),
    principal: z.string(),
  }),
  z.object({
    kind: z.literal('person'),
    principal: z.string(),
    surface: z.enum(TASK_PERSON_SURFACES),
  }),
  z.object({
    kind: z.literal('schedule'),
    scheduleId: z.string(),
    fireId: z.string(),
    manual: z.literal(true).optional(),
  }),
  z.object({ kind: z.literal('api') }),
]);

/** One task, as the management plane shows it. Message text is never part of it. */
export const taskViewSchema = z.object({
  id: z.string(),
  contextId: z.string(),
  agentName: z.string().nullable(),
  owner: z.string(),
  /** The service principal that started the task for its owner (a schedule's fire), or `null`. */
  actor: z.string().nullable(),
  /**
   * How the task's record was written: `schedule-fire` for a schedule's fire, `chat` when it
   * recorded the session incarnation it ran in, and `catalog` otherwise (a task in a Bureau without a session store, which records no
   * incarnation). Only `chat` says
   * `contextId` is a session; a `catalog` task's is its own handle unless the caller named a
   * session. A client that lists other owners' tasks and lists only its own sessions reads this
   * instead of asking the session store.
   */
  kind: z.enum(['chat', 'schedule-fire', 'catalog']),
  /**
   * Where the task came from, recorded when it was admitted (COR-1867), or `null` for a task
   * recorded before origins were kept. `chat`: a person's message in a chat. `person`: a person
   * who started the task directly, from a `surface`. `schedule`: one fire of a schedule, with
   * `manual` set when a person fired it by hand. `api`: a start with no Bureau context to name.
   */
  origin: taskOriginSchema.nullable(),
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
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('The most entries to return in one page, from 1 to 100. Defaults to 50.'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('How many entries to skip before the page starts. Defaults to 0.'),
};

export const DEFAULT_PAGE_LIMIT = 50;

/** The longest a cancel or delete may wait for a cleanup acknowledgement. */
export const MAX_WAIT_MILLISECONDS = 60_000;

export const waitMillisecondsField = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT_MILLISECONDS)
  .optional()
  .describe(
    'How long, in milliseconds, to wait for cleanup acknowledgements before answering, from 0 to 60000. Defaults to 0, which does not wait.',
  );

/** The fault a missing resource, and a resource the caller may not see, both answer with. */
export function resourceNotFound(
  resource:
    | 'task'
    | 'context'
    | 'agent'
    | 'workflow'
    | 'run'
    | 'message'
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
