/**
 * The AG-UI mount of `createBureauHandler`: Agent Bureau runs, served as AG-UI 1.0
 * Server-Sent Events.
 *
 * A thread is a Bureau session. The mount serves four routes under one prefix
 * (`/ag-ui` unless `agUi.pathPrefix` says otherwise); `<p>` is the prefix:
 *
 * | Route                           | Body            | Answer |
 * | ------------------------------- | --------------- | ------ |
 * | `POST <p>/agents/<name>/run`    | `RunAgentInput` | An event stream. `resume` absent or empty starts a run; `resume` present resumes one. |
 * | `GET <p>/threads/<threadId>/run`| none            | A stream attached to the thread's most recent root run, while it is live, parked on a human wait, or settled with a tool approval pending. Otherwise a one-event `RUN_NOT_FOUND` stream. |
 * | `GET <p>/runs/<runId>`          | none            | The same, for that run by native id, or a child run's stream by its own id. |
 * | `POST <p>/runs/<runId>/cancel`  | none            | JSON `{ runId, status }`; a `NotFound` fault otherwise. |
 *
 * Every route is authenticated by the handler before the mount sees it, and
 * decides with the owner predicate every catalog operation decides with
 * (`owner-predicate.ts`): the owner of the resource, or the kind's operator
 * scope. `bureau.tasks:read` lets another principal attach. `bureau.tasks:write`
 * lets it cancel a run and answer a human-input wait, and no more: only the
 * thread's owner starts a run on an existing thread (a cross-owner start is
 * `THREAD_NOT_FOUND`), and only the owner answers a tool approval (a resume that
 * includes one is `INTERRUPT_NOT_FOUND`, before anything is resolved), because
 * approving a call authorizes a tool to run as the owner. A caller the predicate
 * refuses is answered exactly as a missing resource is, so an identifier grants
 * nothing.
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
import { type RunAgentInput } from '@ag-ui/core';
import { RunAgentInputSchema } from '@ag-ui/core/schemas';
import type { OperationHandlerMount } from '@lostgradient/weft';
import { createConversationHistory } from 'conversationalist';

import { BureauLedgerConflictError } from '../command-ledger.ts';
import { BureauError } from '../create-bureau.ts';
import type { Bureau, OwnedResource } from '../types.ts';
import { rowsAddedBy } from './ag-ui-messages.ts';
import { createAgUiLeases } from './ag-ui-lease.ts';
import { createResume } from './ag-ui-resume.ts';
import { singleEventResponse } from './ag-ui-sink.ts';
import {
  type AgUiStreamBureau,
  type AgUiStreamEnvironment,
  errorEvent,
  openRunStream,
} from './ag-ui-stream.ts';
import type { AgUiErrorCode } from './ag-ui-vocabulary.ts';
import { ownerOfPrincipal, type OwnerAccessPredicate } from './owner-predicate.ts';

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

/** What the mount reads from the Bureau. */
export type AgUiBureau = AgUiStreamBureau &
  Pick<
    Bureau,
    | 'abortRun'
    | 'createRun'
    | 'listRuns'
    | 'getOwner'
    | 'hasDurableEngine'
    | 'locateRunCreationReceipt'
    | 'getReview'
    | 'resolveReview'
    | 'kv'
  >;

/** The owner predicate the mount decides with, and where an owner of record comes from. */
export type AgUiAuthorization = {
  readonly mayAccess: OwnerAccessPredicate;
  readonly ownerOf: (resource: OwnedResource) => Promise<string | undefined>;
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
  publish: ReadonlyArray<string>,
  options: AgUiOptions,
): OperationHandlerMount {
  const pathPrefix = (options.pathPrefix ?? DEFAULT_AG_UI_PATH_PREFIX).replace(/\/+$/, '');
  const runtime = options.runtime ?? createDefaultRuntimeServices();
  const environment: AgUiStreamEnvironment = {
    bureau,
    runtime,
    maxStreamDurationMs: options.maxStreamDurationMs ?? DEFAULT_AG_UI_MAX_STREAM_DURATION_MS,
    liveBufferSize: options.liveBufferSize ?? DEFAULT_AG_UI_LIVE_BUFFER_SIZE,
    keepAliveMs: options.keepAliveIntervalMs ?? DEFAULT_AG_UI_KEEP_ALIVE_INTERVAL_MS,
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
    kv: bureau.kv!,
    runtime,
    leaseMs: options.leaseDurationMs,
  });

  /** The thread's most recent root run when it is one a client can attach to. */
  async function attachableRunOfThread(threadId: string): Promise<string | undefined> {
    const live = bureau
      .listRuns()
      .filter(
        (run) =>
          run.sessionId === threadId && (run.status === 'running' || run.status === 'aborting'),
      );
    const latest = live.at(-1);
    if (latest !== undefined) return latest.id;
    const session = await bureau.getSession(threadId);
    const lastRunId = session?.metadata['lastRunId'];
    if (typeof lastRunId !== 'string') return undefined;
    const pending = bureau
      .listPendingReviews()
      .some((review) => review.runId === lastRunId && review.kind === 'tool-approval');
    return pending ? lastRunId : undefined;
  }

  /**
   * Whether the thread's last run is going in a process that is not this one. The
   * thread lease covers only a start's admission, so once it is released another
   * process's live run is visible only in the store: the session says its last run
   * is running, this process does not hold that run, and the durable run agrees. A
   * marker a crash left behind is settled by durable recovery, so it cannot hold the
   * thread for ever.
   */
  async function liveElsewhere(threadId: string): Promise<boolean> {
    const metadata = (await bureau.getSession(threadId))?.metadata;
    const lastRunId = metadata?.['lastRunId'];
    if (metadata?.['lastRunStatus'] !== 'running' || typeof lastRunId !== 'string') return false;
    if (bureau.getRun(lastRunId) !== undefined) return false;
    const durable = await bureau.getDurableRun(lastRunId).catch(() => undefined);
    return durable?.status === 'running';
  }

  async function attachableRun(
    runId: string,
  ): Promise<{ sessionId: string; runId: string } | undefined> {
    const detail = bureau.getRun(runId);
    const pending = bureau.listPendingReviews().filter((review) => review.runId === runId);
    const live = detail?.status === 'running' || detail?.status === 'aborting';
    if (!live && !pending.some((review) => review.kind === 'tool-approval')) return undefined;
    const sessionId = detail?.sessionId ?? pending[0]?.sessionId;
    return sessionId === undefined ? undefined : { sessionId, runId };
  }

  async function attachByThread(threadId: string, principal: Principal): Promise<Response> {
    const missing = refuse('THREAD_NOT_FOUND', `Thread "${threadId}" was not found`);
    const owner = await authorization.ownerOf({ kind: 'session', id: threadId });
    if (owner === undefined || !may(principal, owner, 'bureau.tasks:read')) return missing;
    const runId = await attachableRunOfThread(threadId);
    if (runId === undefined) {
      return refuse('RUN_NOT_FOUND', `Thread "${threadId}" has no run to attach to`);
    }
    return openRunStream(environment, {
      threadId,
      runId,
      nativeRunId: runId,
      replay: 'open-step',
      messagesSnapshot: true,
    });
  }

  /** The session a run belongs to: the one this process holds it for, or its durable run's input. */
  async function sessionOfRun(runId: string): Promise<string | undefined> {
    const held = bureau.getRun(runId)?.sessionId;
    if (held !== undefined) return held;
    const state = await bureau.getDurableRun(runId).catch(() => undefined);
    const input: unknown = state?.input;
    const sessionId =
      typeof input === 'object' && input !== null
        ? (input as { sessionId?: unknown }).sessionId
        : undefined;
    return typeof sessionId === 'string' ? sessionId : undefined;
  }

  async function attachByRun(runId: string, principal: Principal): Promise<Response> {
    const missing = (): Response => refuse('RUN_NOT_FOUND', `Run "${runId}" was not found`);
    const owner = await authorization.ownerOf({ kind: 'run', id: runId });
    if (owner === undefined || !may(principal, owner, 'bureau.tasks:read')) return missing();
    const target = await attachableRun(runId);
    if (target === undefined) {
      // Bureau holds no run for a child, only its record, so its owner attaches
      // through that: a thread of its own (the child has no session), and the
      // parent's id on RUN_STARTED.
      const child = await bureau.children.locate(runId).catch(() => undefined);
      if (child === undefined) return missing();
      // The thread is the parent's session, as on every stream of this mount.
      const sessionId = await sessionOfRun(child.parentRunId);
      if (sessionId === undefined) return missing();
      return openRunStream(environment, {
        threadId: sessionId,
        runId,
        nativeRunId: runId,
        parentRunId: child.parentRunId,
        child,
        replay: 'open-step',
        messagesSnapshot: true,
      });
    }
    return openRunStream(environment, {
      threadId: target.sessionId,
      runId,
      nativeRunId: runId,
      replay: 'open-step',
      messagesSnapshot: true,
    });
  }

  async function cancel(runId: string, principal: Principal): Promise<Response> {
    const owner = await authorization.ownerOf({ kind: 'run', id: runId });
    if (owner === undefined || !may(principal, owner, 'bureau.tasks:write')) {
      return notFound('run', runId);
    }
    try {
      const summary = bureau.abortRun(runId);
      return json({ runId, status: summary.status }, 200);
    } catch (error) {
      if (!(error instanceof BureauError && error.code === 'NOT_FOUND')) throw error;
    }
    // Bureau holds no run for a child, so it is cancelled through the topology
    // that owns it, by the parent it names.
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
    if (!publish.includes(agentName)) {
      return refuse('THREAD_NOT_FOUND', `Thread "${input.threadId}" was not found`);
    }
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
      return resumeRun({
        threadId: input.threadId,
        runId: input.runId,
        agentName,
        entries: input.resume,
        principal,
        owner,
      });
    }
    // Only the thread's owner starts a run on a thread that exists: a start adds to
    // the conversation, which a write scope alone does not grant. The refusal is the
    // one a missing thread gets, and comes before anything else is learned about it.
    const threadOwner = await authorization.ownerOf({ kind: 'session', id: input.threadId });
    if (threadOwner !== undefined && threadOwner !== owner) {
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
        const session = await bureau.getSession(input.threadId);
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

        // A start the thread already holds the rows of is the retry of one that
        // created them: it attaches to the run that did, rather than starting
        // another. A start that added new rows under a used runId falls through to
        // createRun, whose ledger refuses the changed request. A runId that names a
        // run of another thread is a conflict, not an attach to that run.
        if (appendMessages.length === 0) {
          const earlier = await bureau
            .locateRunCreationReceipt({
              principal: owner,
              agentName,
              runCreationRequestId: input.runId,
            })
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
                replay: 'beginning',
                messagesSnapshot: false,
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
        if (
          (await attachableRunOfThread(input.threadId)) !== undefined ||
          (await liveElsewhere(input.threadId))
        ) {
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
          const run = await bureau.createRun({
            sessionId: input.threadId,
            agentName,
            principal: owner,
            appendMessages,
            runCreationRequestId: input.runId,
          });
          return { runId: run.id };
        } catch (error) {
          return { response: refuse(...refusalFor(error, input.threadId)) };
        }
      })();
    } finally {
      await lease.release();
    }
    if ('response' in admitted) return admitted.response;
    return openRunStream(environment, {
      threadId: input.threadId,
      runId: input.runId,
      nativeRunId: admitted.runId,
      replay: 'beginning',
      messagesSnapshot: false,
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
      return startRun(parsed.data as RunAgentInput, second!, principal);
    }
    if (segments.length === 3 && first === 'threads' && third === 'run') {
      if (method !== 'GET') return json({ code: 'MethodNotAllowed', message: 'Use GET' }, 405);
      if (!acceptsEventStream(request.headers.get('Accept'))) {
        return json(
          { code: 'InvalidParams', message: 'Accept header must include text/event-stream' },
          406,
        );
      }
      return attachByThread(second!, principal);
    }
    if (segments.length === 2 && first === 'runs') {
      if (method !== 'GET') return json({ code: 'MethodNotAllowed', message: 'Use GET' }, 405);
      if (!acceptsEventStream(request.headers.get('Accept'))) {
        return json(
          { code: 'InvalidParams', message: 'Accept header must include text/event-stream' },
          406,
        );
      }
      return attachByRun(second!, principal);
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
