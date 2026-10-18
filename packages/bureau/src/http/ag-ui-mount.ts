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
 * | `GET <p>/runs/<runId>`          | none            | The same, for that run by native id. |
 * | `POST <p>/runs/<runId>/cancel`  | none            | JSON `{ runId, status }`; a `NotFound` fault otherwise. |
 *
 * Every route is authenticated by the handler before the mount sees it, and
 * decides with the owner predicate every catalog operation decides with
 * (`owner-predicate.ts`): the owner of the resource, or the kind's operator
 * scope (`bureau.tasks:read` to attach, `bureau.tasks:write` to start, resume, or
 * cancel). A caller the predicate refuses is answered exactly as a missing
 * resource is, so an identifier grants nothing.
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
   * The clock and timers the mount reads, so a test drives the stream deadline
   * with a manual clock. Defaults to the real ones.
   */
  readonly runtime?: Pick<RuntimeServices, 'clock' | 'timers'>;
};

export const DEFAULT_AG_UI_PATH_PREFIX = '/ag-ui';
export const DEFAULT_AG_UI_MAX_STREAM_DURATION_MS = 900_000;
export const DEFAULT_AG_UI_LIVE_BUFFER_SIZE = 1000;
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
  };
  const now = (): number => runtime.clock.now();

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

  async function attachByRun(runId: string, principal: Principal): Promise<Response> {
    const missing = (): Response => refuse('RUN_NOT_FOUND', `Run "${runId}" was not found`);
    const owner = await authorization.ownerOf({ kind: 'run', id: runId });
    if (owner === undefined || !may(principal, owner, 'bureau.tasks:read')) return missing();
    const target = await attachableRun(runId);
    if (target === undefined) return missing();
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
      if (error instanceof BureauError && error.code === 'NOT_FOUND') {
        return notFound('run', runId);
      }
      throw error;
    }
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
    const threadOwner = await authorization.ownerOf({ kind: 'session', id: input.threadId });
    if (threadOwner !== undefined && !may(principal, threadOwner, 'bureau.tasks:write')) {
      return refuse('THREAD_NOT_FOUND', `Thread "${input.threadId}" was not found`);
    }
    const session = await bureau.getSession(input.threadId);
    let appendMessages;
    try {
      appendMessages = rowsAddedBy(
        session?.conversationHistory ?? createConversationHistory({ id: input.threadId }),
        input.messages,
      );
    } catch (error) {
      return refuse('INVALID_INPUT', error instanceof Error ? error.message : 'Invalid messages');
    }

    // A start the thread already holds the rows of is the retry of one that
    // created them: it attaches to the run that did, rather than starting another.
    // A start that added new rows under a used runId falls through to createRun,
    // whose ledger refuses the changed request.
    if (appendMessages.length === 0) {
      const earlier = await bureau
        .locateRunCreationReceipt({
          principal: owner,
          agentName,
          runCreationRequestId: input.runId,
        })
        .catch(() => undefined);
      if (earlier?.status === 'recorded' || earlier?.status === 'pending') {
        return openRunStream(environment, {
          threadId: input.threadId,
          runId: input.runId,
          nativeRunId: earlier.receipt.runId,
          replay: 'beginning',
          messagesSnapshot: false,
        });
      }
    }
    if (appendMessages.at(-1)?.role !== 'user') {
      return refuse('INVALID_INPUT', 'A start must add a user message as its last message');
    }
    if (threadOwner !== undefined && (await attachableRunOfThread(input.threadId)) !== undefined) {
      return refuse('THREAD_BUSY', `Thread "${input.threadId}" has a run in progress`);
    }

    let run;
    try {
      run = await bureau.createRun({
        sessionId: input.threadId,
        agentName,
        principal: owner,
        appendMessages,
        runCreationRequestId: input.runId,
      });
    } catch (error) {
      return refuse(...refusalFor(error, input.threadId));
    }
    return openRunStream(environment, {
      threadId: input.threadId,
      runId: input.runId,
      nativeRunId: run.id,
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
