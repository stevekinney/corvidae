/**
 * The AG-UI mount of `createBureauHandler`: Agent Bureau runs, served as AG-UI 1.0
 * Server-Sent Events.
 *
 * A thread is a Bureau session. The mount serves four routes under one prefix
 * (`/ag-ui` unless `agUi.pathPrefix` says otherwise); `<p>` is the prefix:
 *
 * | Route                           | Body            | Answer | On a process that does not hold the run |
 * | ------------------------------- | --------------- | ------ | --------------------------------------- |
 * | `POST <p>/agents/<name>/run`    | `RunAgentInput` | An event stream. `resume` absent or empty starts a run; `resume` present resumes one. | A start is admitted or refused `THREAD_BUSY` from durable state alone, the same in every process. A resume of a human wait another process holds is delivered through `reviews.resolve` (fenced by the review's decision record), and its stream is the peer stream: the snapshot (holding the answer), the run's status, then the run's next interrupt or its outcome. |
 * | `GET <p>/threads/<threadId>/run`| none            | A stream attached to the thread's most recent root run, while it is live, parked on a human wait, or settled with a tool approval pending. Otherwise a one-event `RUN_NOT_FOUND` stream. | The thread's run is the session's `lastRunId`, attachable while the session says `running` and its durable run is unsettled, or while the session holds an unexpired approval for it. The peer stream (`ag-ui-peer-stream.ts`): `RUN_STARTED`, `MESSAGES_SNAPSHOT`, a `STATE_SNAPSHOT` with the durable run's status, then the run's outcome after a second `MESSAGES_SNAPSHOT`, or its interrupt. No step, tool, or text-delta event. |
 * | `GET <p>/runs/<runId>`          | none            | The same, for that run by native id, or a child run's stream by its own id. | The same, for a run whose durable record exists and whose session (from the durable run's input) says it is attachable. Its owner of record is the one the session recorded for it. |
 * | `GET <p>/threads/<threadId>/messages` | none      | JSON `{ threadId, messages }`: the thread's conversation as AG-UI messages, whether or not a run is going. A thread the caller may not read is a `NotFound` fault, as a missing one is. | The same: it reads only the session. |
 * | `POST <p>/runs/<runId>/cancel`  | none            | JSON `{ runId, status }`; a `NotFound` fault otherwise. | The cancellation goes through `tasks.cancel`, committed to the durable run, which publishes `aborted` to the session once: `aborting` when it commits, the settled run's own `completed`, `aborted` or `error` when it had already ended, and `NotFound` for a run with no durable record. |
 *
 * Every route is authenticated by the handler before the mount sees it, and
 * decides with the owner predicate every catalog operation decides with
 * (`owner-predicate.ts`): the owner of the resource, or the kind's operator
 * scope. `bureau.tasks:read` lets another principal attach. `bureau.tasks:write`
 * lets it cancel a run and answer a human-input wait, and no more (the answer is
 * acknowledged with `RUN_STARTED` and `RUN_FINISHED` alone, never the thread or the
 * run's output, which only an attach reads): only the
 * thread's owner starts a run on an existing thread (a cross-owner start is
 * `THREAD_NOT_FOUND`), and only the owner answers a tool approval (a resume that
 * includes one is `INTERRUPT_NOT_FOUND`, before anything is resolved), because
 * approving a call authorizes a tool to run as the owner. A caller the predicate
 * refuses is answered exactly as a missing resource is, so an identifier grants
 * nothing.
 *
 * A thread is authorized from the owner its own session names, and every later read of the thread
 * or of a run answers only for that owner (`ag-ui-session-owner.ts`): a thread deleted and created
 * again by another owner between two reads is a missing one, never that owner's conversation.
 *
 * Starting is one decision per thread: whether the thread is busy and the creation
 * of the run that makes it busy cannot be separated, or two starts would both be
 * admitted. Bureau's default ownership posture lets several processes share one
 * store, so the decision is taken under a durable lease on the thread
 * (`ag-ui-lease.ts`, written by compare-and-swap in the Bureau's store with a
 * claimant and an expiry on the injected clock): a start in any process that finds
 * it held answers `THREAD_BUSY`, and the lease of a process that died expires and
 * is taken over by one claimant. A resume's command is fenced the same way
 * (`ag-ui-resume.ts`). A tool that outlives its lease is a residual a lease cannot
 * fence: inside one process Armorer's single-use approval binding stops it running
 * twice; across processes only the ledger's compare-and-swap and the idempotent
 * run-creation request id hold (one entry, one run), and the tool itself can run twice.
 *
 * A tool approval is offered once its run has settled; until then only a human
 * wait is, because a run that is still going has not stored the conversation an
 * approval's outcome is written into.
 *
 * A refusal at the door on a streaming route is a one-event stream, HTTP 200,
 * `RUN_ERROR` with a code from the closed set in `ag-ui-vocabulary.ts`, because a
 * client that reads events turns a non-2xx response into a thrown error instead.
 * Transport problems stay status codes: 400 for a body that is not a
 * `RunAgentInput`, 406 for a missing `text/event-stream` accept.
 *
 * Agents served over this mount should be configured with
 * `stopWhen: pendingApproval()`: without it a run keeps generating past a gated
 * tool call and the interrupt reaches the client steps later.
 *
 * @module ag-ui-mount
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import type { AgentSession } from '@lostgradient/operative';
import { type RunAgentInput } from '@ag-ui/core';
import { RunAgentInputSchema } from '@ag-ui/core/schemas';
import type { OperationHandlerMount } from '@lostgradient/weft';
import { createConversationHistory } from 'conversationalist';

import { AssetNotFoundError } from '../assets/errors.ts';
import { BureauLedgerConflictError } from '../command-ledger.ts';
import { BureauError, isDurableRunUnsettled } from '../create-bureau.ts';
import type { Bureau, BureauReviews, BureauInternals, BureauTasks } from '../types.ts';
import type { TaskState } from '../task-registry.ts';
import { managedAssetIdsOf, rowsAddedBy, snapshotMessages } from './ag-ui-messages.ts';
import { createAgUiLeases, releaseQuietly } from './ag-ui-lease.ts';
import { settledOutcomeOf } from './ag-ui-peer-stream.ts';
import { createResume } from './ag-ui-resume.ts';
import { type OwnedSession, ownedSession, runIsOwnedBy } from './ag-ui-session-owner.ts';
import { singleEventResponse } from './ag-ui-sink.ts';
import {
  type AgUiStreamBureau,
  type AgUiStreamEnvironment,
  errorEvent,
  openRunStream,
} from './ag-ui-stream.ts';
import type { AgUiErrorCode } from './ag-ui-vocabulary.ts';
import { type AgUiA2uiDeclaration, a2uiDeclarationOf } from './ag-ui-surface-source.ts';
import { ownerOfPrincipal, type OwnerAccessPredicate } from './owner-predicate.ts';
import { createAgUiLiveFeedRegistry } from './ag-ui-live-feed.ts';

/** `createBureauHandler`'s `agUi` option. Omitted, nothing is mounted. */
export type AgUiOptions = {
  /** The path prefix the four routes sit under. Defaults to `/ag-ui`. */
  readonly pathPrefix?: string;
  /**
   * Each stream ends this many milliseconds after it opens, with a `RUN_ERROR`
   * `STREAM_DEADLINE`; the client attaches again. This mount's own: it is set
   * separately from the catalog subscriptions' deadline, which defaults to the
   * same fifteen minutes. Defaults to 900000.
   */
  readonly maxStreamDurationMs?: number;
  /**
   * How many unread live events a stream holds before it is closed with a
   * `RUN_ERROR` `STREAM_OVERFLOW`; the client attaches again and its snapshot
   * restores what it missed. A dropped text delta would silently corrupt a
   * transcript rebuilt from deltas, so a slow stream is closed, never thinned.
   * Defaults to 1000.
   */
  readonly liveBufferSize?: number;
  /**
   * How often a quiet stream writes an SSE comment so a proxy or `Bun.serve`'s idle
   * timeout (ten seconds by default) does not close it. Defaults to 5000.
   */
  readonly keepAliveIntervalMs?: number;
  /**
   * How long a thread-admission or resume lease holds without a renewal. A
   * process that dies holding one is waited for this long and no longer. Defaults
   * to 30000.
   */
  readonly leaseDurationMs?: number;
  /**
   * The clock and timers the mount reads, so a test drives the stream deadline
   * with a manual clock. Defaults to the real ones.
   */
  readonly runtime?: Pick<RuntimeServices, 'clock' | 'timers' | 'identifiers'>;
};

export const DEFAULT_AG_UI_PATH_PREFIX = '/ag-ui';
export const DEFAULT_AG_UI_MAX_STREAM_DURATION_MS = 900_000;
export const DEFAULT_AG_UI_LIVE_BUFFER_SIZE = 1000;
export const DEFAULT_AG_UI_KEEP_ALIVE_INTERVAL_MS = 5000;
const PROTOCOL_VERSION = '1.0';
/** The task states a task ends in. */
const SETTLED_TASK_STATES: ReadonlySet<TaskState> = new Set(['completed', 'failed', 'canceled']);

/** What the mount reads from the Bureau. */
export type AgUiBureau = Pick<Bureau, 'addEventListener' | 'removeEventListener'> &
  AgUiStreamBureau &
  Pick<Bureau, 'assets'> & {
    readonly tasks: Pick<
      BureauTasks,
      'cancel' | 'detail' | 'get' | 'receipt' | 'start' | 'workflow'
    >;
  } & { readonly reviews: Pick<BureauReviews, 'get' | 'resolve'> } & {
    readonly internals: Pick<BureauInternals, 'hasDurableEngine' | 'kv'>;
  };

/**
 * The owner predicate the mount decides with, and where an owner of record comes from. A session's
 * owner is not looked up apart: the mount decides from the owner of the session it then uses
 * (`ag-ui-session-owner.ts`), so the lookup takes only the records that are not read in hand.
 */
export type AgUiAuthorization = {
  readonly mayAccess: OwnerAccessPredicate;
  readonly ownerOf: (resource: {
    readonly kind: 'run' | 'review';
    readonly id: string;
  }) => Promise<string | undefined>;
};

type Principal = Parameters<OwnerAccessPredicate>[0]['principal'];

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

function notFound(resource: string, identifier: string): Response {
  return json(
    {
      code: 'NotFound',
      message: `No ${resource} with id "${identifier}"`,
      data: { resource, identifier },
    },
    404,
  );
}

/** Whether the session's own owner of record is `owner`. An unreadable owner is nobody's. */
function ownsSession(session: AgentSession, owner: string): boolean {
  return ownedSession(session)?.owner === owner;
}

function acceptsEventStream(accept: string | null): boolean {
  if (accept === null) return false;
  return accept.split(',').some((entry) => {
    const mediaType = entry.split(';', 1)[0]?.trim().toLowerCase();
    return mediaType === 'text/event-stream' || mediaType === 'text/*' || mediaType === '*/*';
  });
}

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

export function createAgUiMount(
  bureau: AgUiBureau,
  authorization: AgUiAuthorization,
  /**
   * Whether `principal` may start a new run of `agentName`: the agent exists and the caller may
   * name it (COR-1904). Resuming a run does not ask.
   */
  startable: { readonly includes: (agentName: string, principal: Principal) => boolean },
  options: AgUiOptions,
): OperationHandlerMount {
  const pathPrefix = (options.pathPrefix ?? DEFAULT_AG_UI_PATH_PREFIX).replace(/\/+$/, '');
  const runtime = options.runtime ?? createDefaultRuntimeServices();
  const liveFeeds = createAgUiLiveFeedRegistry(
    (listener) => bureau.frames(listener),
    options.liveBufferSize ?? DEFAULT_AG_UI_LIVE_BUFFER_SIZE,
    async (runId, sessionId) => {
      if (sessionId === undefined) return undefined;
      await bureau.internals.whenTaskRecorded(runId);
      const session = await bureau.contexts.get(sessionId);
      return session === undefined ? undefined : new Set(session.conversationHistory.ids);
    },
  );
  const removed = (event: { runId: string }): void => liveFeeds.remove(event.runId);
  bureau.addEventListener('run.removed', removed);
  bureau.addEventListener(
    'bureau.disposed',
    () => {
      liveFeeds.dispose();
      bureau.removeEventListener('run.removed', removed);
    },
    { once: true },
  );
  const environment: AgUiStreamEnvironment = {
    bureau,
    runtime,
    maxStreamDurationMs: options.maxStreamDurationMs ?? DEFAULT_AG_UI_MAX_STREAM_DURATION_MS,
    liveBufferSize: options.liveBufferSize ?? DEFAULT_AG_UI_LIVE_BUFFER_SIZE,
    keepAliveMs: options.keepAliveIntervalMs ?? DEFAULT_AG_UI_KEEP_ALIVE_INTERVAL_MS,
    liveFeeds,
  };
  const now = (): number => runtime.clock.now();
  let resumeRun: ReturnType<typeof createResume> | undefined;

  /** A door refusal: a one-event stream. */
  function refuse(code: AgUiErrorCode, message: string): Response {
    return singleEventResponse(errorEvent(code, message, { now }));
  }

  function may(
    principal: Principal,
    resourceOwner: string | undefined,
    operatorScope: 'bureau.tasks:read' | 'bureau.tasks:write',
  ): boolean {
    return authorization.mayAccess({ principal, resourceOwner, operatorScope });
  }

  const leases = createAgUiLeases({
    kv: bureau.internals.kv!,
    runtime,
    leaseMs: options.leaseDurationMs,
  });

  /**
   * The thread's session, with the owner it names itself, when `principal` may use it with
   * `operatorScope`. The caller then serves this very session: no later read decides who owns it.
   */
  async function authorizeThread(
    threadId: string,
    principal: Principal,
    operatorScope: 'bureau.tasks:read' | 'bureau.tasks:write',
  ): Promise<OwnedSession | undefined> {
    const loaded = ownedSession(await bureau.contexts.get(threadId));
    return loaded !== undefined && may(principal, loaded.owner, operatorScope) ? loaded : undefined;
  }

  /**
   * The thread's most recent root run when it is one a client can attach to. A run created under
   * another owner's name is not the thread's run, whatever session id it carries.
   */
  async function attachableRunOfThread(
    threadId: string,
    authorized: OwnedSession,
  ): Promise<string | undefined> {
    // A session runs one task at a time, and starting it records it as the session's last run.
    const lastRunId = authorized.session.metadata['lastRunId'];
    if (typeof lastRunId !== 'string') return undefined;
    const held = bureau.tasks.detail(lastRunId);
    if (
      held !== undefined &&
      held.sessionId === threadId &&
      (held.status === 'running' || held.status === 'aborting') &&
      runIsOwnedBy(held, authorized.owner)
    ) {
      return lastRunId;
    }
    const pending = bureau.reviews
      .list()
      .some((review) => review.runId === lastRunId && review.kind === 'tool-approval');
    if (pending || bureau.tasks.detail(lastRunId) !== undefined)
      return pending ? lastRunId : undefined;
    // A run another process holds, or settled with an approval no process restored: the
    // session's durable record says whether it is one to attach to. A run this process holds is
    // decided by what it holds.
    return (await attachableFromRecord(authorized.session, lastRunId)) ? lastRunId : undefined;
  }

  /**
   * Whether `runId` is attachable by durable state alone, so a process that does not hold it
   * answers as the one that does: the session's last run is this one, the session says `running`,
   * and its durable run is unsettled; or the session holds an unexpired approval for it, by the
   * rule {@link threadBusy} decides with. A read that fails is not attachable.
   */
  async function attachableFromRecord(session: AgentSession, runId: string): Promise<boolean> {
    try {
      const metadata = session.metadata;
      if (metadata['lastRunId'] === runId && metadata['lastRunStatus'] === 'running') {
        const durable = await bureau.tasks.workflow(runId);
        if (durable !== undefined && durable !== null && isDurableRunUnsettled(durable.status)) {
          return true;
        }
      }
      return holdsPendingApproval(metadata, runId, runtime.clock.now());
    } catch {
      return false;
    }
  }

  /**
   * Whether the thread has an unsettled run, decided from durable state alone, so it
   * is the same answer in every process and in every state. Process-local state (the
   * runs and reviews this process holds) may choose what an attach streams, but it
   * never decides this: a start in another process cannot see it.
   *
   * The thread is busy when the session's last run is unsettled:
   *
   * - live, starting, or parked on a human wait: the session says `running` and the
   *   durable run is in Bureau's own non-terminal set (pending, running, suspended;
   *   `pending` is a run whose inline launch has not flushed yet). A marker whose
   *   durable run has settled, as a crash can leave, is not busy; a read that fails
   *   is, because a start admitted on a guess forks the thread;
   * - settled with an unresolved approval: the session still holds a
   *   `pendingApprovalOverrides` entry for that run. Bureau persists the entry when an
   *   approval is gated and removes it in the same write as the resolution, whichever
   *   process resolves it and however (this mount, `bureau.reviews.resolve`, after a
   *   restart); an entry whose binding has expired is not pending, by the rule
   *   `reviews.list` uses, so an unanswerable approval cannot hold a thread.
   *   (`lastRequestAuthorities` is not cleared when the resolving process does not
   *   hold the run, and the conversation's `action_required` row is not rewritten by
   *   an expiry, so neither can stand for this.)
   */
  async function threadBusy(session: AgentSession | undefined): Promise<boolean> {
    try {
      const metadata = session?.metadata;
      const lastRunId = metadata?.['lastRunId'];
      if (metadata === undefined || typeof lastRunId !== 'string') return false;
      if (metadata['lastRunStatus'] === 'running') {
        const durable = await bureau.tasks.workflow(lastRunId);
        if (durable !== undefined && durable !== null && isDurableRunUnsettled(durable.status)) {
          return true;
        }
      }
      // `expiresAt` was issued by Armorer's clock, read here with the mount's: the same
      // clock assumption the thread lease makes across processes (skew below the lease
      // length minus its renewal interval). A fast clock here admits a start a slow
      // holder could still approve.
      return holdsPendingApproval(metadata, lastRunId, runtime.clock.now());
    } catch {
      return true;
    }
  }

  /**
   * A run another process holds, or settled with an approval no process restored, found by its
   * durable record: its session (from the durable run's input) must say it is attachable.
   */
  async function attachableRunOfRecord(runId: string): Promise<string | undefined> {
    if (bureau.tasks.detail(runId) !== undefined) return undefined;
    const durable = await bureau.tasks.workflow(runId).catch(() => undefined);
    if (durable === undefined || durable === null) return undefined;
    const sessionId = await sessionOfRun(runId);
    if (sessionId === undefined) return undefined;
    const session = await bureau.contexts.get(sessionId).catch(() => undefined);
    if (session === undefined) return undefined;
    return (await attachableFromRecord(session, runId)) ? sessionId : undefined;
  }

  async function attachableRun(
    runId: string,
  ): Promise<{ sessionId: string; runId: string } | undefined> {
    const detail = bureau.tasks.detail(runId);
    const pending = bureau.reviews.list().filter((review) => review.runId === runId);
    const live = detail?.status === 'running' || detail?.status === 'aborting';
    if (!live && !pending.some((review) => review.kind === 'tool-approval')) return undefined;
    const sessionId = detail?.sessionId ?? pending[0]?.sessionId;
    return sessionId === undefined ? undefined : { sessionId, runId };
  }

  /**
   * The thread's conversation as the messages of a `MESSAGES_SNAPSHOT` (the mapping the attach
   * stream uses), for a client that opens a thread with no run to attach to, such as a finished
   * session. The attach route's own predicate decides: the thread's owner, or `bureau.tasks:read`.
   */
  async function readThreadMessages(threadId: string, principal: Principal): Promise<Response> {
    const authorized = await authorizeThread(threadId, principal, 'bureau.tasks:read');
    if (authorized === undefined) return notFound('thread', threadId);
    return json(
      { threadId, messages: snapshotMessages(authorized.session.conversationHistory) },
      200,
    );
  }

  async function attachByThread(
    threadId: string,
    principal: Principal,
    a2ui: AgUiA2uiDeclaration | undefined,
    resumeCursor: string | undefined,
  ): Promise<Response> {
    const missing = refuse('THREAD_NOT_FOUND', `Thread "${threadId}" was not found`);
    const authorized = await authorizeThread(threadId, principal, 'bureau.tasks:read');
    if (authorized === undefined) return missing;
    const runId = await attachableRunOfThread(threadId, authorized);
    if (runId === undefined) {
      return refuse('RUN_NOT_FOUND', `Thread "${threadId}" has no run to attach to`);
    }
    return openRunStream(environment, {
      threadId,
      runId,
      nativeRunId: runId,
      owner: authorized.owner,
      viewerIsOwner: ownerOfPrincipal(principal) === authorized.owner,
      replay: 'open-step',
      ...(resumeCursor === undefined ? {} : { resumeCursor }),
      messagesSnapshot: true,
      ...(a2ui === undefined ? {} : { a2ui }),
    });
  }

  /** The session a run belongs to: the one this process holds it for, or its durable run's input. */
  async function sessionOfRun(runId: string): Promise<string | undefined> {
    const held = bureau.tasks.detail(runId)?.sessionId;
    if (held !== undefined) return held;
    const state = await bureau.tasks.workflow(runId).catch(() => undefined);
    const input: unknown = state?.input;
    const sessionId =
      typeof input === 'object' && input !== null
        ? (input as { sessionId?: unknown }).sessionId
        : undefined;
    return typeof sessionId === 'string' ? sessionId : undefined;
  }

  async function attachByRun(
    runId: string,
    principal: Principal,
    a2ui: AgUiA2uiDeclaration | undefined,
    resumeCursor: string | undefined,
  ): Promise<Response> {
    const missing = (): Response => refuse('RUN_NOT_FOUND', `Run "${runId}" was not found`);
    const owner = await authorization.ownerOf({ kind: 'run', id: runId });
    if (owner === undefined || !may(principal, owner, 'bureau.tasks:read')) return missing();
    const target = await attachableRun(runId);
    if (target === undefined) {
      // Bureau holds no run for a child, only its record, so its owner attaches
      // through that: a thread of its own (the child has no session), and the
      // parent's id on RUN_STARTED.
      const child = await bureau.children.locate(runId).catch(() => undefined);
      if (child === undefined) {
        const sessionId = await attachableRunOfRecord(runId);
        if (sessionId === undefined) return missing();
        return openRunStream(environment, {
          threadId: sessionId,
          runId,
          nativeRunId: runId,
          owner,
          viewerIsOwner: ownerOfPrincipal(principal) === owner,
          replay: 'open-step',
          ...(resumeCursor === undefined ? {} : { resumeCursor }),
          messagesSnapshot: true,
          ...(a2ui === undefined ? {} : { a2ui }),
        });
      }
      // The thread is the parent's session, as on every stream of this mount.
      const sessionId = await sessionOfRun(child.parentRunId);
      if (sessionId === undefined) return missing();
      return openRunStream(environment, {
        threadId: sessionId,
        runId,
        nativeRunId: runId,
        owner,
        viewerIsOwner: ownerOfPrincipal(principal) === owner,
        parentRunId: child.parentRunId,
        child,
        replay: 'open-step',
        ...(resumeCursor === undefined ? {} : { resumeCursor }),
        messagesSnapshot: true,
      });
    }
    return openRunStream(environment, {
      threadId: target.sessionId,
      runId,
      nativeRunId: runId,
      owner,
      viewerIsOwner: ownerOfPrincipal(principal) === owner,
      replay: 'open-step',
      ...(resumeCursor === undefined ? {} : { resumeCursor }),
      messagesSnapshot: true,
      ...(a2ui === undefined ? {} : { a2ui }),
    });
  }

  async function cancel(runId: string, principal: Principal): Promise<Response> {
    const owner = await authorization.ownerOf({ kind: 'run', id: runId });
    if (owner === undefined || !may(principal, owner, 'bureau.tasks:write')) {
      return notFound('run', runId);
    }
    // A run this process holds and has ended answers its own outcome: `completed`, `aborted` or
    // `error`.
    const held = bureau.tasks.detail(runId);
    if (held !== undefined && held.status !== 'running' && held.status !== 'aborting') {
      return json({ runId, status: held.status }, 200);
    }
    const task = await bureau.tasks.get(runId);
    if (task === undefined) return cancelChild(runId);
    if (held !== undefined || !SETTLED_TASK_STATES.has(task.status)) {
      const outcome = await bureau.tasks.cancel(runId);
      if (outcome.receipt !== 'rejected') return json({ runId, status: 'aborting' }, 200);
    }
    // The task had already ended.
    const ended = bureau.tasks.detail(runId);
    if (ended !== undefined) return json({ runId, status: ended.status }, 200);
    const settled = await bureau.tasks.workflow(runId);
    const outcome =
      settled === undefined || settled === null ? undefined : settledOutcomeOf(settled);
    return json({ runId, status: outcome ?? 'error' }, 200);
  }

  /**
   * The task registry holds no task for a child, so a child is cancelled through the topology
   * that owns it, by the parent it names.
   */
  async function cancelChild(runId: string): Promise<Response> {
    const child = await bureau.children.locate(runId).catch(() => undefined);
    if (child === undefined) return notFound('run', runId);
    const cancelled = await bureau.children.cancel({
      parentRunId: child.parentRunId,
      childRunId: child.childRunId,
    });
    if (cancelled.outcome === 'requested') return json({ runId, status: 'aborting' }, 200);
    if (cancelled.outcome === 'already-terminal') {
      return json({ runId, status: cancelled.child.status }, 200);
    }
    if (cancelled.outcome === 'not-found') return notFound('run', runId);
    return json({ code: 'Conflict', message: cancelled.reason }, 409);
  }

  async function startRun(
    input: RunAgentInput,
    agentName: string,
    principal: Principal,
    a2ui: AgUiA2uiDeclaration | undefined,
  ): Promise<Response> {
    const owner = ownerOfPrincipal(principal);
    if (owner === undefined) {
      return json(
        { code: 'Forbidden', message: 'Starting a run requires an API-key or local caller' },
        403,
      );
    }
    if (input.protocolVersion !== undefined && input.protocolVersion !== PROTOCOL_VERSION) {
      return refuse('INVALID_INPUT', `protocolVersion must be "${PROTOCOL_VERSION}" or absent`);
    }
    if (input.tools.length > 0) {
      return refuse(
        'INVALID_INPUT',
        'This mount runs the Bureau’s own tools; frontend tools in `tools` are not supported',
      );
    }
    // A resume continues a run that exists, so whether the agent can be started does not gate it: an agent that is
    // deleted while its run waits for an answer must not strand that run. It is
    // authorized by the thread's owner, the review's owner, and the write scope, as ever.
    if (input.resume !== undefined && input.resume.length > 0) {
      resumeRun ??= createResume({
        bureau,
        environment,
        runtime,
        mayWrite: (caller, resourceOwner) => may(caller, resourceOwner, 'bureau.tasks:write'),
        leases,
        ownerOfReview: (reviewId) => authorization.ownerOf({ kind: 'review', id: reviewId }),
        refuse,
      });
      // The attach route's own predicate: a write scope alone answers, and reads nothing.
      // Read alongside the resume rather than ahead of it, and a read that fails reads as no
      // access, so the caller is told no more than it was. The session read starts now and is
      // eager; only the decision is deferred. The predicate runs when the resume asks, after it
      // has decided on the interrupts, and resolves to the owner of the session it decided on,
      // which is the owner the stream reads the thread as.
      const thread = bureau.contexts.get(input.threadId).then(ownedSession, () => undefined);
      const readableAs = async (): Promise<string | undefined> => {
        const loaded = await thread;
        return loaded !== undefined && may(principal, loaded.owner, 'bureau.tasks:read')
          ? loaded.owner
          : undefined;
      };
      return resumeRun({
        threadId: input.threadId,
        runId: input.runId,
        agentName,
        entries: input.resume,
        principal,
        owner,
        readableAs,
        ...(a2ui === undefined ? {} : { a2ui }),
      });
    }
    // Whether the agent can be started gates a new run only.
    if (!startable.includes(agentName, principal)) {
      return refuse('THREAD_NOT_FOUND', `Thread "${input.threadId}" was not found`);
    }
    // Only the thread's owner starts a run on a thread that exists: a start adds to
    // the conversation, which a write scope alone does not grant. The refusal is the
    // one a missing thread gets, and comes before anything else is learned about it.
    const existing = await bureau.contexts.get(input.threadId);
    if (existing !== undefined && !ownsSession(existing, owner)) {
      return refuse('THREAD_NOT_FOUND', `Thread "${input.threadId}" was not found`);
    }
    // Whether the thread is busy and the creation of the run that makes it busy are
    // one decision, so it is taken under a lease on the thread in the Bureau's own
    // store: a start in any process that finds the lease held answers THREAD_BUSY,
    // and the lease of a process that died expires.
    const lease = await leases.acquire('thread', input.threadId);
    if (lease === undefined) {
      return refuse('THREAD_BUSY', `Thread "${input.threadId}" has a run in progress`);
    }
    let admitted: { readonly response: Response } | { readonly runId: string };
    try {
      admitted = await (async (): Promise<
        { readonly response: Response } | { readonly runId: string }
      > => {
        // The session the start appends to and decides busyness from is read again under the
        // lease, and is the caller's own or a missing one: another owner may have created the
        // thread since the check above, and the same refusal answers it.
        let session: AgentSession | undefined;
        try {
          session = await bureau.contexts.get(input.threadId);
        } catch {
          // The busy decision below is made from this record, and a start admitted on a guess
          // forks the thread: a read that fails is a thread that is busy.
          return {
            response: refuse('THREAD_BUSY', `Thread "${input.threadId}" has a run in progress`),
          };
        }
        if (session !== undefined && !ownsSession(session, owner)) {
          return {
            response: refuse('THREAD_NOT_FOUND', `Thread "${input.threadId}" was not found`),
          };
        }
        let appendMessages;
        try {
          appendMessages = rowsAddedBy(
            session?.conversationHistory ?? createConversationHistory({ id: input.threadId }),
            input.messages,
          );
        } catch (error) {
          return {
            response: refuse(
              'INVALID_INPUT',
              error instanceof Error ? error.message : 'Invalid messages',
            ),
          };
        }

        // An asset the start names is the caller's to use and `available`, or the start is refused
        // before anything is added to the thread or any run is created.
        let unusable: string | undefined;
        try {
          unusable = await firstUnusableAsset(
            bureau,
            owner,
            appendMessages,
            principal.method !== 'unauthenticated' && principal.hasScope('bureau.assets:read'),
          );
        } catch {
          return { response: refuse('RUN_FAILED', 'The run could not be started') };
        }
        if (unusable !== undefined) {
          return {
            response: refuse('INVALID_INPUT', unusable),
          };
        }

        // A start the thread already holds the rows of is the retry of one that
        // created them: it attaches to the run that did, rather than starting
        // another. A start that added new rows under a used runId falls through to
        // `tasks.start`, whose ledger refuses the changed request. A runId that names a
        // run of another thread is a conflict, not an attach to that run.
        if (appendMessages.length === 0) {
          const earlier = await bureau.tasks
            .receipt({ principal: owner, commandId: input.runId, agentName })
            .catch(() => undefined);
          if (earlier?.status === 'recorded' || earlier?.status === 'pending') {
            if (earlier.sessionId !== input.threadId) {
              return {
                response: refuse(
                  'RUN_CONFLICT',
                  'This runId was already used for a different request',
                ),
              };
            }
            return {
              response: openRunStream(environment, {
                threadId: input.threadId,
                runId: input.runId,
                nativeRunId: earlier.receipt.runId,
                owner,
                viewerIsOwner: true,
                replay: 'beginning',
                messagesSnapshot: false,
                ...(a2ui === undefined ? {} : { a2ui }),
              }),
            };
          }
        }
        if (appendMessages.at(-1)?.role !== 'user') {
          return {
            response: refuse(
              'INVALID_INPUT',
              'A start must add a user message as its last message',
            ),
          };
        }
        if (await threadBusy(session)) {
          return {
            response: refuse('THREAD_BUSY', `Thread "${input.threadId}" has a run in progress`),
          };
        }
        // A lease this start no longer holds was taken over: another start may have
        // decided the thread is idle too.
        if (!(await lease.renew())) {
          return {
            response: refuse('THREAD_BUSY', `Thread "${input.threadId}" has a run in progress`),
          };
        }
        try {
          const run = await bureau.tasks.start(
            agentName,
            { append: appendMessages },
            {
              contextId: input.threadId,
              principal: owner,
              commandId: input.runId,
              origin: { kind: 'chat' },
            },
          );
          return { runId: run.id };
        } catch (error) {
          return { response: refuse(...refusalFor(error, input.threadId)) };
        }
      })();
    } finally {
      await releaseQuietly(lease);
    }
    if ('response' in admitted) return admitted.response;
    return openRunStream(environment, {
      threadId: input.threadId,
      runId: input.runId,
      nativeRunId: admitted.runId,
      owner,
      viewerIsOwner: true,
      replay: 'beginning',
      messagesSnapshot: false,
      ...(a2ui === undefined ? {} : { a2ui }),
    });
  }

  async function route(request: Request, context: { principal: Principal }): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const segments = path.slice(pathPrefix.length).split('/').slice(1).map(decodeSegment);
    if (segments.some((segment) => segment === undefined || segment === '')) {
      return json({ code: 'NotFound', message: 'No such route' }, 404);
    }
    const [first, second, third] = segments as string[];
    const { principal } = context;
    const method = request.method.toUpperCase();

    if (segments.length === 3 && first === 'agents' && third === 'run') {
      if (method !== 'POST') return json({ code: 'MethodNotAllowed', message: 'Use POST' }, 405);
      if (!acceptsEventStream(request.headers.get('Accept'))) {
        return json(
          { code: 'InvalidParams', message: 'Accept header must include text/event-stream' },
          406,
        );
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ code: 'InvalidParams', message: 'The body must be a RunAgentInput' }, 400);
      }
      const parsed = RunAgentInputSchema.safeParse(body);
      if (!parsed.success) {
        return json(
          {
            code: 'InvalidParams',
            message: `The body is not a RunAgentInput: ${parsed.error.message}`,
          },
          400,
        );
      }
      const input = parsed.data as RunAgentInput;
      return startRun(
        input,
        second!,
        principal,
        a2uiDeclarationOf(request.headers, input.forwardedProps),
      );
    }
    if (segments.length === 3 && first === 'threads' && third === 'messages') {
      if (method !== 'GET') return json({ code: 'MethodNotAllowed', message: 'Use GET' }, 405);
      return readThreadMessages(second!, principal);
    }
    if (segments.length === 3 && first === 'threads' && third === 'run') {
      if (method !== 'GET') return json({ code: 'MethodNotAllowed', message: 'Use GET' }, 405);
      if (!acceptsEventStream(request.headers.get('Accept'))) {
        return json(
          { code: 'InvalidParams', message: 'Accept header must include text/event-stream' },
          406,
        );
      }
      return attachByThread(
        second!,
        principal,
        a2uiDeclarationOf(request.headers),
        request.headers.get('Last-Event-ID') ?? undefined,
      );
    }
    if (segments.length === 2 && first === 'runs') {
      if (method !== 'GET') return json({ code: 'MethodNotAllowed', message: 'Use GET' }, 405);
      if (!acceptsEventStream(request.headers.get('Accept'))) {
        return json(
          { code: 'InvalidParams', message: 'Accept header must include text/event-stream' },
          406,
        );
      }
      return attachByRun(
        second!,
        principal,
        a2uiDeclarationOf(request.headers),
        request.headers.get('Last-Event-ID') ?? undefined,
      );
    }
    if (segments.length === 3 && first === 'runs' && third === 'cancel') {
      if (method !== 'POST') return json({ code: 'MethodNotAllowed', message: 'Use POST' }, 405);
      return cancel(second!, principal);
    }
    return json({ code: 'NotFound', message: 'No such route' }, 404);
  }

  return {
    pathPrefix,
    fetch: (request, context) => route(request, context),
  };
}

/**
 * Whether a session holds an unexpired tool approval for `runId` in `pendingApprovalOverrides`.
 * Bureau persists the entry when an approval is gated and removes it in the same write as the
 * resolution; an entry whose binding has expired is not pending, by the rule `reviews.list`
 * uses.
 */
function holdsPendingApproval(
  metadata: AgentSession['metadata'],
  runId: string,
  asOf: number,
): boolean {
  const overrides = metadata['pendingApprovalOverrides'];
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    return false;
  }
  return Object.entries(overrides).some(([reviewId, approval]) => {
    if (!reviewId.startsWith(`approval:${runId}:`)) return false;
    const expiresAt = (approval as { approvalBinding?: { expiresAt?: unknown } } | null)
      ?.approvalBinding?.expiresAt;
    return typeof expiresAt !== 'number' || expiresAt > asOf;
  });
}

/**
 * Why the first managed asset `rows` name cannot be used by `owner`, as the message the start is
 * refused with, or `undefined` when every one can. An asset another owner holds and one that does
 * not exist read alike, as `was not found`, so no caller learns whether another owner's asset
 * exists, and a caller without `bureau.assets:read` reads every asset alike, whoever holds it. An asset the owner holds that is not `available` (pending, rejected, quarantined,
 * expired or deleted) is named by its state: a run resolves every asset in the thread on every
 * turn, so a row that names one is committed only to fail the thread's every later turn.
 */
async function firstUnusableAsset(
  bureau: Pick<AgUiBureau, 'assets'>,
  owner: string,
  rows: Parameters<typeof managedAssetIdsOf>[0],
  mayReadAssets: boolean,
): Promise<string | undefined> {
  const assets = bureau.assets;
  if (assets === undefined) return undefined;
  for (const assetId of managedAssetIdsOf(rows)) {
    // Naming an asset in a chat is reading it: the model reads it. A credential without the read
    // scope is answered as for a missing asset, before the asset is looked up, so neither its
    // existence nor its state is disclosed.
    if (!mayReadAssets) return `Asset "${assetId}" was not found`;
    try {
      const { state } = await assets.inspect(assetId, { id: owner });
      if (state !== 'available') return `Asset "${assetId}" is ${state}`;
    } catch (error) {
      if (error instanceof AssetNotFoundError) return `Asset "${assetId}" was not found`;
      throw error;
    }
  }
  return undefined;
}

/** How a failure to create the run is told to the client, as a code and a message. */
function refusalFor(error: unknown, threadId: string): [AgUiErrorCode, string] {
  if (error instanceof BureauLedgerConflictError) {
    return ['RUN_CONFLICT', 'This runId was already used for a different request'];
  }
  if (error instanceof BureauError) {
    if (error.code === 'NOT_FOUND')
      return ['THREAD_NOT_FOUND', `Thread "${threadId}" was not found`];
    if (error.code === 'BAD_REQUEST') return ['INVALID_INPUT', error.message];
  }
  return ['RUN_FAILED', 'The run could not be started'];
}
