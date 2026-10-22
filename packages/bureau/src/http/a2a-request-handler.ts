/**
 * Bureau's `A2ARequestHandler` for one published agent (COR-903): A2A 1.0.1's methods over the
 * Bureau's runs, tasks, and reviews, served by the kit's `createA2AHandler` (`a2a-mount.ts`).
 *
 * It implements the interface directly rather than extending the SDK's `DefaultRequestHandler`,
 * because a task is a Bureau run created through the run-creation ledger, not an executor's
 * events on an in-memory bus. So it also does what `DefaultRequestHandler` would have done with
 * a request's extensions: it activates only the extensions the card declares.
 *
 * ## Sends
 *
 * A message without a `taskId` creates a task: a run of this agent in the message's `contextId`
 * (a session the caller owns), or in a new one. A message with a `taskId` continues that task by
 * the path its state names: an answer to a human wait or a decision on an approval
 * (`bureau.tasks.respond`, through the management plane as the caller), or session input to a
 * task that is still working (delivered at the run's next step boundary, COR-1476).
 *
 * Every send is idempotent on the caller, this agent, the A2A version (normalized to
 * Major.Minor by the kit), the `messageId`, and, for a continuation, the task: the binding is
 * resolved before any other check, so an exact retry returns the original task even after the
 * task finished or the agent was withdrawn, and the same `messageId` with a different payload is
 * refused with `-32602`. Without `configuration.returnImmediately` a send waits until the task
 * is terminal or waits on its requester.
 *
 * ## Scope
 *
 * Every lookup is the caller's own and this agent's: a task another owner holds, or another
 * agent ran, reads exactly as a missing one, and `ListTasks` stays caller-scoped even for a
 * principal holding an operator scope.
 *
 * @module a2a-request-handler
 */

import {
  type AgentCard,
  type CancelTaskRequest,
  type DeleteTaskPushNotificationConfigRequest,
  type GetExtendedAgentCardRequest,
  type GetTaskPushNotificationConfigRequest,
  type GetTaskRequest,
  type ListTaskPushNotificationConfigsRequest,
  type ListTaskPushNotificationConfigsResponse,
  type ListTasksRequest,
  type ListTasksResponse,
  Message,
  Role,
  type SendMessageRequest,
  type StreamResponse,
  type SubscribeToTaskRequest,
  Task,
  type TaskPushNotificationConfig,
  TaskState,
} from '@a2a-js/sdk';
import {
  ContentTypeNotSupportedError,
  PushNotificationNotSupportedError,
  RequestMalformedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from '@a2a-js/sdk/errors';
import {
  type A2ARequestHandler,
  type ServerCallContext,
  STATE_HEADERS_KEY,
  type User,
} from '@a2a-js/sdk/server';
import { createDefaultRuntimeServices, type RuntimeTimers } from '@lostgradient/lifecycle';
import type { Principal } from '@lostgradient/weft';
import { requestSignalOf } from '@lostgradient/weft/a2a';

import {
  BureauLedgerConflictError,
  type CommandLedger,
  type CommandLedgerIdentity,
  canonicalJson,
  digestCommandPayload,
} from '../command-ledger.ts';
import { BureauError } from '../create-bureau.ts';
import { TaskListingTokenError } from '../task-list-snapshots.ts';
import type { TaskRegistry, TaskView } from '../task-registry.ts';
import type { Bureau } from '../types.ts';
import {
  A2A_INPUT_MODES,
  A2A_OUTPUT_MODES,
  A2UI_EXTENSION_URI,
  declaredExtensionsOf,
} from './a2a-agent-card.ts';
import { type A2ATaskRecords, type A2AWireMessage, clearedRecord } from './a2a-task-record.ts';
import {
  agentMessage,
  bureauStateOf,
  CLEANUP_EXTENSION_URI,
  isSettled,
  isTerminal,
  projectTask,
  type ProjectionShape,
  replyMessageId,
} from './a2a-task-projection.ts';
import { type TasksRespondInput, tasksRespondInput } from './management/tasks-respond-operation.ts';
import { DURABLE_HISTORY_EXTENSION_URI, followTask } from './a2a-task-stream.ts';
import { ownerOfPrincipal } from './owner-predicate.ts';

/** The version of the A2A send command's contract, part of every ledger identity. */
export const A2A_SEND_OPERATION_VERSION = 'bureau.a2a.send.v1';

/** The key prefix of the A2A send ledger, disjoint from every other command ledger's. */
export const A2A_SEND_LEDGER_KEY_PREFIX = 'command-ledger:a2a-send:v1';

/** The metadata key a continuation names the human wait it answers with. */
export const SIGNAL_NAME_METADATA_KEY = 'signalName';

/** The metadata key a continuation names the tool approval it decides with, among several. */
export const CALL_ID_METADATA_KEY = 'callId';

/** The metadata key a continuation to a working task names its delivery mode with. */
export const DELIVERY_MODE_METADATA_KEY = 'deliveryMode';

/** The metadata key of a request's correlation identifier, outside every extension namespace. */
export const CORRELATION_ID_METADATA_KEY = 'correlationId';

/** The message-metadata key whose presence activates A2UI's extension (A2UI v0.9.1). */
export const A2UI_CLIENT_CAPABILITIES_METADATA_KEY = 'a2uiClientCapabilities';

/** The A2UI-only alias of the `A2A-Extensions` header (A2UI v0.9.1). */
const A2UI_EXTENSIONS_HEADER = 'x-a2a-extensions';

/** The most history a listed task carries in its snapshot; a page trims it further. */
const LISTED_HISTORY_LIMIT = 100;

/** How long a blocking send waits between reads of a task no event has announced. */
const SETTLE_POLL_MS = 1_000;

/**
 * What a send's ledger entry claims: for a continuation, the path it was admitted by. A retry
 * of a claim left pending takes the same path, whatever state the task has reached since, so an
 * answer that took effect is never resent as session input.
 */
export type A2ASendClaim = { readonly path?: 'answer' | 'input' | undefined };

/** A send once admitted: the task it created or continued, and how its responses show it. */
type Admitted = { readonly taskId: string; readonly shape: ProjectionShape };

/** What a completed send's ledger entry holds: the task it created or continued. */
export type A2ASendResult = { readonly taskId: string };

/** The ledger A2A sends record their bindings in. */
export type A2ASendLedger = CommandLedger<A2ASendClaim, A2ASendResult>;

/** The SDK `User` a Bureau A2A request carries: the principal the handler authenticated. */
export class BureauA2AUser implements User {
  readonly principal: Principal;

  constructor(principal: Principal) {
    this.principal = principal;
  }

  get isAuthenticated(): boolean {
    return this.principal.method !== 'unauthenticated';
  }

  get userName(): string {
    return ownerOfPrincipal(this.principal) ?? '';
  }
}

/** The part of a Bureau the request handler reads. */
export type A2ABureau = Pick<
  Bureau,
  | 'createRun'
  | 'getRun'
  | 'getOwner'
  | 'submitSessionInput'
  | 'eventHistory'
  | 'subscribeEventHistory'
  | 'addEventListener'
  | 'removeEventListener'
> & {
  readonly tasks: Pick<
    TaskRegistry,
    'get' | 'record' | 'cancel' | 'list' | 'onSettled' | 'onChanged'
  >;
};

/** What {@link createBureauA2ARequestHandler} needs. */
export type BureauA2ARequestHandlerOptions = {
  /** The agent this handler serves: every task it reads or creates is this agent's. */
  readonly agentName: string;
  readonly card: () => AgentCard;
  readonly bureau: A2ABureau;
  readonly records: A2ATaskRecords;
  readonly ledger: A2ASendLedger;
  /** Answers a task's open wait as `principal`: `bureau.tasks.respond`'s own body. */
  readonly respond: (principal: Principal, input: TasksRespondInput) => Promise<unknown>;
  /** The timers a blocking send's safety-net poll runs on. Defaults to the process's own. */
  readonly timers?: RuntimeTimers | undefined;
  /** How long a cancel waits for the run's cleanup to acknowledge before it answers. */
  readonly cancelWaitMilliseconds?: number;
};

type Owner = string;

function invalid(message: string): RequestMalformedError {
  return new RequestMalformedError(message);
}

function taskNotFound(taskId: string): TaskNotFoundError {
  return new TaskNotFoundError(`Task '${taskId}' was not found.`);
}

function userOf(context: ServerCallContext | undefined): BureauA2AUser {
  const user = context?.user;
  if (!(user instanceof BureauA2AUser)) {
    throw new UnsupportedOperationError('This request did not arrive through a Bureau A2A mount.');
  }
  return user;
}

function ownerOf(context: ServerCallContext | undefined): Owner {
  const owner = ownerOfPrincipal(userOf(context).principal);
  // The mount refuses a principal that can own nothing before the handler runs.
  if (owner === undefined) throw new UnsupportedOperationError('This caller can own no task.');
  return owner;
}

function headerOf(context: ServerCallContext | undefined, name: string): string | undefined {
  const headers = context?.state.get(STATE_HEADERS_KEY) as Record<string, string> | undefined;
  return headers?.[name];
}

/**
 * The extensions a request activates: the ones it requested that the card declares, plus A2UI's
 * when its own alias header or `metadata.a2uiClientCapabilities` asks for it. Each is recorded on
 * the context, so the kit echoes it in the response's `A2A-Extensions` header.
 */
function activate(
  declared: ReadonlySet<string>,
  context: ServerCallContext | undefined,
  message?: Message,
): ReadonlySet<string> {
  const activated = new Set<string>();
  for (const uri of context?.requestedExtensions ?? []) {
    if (declared.has(uri)) activated.add(uri);
  }
  const alias = headerOf(context, A2UI_EXTENSIONS_HEADER) ?? '';
  if (alias.split(',').some((entry) => entry.trim() === A2UI_EXTENSION_URI)) {
    activated.add(A2UI_EXTENSION_URI);
  }
  if (message?.metadata?.[A2UI_CLIENT_CAPABILITIES_METADATA_KEY] !== undefined) {
    activated.add(A2UI_EXTENSION_URI);
  }
  for (const uri of activated) context?.addActivatedExtension(uri);
  return activated;
}

/** A message's text parts, joined with a newline. */
function textOf(message: Message): string {
  return message.parts
    .flatMap((part) => (part.content?.$case === 'text' ? [part.content.value] : []))
    .join('\n');
}

/** A message's first data part, or `undefined`. */
function dataOf(message: Message): unknown {
  for (const part of message.parts) {
    if (part.content?.$case === 'data') return part.content.value;
  }
  return undefined;
}

function requireMessage(params: SendMessageRequest): Message {
  const message = params.message;
  if (message === undefined || message.messageId === '') {
    throw invalid('message.messageId is required.');
  }
  if (message.parts.length === 0) throw invalid('message.parts must hold at least one part.');
  if (message.role !== Role.ROLE_USER)
    throw invalid('An inbound message must have role ROLE_USER.');
  for (const part of message.parts) {
    if (part.mediaType !== '' && !A2A_INPUT_MODES.includes(part.mediaType)) {
      throw new ContentTypeNotSupportedError(
        `Media type '${part.mediaType}' is not supported; this agent accepts ${A2A_INPUT_MODES.join(', ')}.`,
      );
    }
    const kind = part.content?.$case;
    if (kind !== 'text' && kind !== 'data') {
      throw new ContentTypeNotSupportedError(
        `A ${kind ?? 'empty'} part is not supported; this agent reads text and data parts.`,
      );
    }
  }
  return message;
}

/**
 * The digest a send's binding compares: the canonical message without its correlation
 * identifier or the fields of extensions the request did not activate, the work-affecting part
 * of its configuration (`acceptedOutputModes` as a set; `historyLength` and `returnImmediately`
 * are response controls), and the activated extensions.
 */
function digestOf(
  params: SendMessageRequest,
  message: Message,
  activated: ReadonlySet<string>,
  declared: ReadonlySet<string>,
) {
  const wire = Message.toJSON(message) as Record<string, unknown>;
  const metadata = { ...(wire['metadata'] as Record<string, unknown> | undefined) };
  delete metadata[CORRELATION_ID_METADATA_KEY];
  for (const uri of declared) if (!activated.has(uri)) delete metadata[uri];
  const outputModes = [...new Set(params.configuration?.acceptedOutputModes ?? [])].toSorted();
  const configuration = params.configuration?.taskPushNotificationConfig;
  return digestCommandPayload({
    request: canonicalJson({
      message: { ...wire, metadata },
      acceptedOutputModes: outputModes,
      taskPushNotificationConfig:
        configuration === undefined ? null : (JSON.parse(JSON.stringify(configuration)) as unknown),
      extensions: [...activated].toSorted(),
    }),
  });
}

/** A message as the task's history keeps it: its wire form, bound to the task. */
function historyEntryOf(message: Message, taskId: string, contextId: string): A2AWireMessage {
  return Message.toJSON({ ...message, taskId, contextId }) as A2AWireMessage;
}

/**
 * The strict lower bound, in epoch milliseconds, that admits exactly the tasks at or after
 * `timestamp` (A2A's filter is inclusive; the listing's is strict). Status timestamps have
 * millisecond resolution, so a whole-millisecond instant moves back one millisecond, and an
 * instant with a sub-millisecond part stays on its millisecond, which lies before it.
 */
export function inclusiveBoundary(timestamp: string): number {
  const milliseconds = Date.parse(timestamp);
  const fraction = /\.(\d+)/.exec(timestamp)?.[1] ?? '';
  return /[1-9]/.test(fraction.slice(3)) ? milliseconds : milliseconds - 1;
}

/** The most serialized bytes a listed task's history keeps in a listing snapshot. */
export const LISTED_HISTORY_BYTES = 256 * 1024;

/**
 * A listed task with its history trimmed, oldest first, to {@link LISTED_HISTORY_BYTES}, so one
 * task's entry stays well within a snapshot window however large its messages are.
 */
function boundedTask(task: unknown): unknown {
  const record = task as { history?: unknown[] };
  const history = record.history ?? [];
  let kept = history.length;
  let bytes = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    bytes += new TextEncoder().encode(JSON.stringify(history[index])).byteLength;
    if (bytes > LISTED_HISTORY_BYTES) break;
    kept = index;
  }
  if (bytes <= LISTED_HISTORY_BYTES) return task;
  return { ...record, history: history.slice(kept) };
}

/** Creates the request handler that serves one published agent. */
export function createBureauA2ARequestHandler(
  options: BureauA2ARequestHandlerOptions,
): A2ARequestHandler {
  const { agentName, bureau, records, ledger } = options;
  const cancelWait = options.cancelWaitMilliseconds ?? 0;
  const timers = options.timers ?? createDefaultRuntimeServices().timers;
  const declared = declaredExtensionsOf(options.card());
  /** Sends being admitted in this process, by binding: an identical send waits for the first. */
  const inFlight = new Map<string, Promise<Admitted>>();

  /** The caller's task on this agent, or the not-found answer a denial shares with absence. */
  async function ownTask(taskId: string, owner: Owner): Promise<TaskView> {
    if (taskId === '') throw invalid('A task id is required.');
    const view = await bureau.tasks.get(taskId);
    if (view === undefined || view.owner !== owner || view.agentName !== agentName) {
      throw taskNotFound(taskId);
    }
    return view;
  }

  /** The agent's reply on a completed task: from the live run, its settlement, or its history. */
  async function replyOf(view: TaskView): Promise<string | undefined> {
    if (view.status !== 'completed') return undefined;
    const run = bureau.getRun(view.id);
    const final = run?.stepDetails.findLast((step) => step.final);
    if (final !== undefined) return final.content;
    const record = await bureau.tasks.record(view.id);
    if (record?.settled?.answer !== undefined) return record.settled.answer.text;
    let since: string | undefined;
    let content: string | undefined;
    for (;;) {
      const page = await bureau.eventHistory(
        { kind: 'run', id: view.id },
        { ...(since === undefined ? {} : { since }), limit: 200 },
      );
      if (!('events' in page)) break;
      for (const event of page.events) {
        if (event.kind !== 'run.completed') continue;
        const payload = event.payload as { content?: unknown } | undefined;
        if (typeof payload?.content === 'string') content = payload.content;
      }
      if (!page.hasMore) break;
      since = page.nextCursor ?? page.events.at(-1)?.cursor;
      if (since === undefined) break;
    }
    return content;
  }

  /** The task as one response shows it, folding a completed task's reply into its history once. */
  async function respondWith(view: TaskView, shape: ProjectionShape): Promise<Task> {
    const stored = await bureau.tasks.record(view.id);
    let record = await records.read(view.id);
    // A deleted context empties its tasks' own history, and the A2A history goes with it, even on
    // an instance that did not see the deletion happen.
    if (record !== undefined && stored !== undefined && stored.history.length === 0) {
      if (record.history.length > 0 || !record.replyRecorded) {
        record = await records.update(view.id, (current) =>
          current.history.length === 0 && current.replyRecorded
            ? undefined
            : clearedRecord(current),
        );
      }
    }
    const reply = await replyOf(view);
    // The reply is folded in once it can be read: a completed task whose reply is not yet visible
    // here (its history event has not reached this instance) is folded on a later read.
    const replyReady = view.status !== 'completed' || (reply !== undefined && reply !== '');
    if (record !== undefined && isTerminal(view.status) && !record.replyRecorded && replyReady) {
      record = await records.update(view.id, (current) =>
        current.replyRecorded
          ? undefined
          : {
              ...current,
              replyRecorded: true,
              history:
                reply === undefined || reply === ''
                  ? current.history
                  : [
                      ...current.history,
                      Message.toJSON(
                        agentMessage(view, replyMessageId(view.id), reply),
                      ) as A2AWireMessage,
                    ],
            },
      );
    }
    return projectTask(
      { view, record, reply, acknowledgement: stored?.cleanupAcknowledgement },
      shape,
    );
  }

  /**
   * Waits until the task is terminal or waits on its requester, or the request ends. The task's
   * own events wake it; a slow poll is only the safety net. An event that arrives while the task
   * is being read is not lost: it marks the read stale, and the task is read again at once.
   */
  async function settledView(taskId: string, signal: AbortSignal | undefined): Promise<TaskView> {
    let changed = false;
    let wake: (() => void) | undefined;
    const notify = () => {
      changed = true;
      wake?.();
    };
    const stopSettled = bureau.tasks.onSettled(taskId, notify);
    const stopChanged = bureau.tasks.onChanged(taskId, notify);
    signal?.addEventListener('abort', notify, { once: true });
    try {
      for (;;) {
        changed = false;
        const view = await bureau.tasks.get(taskId);
        if (view === undefined) throw taskNotFound(taskId);
        if (isSettled(view.status) || signal?.aborted === true) return view;
        if (changed) continue;
        await new Promise<void>((resolve) => {
          const timer = timers.setTimeout(resolve, SETTLE_POLL_MS);
          wake = () => {
            wake = undefined;
            timers.clearTimeout(timer);
            resolve();
          };
        });
      }
    } finally {
      stopSettled();
      stopChanged();
      signal?.removeEventListener('abort', notify);
    }
  }

  async function createTask(
    message: Message,
    owner: Owner,
    version: string,
    onEffect: () => void,
  ): Promise<string> {
    if (message.contextId !== '') {
      const contextOwner = await bureau.getOwner({ kind: 'session', id: message.contextId });
      // A context another caller owns is answered as if it did not exist, before anything loads it.
      if (contextOwner !== undefined && contextOwner !== owner) {
        throw new TaskNotFoundError(`Context '${message.contextId}' was not found.`);
      }
    }
    for (const referenced of message.referenceTaskIds) {
      const view = await bureau.tasks.get(referenced);
      if (view === undefined || view.owner !== owner || view.agentName !== agentName) {
        throw invalid(
          `referenceTaskIds names '${referenced}', which is not your task on this agent.`,
        );
      }
    }
    const text = textOf(message);
    if (text === '') throw invalid('A message that starts a task must hold a text part.');
    let run;
    try {
      run = await bureau.createRun({
        agentName,
        principal: owner,
        message: text,
        ...(message.contextId === '' ? {} : { sessionId: message.contextId }),
        runCreationRequestId: `a2a:${version}:${message.messageId}`,
      });
    } catch (error) {
      if (error instanceof BureauLedgerConflictError) {
        throw invalid(
          `messageId '${message.messageId}' was already used with a different payload.`,
        );
      }
      if (error instanceof BureauError && error.code === 'NOT_FOUND') {
        throw new TaskNotFoundError(error.message);
      }
      if (error instanceof BureauError && error.code === 'BAD_REQUEST')
        throw invalid(error.message);
      throw error;
    }
    onEffect();
    await records.create({
      recordVersion: 1,
      taskId: run.id,
      contextId: run.sessionId,
      history: [historyEntryOf(message, run.id, run.sessionId)],
      replyRecorded: false,
    });
    return run.id;
  }

  /** The continuation's checks that run before anything is admitted. */
  async function checkContinuation(message: Message, owner: Owner): Promise<TaskView> {
    const view = await ownTask(message.taskId, owner);
    const record = await records.read(view.id);
    const recordedContext = record?.contextId ?? view.contextId;
    if (message.contextId !== '' && message.contextId !== recordedContext) {
      throw invalid(
        `contextId '${message.contextId}' is not the context of task '${view.id}' (${recordedContext}).`,
      );
    }
    if (isTerminal(view.status)) {
      throw new UnsupportedOperationError(
        `Task '${view.id}' is ${view.status}, so it accepts no further message.`,
      );
    }
    return view;
  }

  async function continueTask(
    message: Message,
    view: TaskView,
    owner: Owner,
    principal: Principal,
    path: 'answer' | 'input',
    onEffect: () => void,
  ): Promise<void> {
    if (path === 'answer') {
      const data = dataOf(message) as { decision?: unknown; reason?: unknown } | undefined;
      const decision = data?.decision;
      if (
        decision !== undefined &&
        decision !== 'approve' &&
        decision !== 'deny' &&
        decision !== 'reject'
      ) {
        throw invalid('decision must be "approve", "deny", or "reject".');
      }
      const reason = typeof data?.reason === 'string' ? data.reason : undefined;
      if (decision === 'reject' && (reason ?? '').trim() === '') {
        throw invalid('A reject decision requires a reason.');
      }
      const signalName = message.metadata?.[SIGNAL_NAME_METADATA_KEY];
      const callId = message.metadata?.[CALL_ID_METADATA_KEY];
      if (callId !== undefined && typeof callId !== 'string') {
        throw invalid('metadata.callId must be a string.');
      }
      const text = textOf(message);
      if (decision === undefined && text === '') {
        throw invalid('An answer needs a text part, or a data part with a decision.');
      }
      const input = tasksRespondInput.safeParse({
        taskId: view.id,
        messageId: message.messageId,
        ...(decision === undefined ? { answer: text } : { decision }),
        ...(reason === undefined ? {} : { reason }),
        ...(typeof signalName === 'string' ? { signalName } : {}),
        ...(typeof callId === 'string' ? { callId } : {}),
      });
      if (!input.success)
        throw invalid(input.error.issues[0]?.message ?? 'The answer is not valid.');
      try {
        await options.respond(principal, input.data);
        onEffect();
      } catch (error) {
        const fault = error as { code?: unknown; message?: unknown } | null;
        if (typeof fault?.code !== 'string') throw error;
        if (fault.code === 'NotFound') throw taskNotFound(view.id);
        throw invalid(
          typeof fault.message === 'string' ? fault.message : 'The answer was refused.',
        );
      }
    } else {
      const mode = message.metadata?.[DELIVERY_MODE_METADATA_KEY] ?? 'queue';
      if (mode !== 'queue' && mode !== 'steer') {
        throw invalid('metadata.deliveryMode must be "queue" or "steer".');
      }
      const text = textOf(message);
      if (text === '') throw invalid('A message to a working task needs a text part.');
      const outcome = await bureau.submitSessionInput(view.contextId, {
        id: message.messageId,
        principal: owner,
        deliveryMode: mode,
        payload: text,
      });
      if (outcome.outcome === 'not-found') throw taskNotFound(view.id);
      if (outcome.outcome === 'conflict') {
        throw invalid(
          `messageId '${message.messageId}' was already used with a different payload.`,
        );
      }
      if (outcome.outcome === 'session-terminal') {
        throw new UnsupportedOperationError(`Task '${view.id}' accepts no further message.`);
      }
      if (outcome.outcome !== 'admitted' && outcome.outcome !== 'replayed') {
        throw new UnsupportedOperationError(
          `The message could not be admitted (${outcome.outcome}).`,
        );
      }
      onEffect();
    }
    await records.update(view.id, (current) => {
      const entry = historyEntryOf(message, view.id, view.contextId);
      const already = current.history.some((held) => held['messageId'] === message.messageId);
      return already ? undefined : { ...current, history: [...current.history, entry] };
    });
  }

  async function admit(
    params: SendMessageRequest,
    context: ServerCallContext | undefined,
  ): Promise<Admitted> {
    const user = userOf(context);
    const owner = ownerOf(context);
    const message = requireMessage(params);
    const activated = activate(declared, context, message);
    const version = context?.requestedVersion ?? '1.0';
    const continuing = message.taskId !== '';
    const identity: CommandLedgerIdentity = {
      callerId: owner,
      target: continuing ? `task:${message.taskId}` : `agent:${agentName}`,
      requestId: message.messageId,
      operationVersion: `${A2A_SEND_OPERATION_VERSION}/${version}`,
    };
    const digest = digestOf(params, message, activated, declared);
    const shape: ProjectionShape = {
      historyLength: params.configuration?.historyLength,
      includeArtifacts: true,
      activated,
    };
    // The caller's own binding first: an exact retry is owed its task whatever has changed since.
    const located = await ledger.locate(identity);
    if (located.state === 'retained' && located.entry.state === 'completed') {
      if (located.entry.payloadDigest !== digest) {
        throw invalid(
          `messageId '${message.messageId}' was already used with a different payload.`,
        );
      }
      return { taskId: located.entry.result.taskId, shape };
    }

    if (params.configuration?.taskPushNotificationConfig !== undefined) {
      throw new PushNotificationNotSupportedError(
        'This agent does not deliver push notifications.',
      );
    }
    const outputModes = params.configuration?.acceptedOutputModes ?? [];
    if (outputModes.length > 0 && !outputModes.some((mode) => A2A_OUTPUT_MODES.includes(mode))) {
      throw new ContentTypeNotSupportedError(
        `This agent answers only in ${A2A_OUTPUT_MODES.join(', ')}, which acceptedOutputModes excludes.`,
      );
    }
    // A claim an earlier attempt left pending already took effect, or may have: it is finished
    // by the path it was admitted on, and the task's state since does not refuse it.
    const pending =
      located.state === 'retained' && located.entry.state === 'pending'
        ? located.entry.claim
        : undefined;
    const continued = !continuing
      ? undefined
      : pending === undefined
        ? await checkContinuation(message, owner)
        : await ownTask(message.taskId, owner);
    const path: 'answer' | 'input' | undefined =
      continued === undefined
        ? undefined
        : (pending?.path ?? (continued.status === 'input-required' ? 'answer' : 'input'));

    let claimed;
    try {
      claimed = await ledger.claim(identity, digest, path === undefined ? {} : { path });
    } catch (error) {
      if (error instanceof BureauLedgerConflictError) {
        throw invalid(
          `messageId '${message.messageId}' was already used with a different payload.`,
        );
      }
      throw error;
    }
    if (claimed.outcome === 'existing' && claimed.entry.state === 'completed') {
      return { taskId: claimed.entry.result.taskId, shape };
    }
    const entry = claimed.entry as Parameters<A2ASendLedger['release']>[0];
    let taskId: string;
    // Whether the command may have taken effect: a run created, a wait answered, an input
    // admitted. From then on the claim is kept, so a retry finishes it by the same path rather
    // than claiming afresh against the task's later state.
    let effected = false;
    try {
      if (continued === undefined) {
        taskId = await createTask(message, owner, version, () => {
          effected = true;
        });
      } else {
        await continueTask(message, continued, owner, user.principal, path ?? 'input', () => {
          effected = true;
        });
        taskId = continued.id;
      }
    } catch (error) {
      // Refused before anything was admitted: a retry may claim the binding afresh.
      if (claimed.outcome === 'claimed' && !effected) {
        await ledger.release(entry).catch(() => undefined);
      }
      throw error;
    }
    await ledger.complete(entry, { taskId });
    return { taskId, shape };
  }

  /** Follows an admitted or existing task as a stream, starting from its current snapshot. */
  function follow(
    taskId: string,
    shape: ProjectionShape,
    context: ServerCallContext | undefined,
  ): AsyncGenerator<StreamResponse> {
    return followTask({
      bureau,
      taskId,
      lastEventId: headerOf(context, 'last-event-id'),
      durableHistoryActive: shape.activated.has(DURABLE_HISTORY_EXTENSION_URI),
      snapshot: (view) => respondWith(view, shape),
      replyOf,
      timers,
      signal: context === undefined ? undefined : requestSignalOf(context),
    });
  }

  /**
   * Admits a send once per binding at a time: one that arrives while an identical send is being
   * admitted waits for that admission only, never for the first send's wait on its task, so a
   * retry with its own response controls answers by them.
   */
  async function admitOnce(
    params: SendMessageRequest,
    context: ServerCallContext | undefined,
  ): Promise<Admitted> {
    const message = params.message;
    if (message === undefined) return admit(params, context);
    const key = [
      ownerOf(context),
      message.taskId,
      message.messageId,
      context?.requestedVersion ?? '1.0',
    ].join('\u0000');
    const running = inFlight.get(key);
    if (running !== undefined) {
      await running.catch(() => undefined);
      return admit(params, context);
    }
    const attempt = admit(params, context);
    inFlight.set(key, attempt);
    try {
      return await attempt;
    } finally {
      if (inFlight.get(key) === attempt) inFlight.delete(key);
    }
  }

  return {
    async getAgentCard() {
      return options.card();
    },

    async getAuthenticatedExtendedAgentCard(_params: GetExtendedAgentCardRequest) {
      throw new UnsupportedOperationError('This agent declares no extended Agent Card.');
    },

    async sendMessage(params, context) {
      const { taskId, shape } = await admitOnce(params, context);
      const view =
        params.configuration?.returnImmediately === true
          ? await bureau.tasks.get(taskId)
          : await settledView(taskId, context === undefined ? undefined : requestSignalOf(context));
      if (view === undefined) throw taskNotFound(taskId);
      return respondWith(view, shape);
    },

    async *sendMessageStream(params, context) {
      // `returnImmediately` has no effect on a stream, which stays open through INPUT_REQUIRED
      // and AUTH_REQUIRED and closes only once the task is terminal.
      const { taskId, shape } = await admitOnce(params, context);
      yield* follow(taskId, shape, context);
    },

    async *resubscribe(params: SubscribeToTaskRequest, context) {
      const owner = ownerOf(context);
      const activated = activate(declared, context);
      const view = await ownTask(params.id, owner);
      if (isTerminal(view.status)) {
        throw new UnsupportedOperationError(
          `Task '${view.id}' is ${view.status}: read it with GetTask.`,
        );
      }
      yield* follow(view.id, { includeArtifacts: true, activated }, context);
    },

    async getTask(params: GetTaskRequest, context) {
      const owner = ownerOf(context);
      const activated = activate(declared, context);
      const view = await ownTask(params.id, owner);
      return respondWith(view, {
        historyLength: params.historyLength,
        includeArtifacts: true,
        activated,
      });
    },

    async cancelTask(params: CancelTaskRequest, context) {
      const owner = ownerOf(context);
      const activated = activate(declared, context);
      const view = await ownTask(params.id, owner);
      if (isTerminal(view.status)) {
        throw new TaskNotCancelableError(`Task '${view.id}' is ${view.status}.`);
      }
      const outcome = await bureau.tasks.cancel(view.id, cancelWait);
      if (outcome === undefined) throw taskNotFound(view.id);
      if (outcome.reason === 'already-terminal') {
        throw new TaskNotCancelableError(`Task '${view.id}' finished before it could be canceled.`);
      }
      const current = (await bureau.tasks.get(view.id)) ?? view;
      return respondWith(current, { includeArtifacts: true, activated });
    },

    async listTasks(params: ListTasksRequest, context): Promise<ListTasksResponse> {
      const owner = ownerOf(context);
      const activated = activate(declared, context);
      // proto3 reads an unset `pageSize` as 0, which means the default.
      const pageSize =
        params.pageSize === undefined || params.pageSize === 0 ? 50 : params.pageSize;
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        throw invalid('pageSize must be an integer from 1 to 100.');
      }
      if (
        params.statusTimestampAfter !== undefined &&
        Number.isNaN(Date.parse(params.statusTimestampAfter))
      ) {
        throw invalid('statusTimestampAfter must be an ISO 8601 timestamp.');
      }
      const status =
        params.status === TaskState.TASK_STATE_UNSPECIFIED
          ? undefined
          : bureauStateOf(params.status);
      if (params.status !== TaskState.TASK_STATE_UNSPECIFIED && status === undefined) {
        // A state no Bureau task reaches (`REJECTED`, `AUTH_REQUIRED`) matches nothing.
        return { tasks: [], nextPageToken: '', pageSize, totalSize: 0 };
      }
      // The snapshot holds each task's widest view (history capped, artifacts and cleanup
      // included), so a later page answers from it whatever trimming that page asks for.
      const widest: ProjectionShape = {
        historyLength: LISTED_HISTORY_LIMIT,
        includeArtifacts: true,
        activated: new Set([CLEANUP_EXTENSION_URI]),
      };
      let page;
      try {
        page = await bureau.tasks.list({
          principal: owner,
          owner,
          agentName,
          ...(params.contextId === '' ? {} : { contextId: params.contextId }),
          ...(status === undefined ? {} : { status }),
          // A2A's filter is inclusive ("greater than or equal"), and the listing's is strict:
          // timestamps have millisecond resolution, so one millisecond earlier is the same set.
          ...(params.statusTimestampAfter === undefined
            ? {}
            : {
                statusTimestampAfter: new Date(
                  inclusiveBoundary(params.statusTimestampAfter),
                ).toISOString(),
              }),
          limit: pageSize,
          ...(params.pageToken === '' ? {} : { pageToken: params.pageToken }),
          project: async (view) => boundedTask(Task.toJSON(await respondWith(view, widest))),
        });
      } catch (error) {
        if (error instanceof TaskListingTokenError) throw invalid(error.message);
        throw error;
      }
      const tasks = page.tasks.map((stored) => {
        const task = Task.fromJSON(stored);
        const history =
          params.historyLength === undefined
            ? task.history
            : params.historyLength <= 0
              ? []
              : task.history.slice(-params.historyLength);
        return {
          ...task,
          history,
          artifacts: params.includeArtifacts === true ? task.artifacts : [],
          metadata: activated.has(CLEANUP_EXTENSION_URI) ? task.metadata : undefined,
        };
      });
      return {
        tasks,
        nextPageToken: page.nextPageToken ?? '',
        pageSize,
        totalSize: page.totalSize,
      };
    },

    async createTaskPushNotificationConfig(
      _params: TaskPushNotificationConfig,
    ): Promise<TaskPushNotificationConfig> {
      throw new PushNotificationNotSupportedError(
        'This agent does not deliver push notifications.',
      );
    },

    async getTaskPushNotificationConfig(
      _params: GetTaskPushNotificationConfigRequest,
    ): Promise<TaskPushNotificationConfig> {
      throw new PushNotificationNotSupportedError(
        'This agent does not deliver push notifications.',
      );
    },

    async listTaskPushNotificationConfigs(
      _params: ListTaskPushNotificationConfigsRequest,
    ): Promise<ListTaskPushNotificationConfigsResponse> {
      throw new PushNotificationNotSupportedError(
        'This agent does not deliver push notifications.',
      );
    },

    async deleteTaskPushNotificationConfig(
      _params: DeleteTaskPushNotificationConfigRequest,
    ): Promise<void> {
      throw new PushNotificationNotSupportedError(
        'This agent does not deliver push notifications.',
      );
    },
  };
}
