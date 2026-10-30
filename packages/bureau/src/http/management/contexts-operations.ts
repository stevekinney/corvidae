/**
 * `bureau.contexts.*`: a context is a Bureau session, the same identifier as the
 * A2A `contextId` (`documentation/external-control-plane.md`, "Tasks and contexts").
 *
 * A context belongs to the principal that created it. A caller reaches its own
 * contexts without any scope; `bureau.contexts:read` grants `list` and `get` on any
 * owner's, `bureau.contexts:write` grants `delete` and `rename`, neither implies the other, and a
 * context the caller may not see is answered exactly as a missing one. A task's id is not a context id, so it reads as missing here.
 *
 * @module contexts-operations
 */

import {
  type AgentSession,
  SESSION_ORIGINS,
  type SessionListOptions,
  type SessionSummary,
  sessionOriginOf,
  sessionOwnerOf,
  summarizeSession,
} from '@lostgradient/operative';
import { defineOperation, type OperationFault, type Principal } from '@lostgradient/weft';
import { z } from 'zod';

import {
  aggregateCleanup,
  type ContextActivity,
  type TaskCleanupState,
  type TaskRegistry,
} from '../../task-registry.ts';
import type { Bureau, BureauContexts, BureauInternals } from '../../types.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from '../owner-predicate.ts';
import {
  DEFAULT_PAGE_LIMIT,
  pageFields,
  resourceNotFound,
  taskCleanupSchema,
  unaryTransports as transports,
  unknownKeyPolicy,
  waitMillisecondsField,
} from './management-schemas.ts';
import { holdsScope } from './tasks-operations.ts';

/** What the context operations read from the handler's `host`. */
export type BureauContextsOperationHost = BureauOwnershipHost & {
  readonly contexts: Pick<BureauContexts, 'get' | 'delete' | 'list' | 'steering'> &
    Pick<Bureau, 'lifecycle'> & {
      readonly internals: Pick<BureauInternals, 'sessionStore'>;
    };
  readonly tasks: Pick<TaskRegistry, 'settleCleanup' | 'activityOf'>;
};

/**
 * Whether `principal` may act, with `operatorScope`, on the session it has just loaded.
 * The owner is the loaded session's own, not a second lookup of the id: a context id can
 * be deleted and created again for another owner, so authorization is bound to the exact
 * session the operation then reads or deletes.
 */
function mayAccessLoadedContext(
  host: BureauContextsOperationHost,
  principal: Principal,
  session: AgentSession,
  operatorScope: 'bureau.contexts:write' | 'bureau.contexts:read',
): boolean {
  return host.ownership.mayAccess({
    principal,
    resourceOwner: sessionOwnerOf(session.metadata) ?? undefined,
    operatorScope,
  });
}

const contextsDeleteInput = z.object({
  contextId: z.string().min(1).describe('The identifier of the context to delete.'),
  waitMilliseconds: waitMillisecondsField,
});

/** The receipt `bureau.contexts.delete` answers with. */
export const contextDeleteReceiptSchema = z.enum([
  'applied',
  'rejected',
  'cleanup-pending',
  'cleaned-up',
  'cleanup-failed',
  'cleanup-unresolved',
  'unknown-outcome',
]);

const contextsDeleteOutput = z.object({
  contextId: z.string(),
  receipt: contextDeleteReceiptSchema,
  reason: z.literal('shutting-down').optional(),
  /**
   * Every live task the deletion cancelled, each with where its own cleanup stands. Only the
   * context's owner, or a caller that can read both contexts and tasks, is told which tasks
   * they were: a caller that can only write is told the receipt.
   */
  tasks: z.array(z.object({ taskId: z.string(), cleanup: taskCleanupSchema })).optional(),
});

export const contextsDeleteOperation = defineOperation<
  typeof contextsDeleteInput,
  typeof contextsDeleteOutput,
  BureauContextsOperationHost
>({
  name: 'bureau.contexts.delete',
  mcpExposable: false,
  summary: 'Delete a context',
  description:
    'Deletes one of the caller’s own contexts; a caller holding `bureau.contexts:write` deletes any owner’s. The deletion fences the context first, so a new task or session input for it reads as a context that does not exist, then cancels and awaits every live task in it, then removes the context and empties its tasks’ message histories. The `receipt` is `applied` (no task was live), or the aggregate of the cancelled tasks’ cleanup, the least settled winning: `cleanup-pending`, `cleanup-unresolved`, `unknown-outcome`, `cleanup-failed`, `cleaned-up`; `tasks` lists each. `rejected` (reason `shutting-down`) means admission is closed and nothing was applied. `waitMilliseconds` (default 0) waits that long for outstanding cleanup acknowledgements.',
  destructive: true,
  tags: ['Contexts'],
  inputSchema: contextsDeleteInput,
  outputSchema: contextsDeleteOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { contextId } = input;
    if (host.contexts.internals.sessionStore === undefined) {
      throw {
        code: 'UnsupportedCapability',
        message: 'This Bureau keeps no sessions, so it has no contexts to delete',
        data: { capability: 'session-store' },
      } satisfies OperationFault;
    }
    // Missing, a catalog run's id, and not the caller's all answer alike. The one session
    // loaded here is the one authorized and the one deleted.
    const session = await host.contexts.get(contextId);
    if (
      session === undefined ||
      !mayAccessLoadedContext(host, principal, session, 'bureau.contexts:write')
    ) {
      throw resourceNotFound('context', contextId);
    }
    // Who may be told which tasks were cancelled: the owner, or a caller that can read both.
    const mayNameTasks =
      sessionOwnerOf(session.metadata) === ownerOfPrincipal(principal) ||
      (holdsScope(principal, 'bureau.contexts:read') && holdsScope(principal, 'bureau.tasks:read'));
    const named = (tasks: readonly { taskId: string; cleanup: TaskCleanupState }[]) =>
      mayNameTasks ? { tasks: tasks.map((task) => ({ ...task })) } : {};
    if (host.contexts.lifecycle !== 'ready') {
      return {
        contextId,
        receipt: 'rejected' as const,
        reason: 'shutting-down' as const,
        ...named([]),
      };
    }
    const report = await host.contexts.delete(contextId, {
      incarnation: session.incarnation,
    });
    // The id holds another incarnation now (or none): the context authorized is gone.
    if (!report.deleted) throw resourceNotFound('context', contextId);
    if (report.tasks.length === 0) return { contextId, receipt: 'applied' as const, ...named([]) };
    const cleanups = await host.tasks.settleCleanup(report.tasks, input.waitMilliseconds ?? 0);
    const receipt = aggregateCleanup(cleanups.map((task) => task.cleanup)) ?? 'applied';
    return { contextId, receipt, ...named(cleanups) };
  },
});

const contextActivitySchema = z.enum(['running', 'awaiting-input', 'idle']);

/**
 * What started a context (COR-1645): a person's `chat`, a `goal`, a `schedule`'s fire, or a `try`
 * (COR-1911), a throwaway chat with an agent definition that was never saved. It is read from the
 * context's reserved origin metadata key, which a goal, a fire and a try write when they create
 * the context and a chat never writes, so a context with no origin, as every one made before
 * origins existed, is a `chat`. Nothing outside these four is accepted or shown.
 */
export const contextOriginSchema = z.enum(SESSION_ORIGINS);

/**
 * One context, as the management plane shows it. It is built field by field from a
 * session summary, so Bureau-internal `metadata` (request authorities, skill
 * snapshots) never reaches a client, and it holds no transcript: the only message
 * text is the `title` and the `lastMessagePreview` the summary index records.
 */
export const contextSummarySchema = z.object({
  id: z.string(),
  owner: z.string().nullable(),
  agentName: z.string(),
  title: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
  /** The context this one was branched from (`bureau.contexts.fork`), or `null`. */
  parentContextId: z.string().nullable(),
  /** The message of the parent this one was branched at, or `null`. */
  forkedFromMessageId: z.string().nullable(),
  /** What started the context; a context that records none is a `chat`. */
  origin: contextOriginSchema,
  messageCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  activity: contextActivitySchema,
});

/**
 * One context as `bureau.contexts.get` shows it: the summary, and what its steering has settled on
 * (COR-1559). `model` is the latest admitted `model` override in the context's desired state,
 * `null` before any, which means the agent's default; its `provider` is `null` for an override
 * that named none. `effort` is the latest admitted `effort` override (COR-1935), `null` before any,
 * which means the effort the agent's request carries. `configVersion` is the desired-state version a later command's
 * `expectedRevision` is compared against.
 */
export const contextDetailSchema = contextSummarySchema.extend({
  model: z.object({ provider: z.string().nullable(), model: z.string() }).nullable(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable(),
  configVersion: z.number().int().nonnegative(),
});

function projectContext(
  summary: SessionSummary,
  activity: ContextActivity | undefined,
): z.infer<typeof contextSummarySchema> {
  return {
    id: summary.id,
    owner: summary.owner,
    agentName: summary.agentName,
    title: summary.title,
    lastMessagePreview: summary.lastMessagePreview,
    parentContextId: summary.parentContextId,
    forkedFromMessageId: summary.forkedFromMessageId,
    origin: sessionOriginOf(summary.metadata),
    messageCount: summary.messageCount,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    activity: activity ?? 'idle',
  };
}

/** The fault for a Bureau that keeps no session store, and so no contexts. */
export function noSessions(): OperationFault {
  return {
    code: 'UnsupportedCapability',
    message: 'This Bureau keeps no sessions, so it has no contexts',
    data: { capability: 'session-store' },
  };
}

/** How many contexts an `activity` listing reads and classifies at a time. */
const ACTIVITY_SCAN_CHUNK = 100;

const contextsListInput = z.object({
  agentName: z.string().min(1).optional().describe('Only the contexts of this agent.'),
  titleContains: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Only the contexts whose title contains this text, ignoring case.'),
  activity: contextActivitySchema
    .optional()
    .describe('Only the contexts that are in this activity state right now.'),
  origin: contextOriginSchema
    .optional()
    .describe(
      'Only the contexts with this origin; `chat` includes every context that records none. Contexts of origin `try` are listed only when this is `try`.',
    ),
  allOwners: z
    .boolean()
    .optional()
    .describe('List every owner’s contexts; requires `bureau.contexts:read`.'),
  sortBy: z
    .enum(['updatedAt', 'createdAt'])
    .optional()
    .describe('The time to order by. Defaults to `updatedAt`.'),
  sortOrder: z
    .enum(['asc', 'desc'])
    .optional()
    .describe('The direction to order in. Defaults to `desc`, newest first.'),
  ...pageFields,
});
const contextsListOutput = z.object({
  contexts: z.array(contextSummarySchema),
  nextOffset: z.number().int().nullable(),
});

export const contextsListOperation = defineOperation<
  typeof contextsListInput,
  typeof contextsListOutput,
  BureauContextsOperationHost
>({
  name: 'bureau.contexts.list',
  mcpExposable: true,
  summary: 'List contexts',
  description:
    'Lists the caller’s own contexts (chat sessions) with a title, a last-message preview, a message count, times and `activity` (`running`, `awaiting-input` or `idle`), newest update first by default. Each carries its `origin`: `chat` for a context a person started (and for every context that records no origin), `goal` for a goal’s session, `schedule` for a session a schedule’s fire created, `try` for a throwaway chat with an unsaved agent definition (`bureau.agents.try`), which is left out of the list unless `origin` is `try`. `agentName` filters by agent, `origin` by origin, `titleContains` by a case-insensitive substring of the title (a title given by `bureau.contexts.rename` counts), and `activity` by what the context is doing right now, all before the page is cut, so a page of chats holds chats and `offset` counts matches. An `activity` filter classifies the contexts the other filters leave, a hundred at a time, until the page is full; a context’s activity can change between pages. `allOwners: true` lists every owner’s and requires `bureau.contexts:read`; without it the call is a `Forbidden` fault. Pages with `limit` (1 to 100, default 50) and `offset`; `nextOffset` is `null` on the last page. No transcript and no internal metadata is returned.',
  destructive: false,
  tags: ['Contexts'],
  inputSchema: contextsListInput,
  outputSchema: contextsListOutput,
  producibleFaults: ['InvalidParams', 'Forbidden', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    if (host.contexts.internals.sessionStore === undefined) throw noSessions();
    const everyOwner = input.allOwners === true;
    if (everyOwner && !holdsScope(principal, 'bureau.contexts:read')) {
      throw {
        code: 'Forbidden',
        message: 'Listing every owner’s contexts requires bureau.contexts:read',
        data: { reason: 'missing scope bureau.contexts:read' },
      } satisfies OperationFault;
    }
    const owner = everyOwner ? undefined : ownerOfPrincipal(principal);
    // A principal that can own nothing owns no context.
    if (!everyOwner && owner === undefined) return { contexts: [], nextOffset: null };
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    const offset = input.offset ?? 0;
    const filters = {
      ...(owner === undefined ? {} : { owner }),
      ...(input.agentName === undefined ? {} : { agentName: input.agentName }),
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      ...(input.titleContains === undefined ? {} : { titleContains: input.titleContains }),
      ...(input.sortBy === undefined ? {} : { sortBy: input.sortBy }),
      ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
    };
    if (input.activity !== undefined) {
      return listByActivity(host, filters, input.activity, offset, limit);
    }
    // One row past the page says whether another page follows.
    const rows = await host.contexts.list({ ...filters, limit: limit + 1, offset });
    const page = rows.slice(0, limit);
    // One query answers the whole page.
    const activity = await host.tasks.activityOf(page.map((summary) => summary.id));
    return {
      contexts: page.map((summary) => projectContext(summary, activity.get(summary.id))),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  },
});

/**
 * One page of the contexts `filters` leave that are `wanted`. Activity derives from live tasks, so
 * it is not on the summary index and cannot be filtered there. The filtered index is read once, so
 * the order the page is cut from cannot change under the scan (a session committing meanwhile
 * would otherwise appear in two chunks, or in none), and the store is not re-read for each chunk.
 * That array is classified {@link ACTIVITY_SCAN_CHUNK} at a time, one task query per chunk, and the
 * scan stops as soon as one match past the page proves another page follows. `offset` counts
 * matches.
 */
async function listByActivity(
  host: BureauContextsOperationHost,
  filters: SessionListOptions,
  wanted: ContextActivity,
  offset: number,
  limit: number,
): Promise<z.infer<typeof contextsListOutput>> {
  const candidates = await host.contexts.list({ ...filters, limit: Number.MAX_SAFE_INTEGER });
  const contexts: z.infer<typeof contextSummarySchema>[] = [];
  let skipped = 0;
  for (let start = 0; start < candidates.length; start += ACTIVITY_SCAN_CHUNK) {
    const chunk = candidates.slice(start, start + ACTIVITY_SCAN_CHUNK);
    const activity = await host.tasks.activityOf(chunk.map((summary) => summary.id));
    for (const summary of chunk) {
      if ((activity.get(summary.id) ?? 'idle') !== wanted) continue;
      if (skipped < offset) {
        skipped += 1;
        continue;
      }
      // One match past the page says another page follows.
      if (contexts.length === limit) return { contexts, nextOffset: offset + limit };
      contexts.push(projectContext(summary, wanted));
    }
  }
  return { contexts, nextOffset: null };
}

const contextsGetInput = z.object({
  contextId: z.string().min(1).describe('The identifier of the context to read.'),
});

export const contextsGetOperation = defineOperation<
  typeof contextsGetInput,
  typeof contextDetailSchema,
  BureauContextsOperationHost
>({
  name: 'bureau.contexts.get',
  mcpExposable: true,
  summary: 'Read one context',
  description:
    'Returns the summary of one of the caller’s own contexts, with its `origin`, and what its steering has settled on; a caller holding `bureau.contexts:read` reads any owner’s. `model` is the latest admitted model override (`{ provider, model }`, with a `null` provider when the override named none), or `null` before any, which means the agent’s default; `effort` is the latest admitted effort override (`low`, `medium`, `high`, `xhigh` or `max`), or `null` before any; `configVersion` is the version `bureau.contexts.steer`’s `expectedRevision` is compared against. Another owner’s context answers as a missing one does. The response carries no transcript: its only message text is the title and the last-message preview.',
  destructive: false,
  tags: ['Contexts'],
  inputSchema: contextsGetInput,
  outputSchema: contextDetailSchema,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { contextId } = input;
    if (host.contexts.internals.sessionStore === undefined) throw noSessions();
    const session = await host.contexts.get(contextId);
    if (
      session === undefined ||
      !mayAccessLoadedContext(host, principal, session, 'bureau.contexts:read')
    ) {
      throw resourceNotFound('context', contextId);
    }
    // Bound to the incarnation just authorized, not to whatever now holds the id.
    const activity = await host.tasks.activityOf(
      [contextId],
      new Map([[contextId, session.incarnation]]),
    );
    // A context deleted while its steering was read is as missing as one that never was.
    const steering = await host.contexts.steering(contextId);
    if (steering === undefined) throw resourceNotFound('context', contextId);
    return {
      ...projectContext(summarizeSession(session), activity.get(contextId)),
      model: steering.model === null ? null : { ...steering.model },
      effort: steering.effort,
      configVersion: steering.configVersion,
    };
  },
});
