/**
 * `bureau.contexts.*`: a context is a Bureau session, the same identifier as the
 * A2A `contextId` (`documentation/external-control-plane.md`, "Tasks and contexts").
 *
 * A context belongs to the principal that created it. A caller reaches its own
 * contexts without any scope; `bureau.contexts:read` grants `list` and `get` on any
 * owner's, `bureau.contexts:write` grants `delete`, neither implies the other, and a
 * context the caller may not see is answered exactly as a missing one. A context that is the id of a `bureau.run` dispatch with no session behind
 * it is missing here: a catalog run owns no session.
 *
 * @module contexts-operations
 */

import {
  type AgentSession,
  SESSION_ORIGINS,
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
import type { Bureau } from '../../types.ts';
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
  readonly contexts: Pick<
    Bureau,
    | 'getSession'
    | 'deleteSession'
    | 'getOwner'
    | 'lifecycle'
    | 'listSessions'
    | 'getSessionSteering'
  > & {
    readonly sessionStore: Bureau['sessionStore'];
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
  contextId: z.string().min(1),
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
    if (host.contexts.sessionStore === undefined) {
      throw {
        code: 'UnsupportedCapability',
        message: 'This Bureau keeps no sessions, so it has no contexts to delete',
        data: { capability: 'session-store' },
      } satisfies OperationFault;
    }
    // Missing, a catalog run's id, and not the caller's all answer alike. The one session
    // loaded here is the one authorized and the one deleted.
    const session = await host.contexts.getSession(contextId);
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
    const report = await host.contexts.deleteSession(contextId, {
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
 * What started a context (COR-1645): a person's `chat`, a `goal`, or a `schedule`'s fire. It is
 * read from the context's reserved origin metadata key, which a goal and a fire write when they
 * create the context and a chat never writes, so a context with no origin, as every one made before
 * origins existed, is a `chat`. Nothing outside these three is accepted or shown.
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
 * that named none. `configVersion` is the desired-state version a later command's
 * `expectedRevision` is compared against.
 */
export const contextDetailSchema = contextSummarySchema.extend({
  model: z.object({ provider: z.string().nullable(), model: z.string() }).nullable(),
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

function noSessions(): OperationFault {
  return {
    code: 'UnsupportedCapability',
    message: 'This Bureau keeps no sessions, so it has no contexts',
    data: { capability: 'session-store' },
  };
}

const contextsListInput = z.object({
  agentName: z.string().min(1).optional(),
  /** Only the contexts with this origin; `chat` includes every context that records none. */
  origin: contextOriginSchema.optional(),
  /** List every owner’s contexts; requires `bureau.contexts:read`. */
  allOwners: z.boolean().optional(),
  sortBy: z.enum(['updatedAt', 'createdAt']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
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
    'Lists the caller’s own contexts (chat sessions) with a title, a last-message preview, a message count, times and `activity` (`running`, `awaiting-input` or `idle`), newest update first by default. Each carries its `origin`: `chat` for a context a person started (and for every context that records no origin), `goal` for a goal’s session, `schedule` for a session a schedule’s fire created. `agentName` filters by agent and `origin` by origin, before the page is cut, so a page of chats holds chats. `allOwners: true` lists every owner’s and requires `bureau.contexts:read`; without it the call is a `Forbidden` fault. Pages with `limit` (1 to 100, default 50) and `offset`; `nextOffset` is `null` on the last page. No transcript and no internal metadata is returned.',
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
    if (host.contexts.sessionStore === undefined) throw noSessions();
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
    // One row past the page says whether another page follows.
    const rows = await host.contexts.listSessions({
      ...(owner === undefined ? {} : { owner }),
      ...(input.agentName === undefined ? {} : { agentName: input.agentName }),
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      ...(input.sortBy === undefined ? {} : { sortBy: input.sortBy }),
      ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
      limit: limit + 1,
      offset,
    });
    const page = rows.slice(0, limit);
    // One query answers the whole page.
    const activity = await host.tasks.activityOf(page.map((summary) => summary.id));
    return {
      contexts: page.map((summary) => projectContext(summary, activity.get(summary.id))),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  },
});

const contextsGetInput = z.object({ contextId: z.string().min(1) });

export const contextsGetOperation = defineOperation<
  typeof contextsGetInput,
  typeof contextDetailSchema,
  BureauContextsOperationHost
>({
  name: 'bureau.contexts.get',
  mcpExposable: true,
  summary: 'Read one context',
  description:
    'Returns the summary of one of the caller’s own contexts, with its `origin`, and what its steering has settled on; a caller holding `bureau.contexts:read` reads any owner’s. `model` is the latest admitted model override (`{ provider, model }`, with a `null` provider when the override named none), or `null` before any, which means the agent’s default; `configVersion` is the version `bureau.contexts.steer`’s `expectedRevision` is compared against. Another owner’s context answers as a missing one does. The response carries no transcript: its only message text is the title and the last-message preview.',
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
    if (host.contexts.sessionStore === undefined) throw noSessions();
    const session = await host.contexts.getSession(contextId);
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
    const steering = await host.contexts.getSessionSteering(contextId);
    if (steering === undefined) throw resourceNotFound('context', contextId);
    return {
      ...projectContext(summarizeSession(session), activity.get(contextId)),
      model: steering.model === null ? null : { ...steering.model },
      configVersion: steering.configVersion,
    };
  },
});
