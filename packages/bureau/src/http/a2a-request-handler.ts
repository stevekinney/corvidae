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
import type { SessionInputAdmissionRequest } from '@lostgradient/operative';
import {
  createDefaultRuntimeServices,
  type RuntimeServices,
  type RuntimeTimers,
} from '@lostgradient/lifecycle';
import type { Principal } from '@lostgradient/weft';
import { A2APushConfigurationConflictError, requestSignalOf } from '@lostgradient/weft/a2a';

import { installPushConfiguration } from './a2a-push-install.ts';
import { completeSend, owedInstallOf } from './a2a-push-install-claim.ts';
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
import { A2UI_EXTENSION_URI, supportedCatalogIdsOf } from '../a2ui/catalogs.ts';
import { surfaceActionOf } from './a2a-surface-actions.ts';
import { declaredExtensionsOf } from './a2a-agent-card.ts';
import {
  type AdmittedAsset,
  admitInline,
  discardAssets,
  holdsFileParts,
  holdsMedia,
  type InboundContext,
  type InboundPlan,
  type InboundProjection,
  modeAccepted,
  planInbound,
  projectionOf,
} from './a2a-inbound-parts.ts';
import { type A2ATaskRecord, type A2ATaskRecords, type A2AWireMessage } from './a2a-task-record.ts';
import {
  bureauStateOf,
  CLEANUP_EXTENSION_URI,
  isSettled,
  isTerminal,
  type ProjectionShape,
} from './a2a-task-projection.ts';
import { type TasksRespondInput, tasksRespondInput } from './management/tasks-respond-operation.ts';
import {
  COMMAND_RECEIPTS_EXTENSION_URI,
  CommandReceiptError,
  CommandTimeoutError,
  readCommandReceiptsRequest,
  receiptMetadata,
  type SendReceiptState,
} from './a2a-command-receipts.ts';
import { DURABLE_HISTORY_EXTENSION_URI, followTask } from './a2a-task-stream.ts';
import type { A2APushCaller, A2APushCheckpoints } from './a2a-push-checkpoint.ts';
import type { A2APushDelivery, A2APushProjector } from './a2a-push-projector.ts';
import { INPUT_FORM_SUBMIT_EVENT } from '../a2ui/input-form.ts';
import { formsOf, formSurfaceId, type WaitForm } from './a2a-input-forms.ts';
import { createTaskReader } from './a2a-task-reader.ts';
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
export type A2ASendClaim = {
  readonly path?: 'answer' | 'input' | undefined;
  /** For a send that embeds a push configuration: whether it owes an install before it completes. */
  readonly pushOwed?: boolean | undefined;
  /** For a send that embeds a push configuration: the cursor its checkpoint starts at. */
  readonly pushCursor?: string | undefined;
  /**
   * For a send whose inline file bytes were admitted as assets: those assets, in part order.
   * Admission happens before the claim, so a retry of a claim left pending reads them back
   * instead of admitting the bytes a second time.
   */
  readonly assets?: readonly AdmittedAsset[] | undefined;
  /**
   * For a send with files: their authorized projection (content and history form), decided once
   * before the claim. A retry of a claim left pending completes from it and never reads the
   * assets again, so an asset that expired in between cannot fail it.
   */
  readonly inbound?: InboundProjection | undefined;
  /**
   * For an A2UI surface action: the answer it was admitted as, derived once before the claim. A
   * retry of a claim left pending replays it instead of reading the action against the task's
   * live state, which the answer has already moved past.
   */
  readonly answer?: TasksRespondInput | undefined;
};

/** Which path a send took: a new task, an answer to a wait, or input to a working task. */
type SendPath = 'create' | 'answer' | 'input';

/** A command's receipt as its response reports it. */
type Receipt = {
  readonly path: SendPath;
  readonly state: SendReceiptState;
  readonly commandId: string;
  readonly reason?: string | undefined;
};

/** A send once admitted: the task it created or continued, and how its responses show it. */
type Admitted = {
  readonly taskId: string;
  readonly shape: ProjectionShape;
  readonly receipt: Receipt;
  /** Epoch milliseconds by which a blocking send must be answered, if the command set one. */
  readonly deadline: number | undefined;
};

/**
 * A message's file parts once admitted: the native content the run receives (`undefined` for a
 * message of text alone), and the message as the task's A2A history keeps it, which names an
 * asset by its route and never holds bytes.
 */
type Inbound = {
  readonly content: InboundProjection['content'] | undefined;
  readonly history: Message;
};

/** What a completed send's ledger entry holds: the task, and the receipt the command earned. */
export type A2ASendResult = {
  readonly taskId: string;
  /** Absent in an entry written before receipts were recorded; read as a new task's `applied`. */
  readonly path?: SendPath | undefined;
  readonly state?: SendReceiptState | undefined;
  readonly reason?: string | undefined;
  /** The send's authorized projection, so a replay delivers the same input. */
  readonly inbound?: InboundProjection | undefined;
};

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
  | 'getSession'
  | 'getOwner'
  | 'submitSessionInput'
  | 'eventHistory'
  | 'getReview'
  | 'subscribeEventHistory'
  | 'addEventListener'
  | 'removeEventListener'
  | 'assets'
  | 'surfaces'
> & {
  readonly tasks: Pick<
    TaskRegistry,
    | 'get'
    | 'record'
    | 'cancel'
    | 'list'
    | 'onSettled'
    | 'onChanged'
    | 'recordAdmission'
    | 'recordSettled'
  >;
};

/** What {@link createBureauA2ARequestHandler} needs. */
export type BureauA2ARequestHandlerOptions = {
  /** The agent this handler serves: every task it reads or creates is this agent's. */
  readonly agentName: string;
  readonly card: () => AgentCard;
  readonly bureau: A2ABureau;
  readonly records: A2ATaskRecords;
  /** The handler's public origin and base path: generated media is served from its asset route. */
  readonly publicUrl: string;
  readonly ledger: A2ASendLedger;
  /** Answers a task's open wait as `principal`: `bureau.tasks.respond`'s own body. */
  readonly respond: (principal: Principal, input: TasksRespondInput) => Promise<unknown>;
  /** The timers a blocking send's safety-net poll runs on. Defaults to the process's own. */
  readonly timers?: RuntimeTimers | undefined;
  /** The clock a command's deadline is read against, and the identifiers an expired task takes. */
  readonly runtime?: Pick<RuntimeServices, 'clock' | 'identifiers'> | undefined;
  /** How long a cancel waits for the run's cleanup to acknowledge before it answers. */
  readonly cancelWaitMilliseconds?: number;
  /**
   * Whether the agent takes a new task: `false` once it is withdrawn. A withdrawn agent's tasks
   * are still served, and an exact retry of a send whose binding is retained still resolves to
   * its original task. Defaults to always.
   */
  readonly acceptsNewTasks?: (() => boolean) | undefined;
  /**
   * Push notification delivery (COR-1543). Served only when the card also declares
   * `pushNotifications`; a handler without both answers every push operation with
   * `PushNotificationNotSupportedError`.
   */
  readonly push?:
    | {
        readonly delivery: A2APushDelivery;
        readonly checkpoints: A2APushCheckpoints;
        readonly projector: A2APushProjector;
        readonly ready: Promise<void>;
      }
    | undefined;
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

function requireMessage(params: SendMessageRequest, inputModes: readonly string[]): Message {
  const message = params.message;
  if (message === undefined || message.messageId === '') {
    throw invalid('message.messageId is required.');
  }
  if (message.parts.length === 0) throw invalid('message.parts must hold at least one part.');
  if (message.role !== Role.ROLE_USER)
    throw invalid('An inbound message must have role ROLE_USER.');
  for (const part of message.parts) {
    if (part.mediaType !== '' && !modeAccepted(inputModes, part.mediaType)) {
      throw new ContentTypeNotSupportedError(
        `Media type '${part.mediaType}' is not supported; this agent accepts ${inputModes.join(', ')}.`,
      );
    }
    const kind = part.content?.$case;
    if (kind !== 'text' && kind !== 'data' && kind !== 'url' && kind !== 'raw') {
      throw new ContentTypeNotSupportedError(
        `An empty part is not supported; this agent accepts ${inputModes.join(', ')}.`,
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

/** The receipt a session input's admission state reads as. */
function inputReceiptState(state: string): SendReceiptState {
  switch (state) {
    case 'accepted':
    case 'queued':
      return 'accepted';
    case 'promoted':
      return 'applied';
    case 'expired':
      return 'expired';
    case 'superseded':
      return 'superseded';
    default:
      return 'failed';
  }
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

/**
 * The form submission a message makes, or `undefined` when it makes none: its data part, when the
 * wait it addresses (named by `metadata.signalName`, or the only open wait) asks for a form. Whether the data satisfies that schema is decided when the answer is delivered, by the
 * same check `bureau.tasks.respond` applies to every caller.
 */
function formSubmissionOf(
  message: Message,
  view: TaskView,
  forms: readonly WaitForm[],
): { readonly data: Record<string, unknown>; readonly signalName: string } | undefined {
  const named = message.metadata?.[SIGNAL_NAME_METADATA_KEY];
  const addressed =
    typeof named === 'string'
      ? forms.find((form) => form.signalName === named)
      : view.openWaits.length === 1
        ? forms[0]
        : undefined;
  if (addressed === undefined) return undefined;
  const data = dataOf(message);
  if (data === undefined) return undefined;
  return { data: submittedValuesOf(data, addressed), signalName: addressed.signalName };
}

/**
 * The form values a data part carries: the standard A2UI client-to-server envelope (an array
 * holding one `action` message, the values under `action.context`), or the values as a bare JSON
 * object. The envelope is checked for its shape, its event name, and the surface it was raised on.
 */
function submittedValuesOf(data: unknown, form: WaitForm): Record<string, unknown> {
  if (Array.isArray(data)) {
    const actions = data.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === 'object' && entry !== null && 'action' in entry,
    );
    const action: unknown = actions.length === 1 ? actions[0]?.['action'] : undefined;
    if (typeof action !== 'object' || action === null || Array.isArray(action)) {
      throw invalid('A form submission array must hold one A2UI `action` message.');
    }
    const { name, surfaceId, context } = action as Record<string, unknown>;
    if (name !== INPUT_FORM_SUBMIT_EVENT) {
      throw invalid(`The A2UI action must be "${INPUT_FORM_SUBMIT_EVENT}".`);
    }
    if (surfaceId !== undefined && surfaceId !== formSurfaceId(form.reviewId)) {
      throw invalid('The A2UI action was raised on a surface that is not this wait\u2019s form.');
    }
    if (typeof context !== 'object' || context === null || Array.isArray(context)) {
      throw invalid('The A2UI action must carry the form values as an object in `context`.');
    }
    return context as Record<string, unknown>;
  }
  if (typeof data !== 'object' || data === null) {
    throw invalid('A form submission must be a JSON object.');
  }
  return data as Record<string, unknown>;
}

/** A continuation as the boundary parsed it: everything it needs, validated before any effect. */
type ContinuationCommand =
  | { readonly path: 'answer'; readonly input: TasksRespondInput }
  | { readonly path: 'input'; readonly mode: 'queue' | 'steer'; readonly text: string };

/**
 * The one place a continuation is validated: a malformed answer or input is refused here, before
 * the ledger is touched, so no handler downstream re-checks it.
 */
function parseContinuation(
  message: Message,
  path: 'answer' | 'input',
  view: TaskView,
  forms: readonly WaitForm[],
  inputModes: readonly string[],
): ContinuationCommand {
  const taskId = view.id;
  const text = textOf(message);
  if (path === 'input') {
    const mode = message.metadata?.[DELIVERY_MODE_METADATA_KEY] ?? 'queue';
    if (mode !== 'queue' && mode !== 'steer') {
      throw invalid('metadata.deliveryMode must be "queue" or "steer".');
    }
    if (text === '' && !holdsMedia(message, inputModes)) {
      throw invalid('A message to a working task needs a text part.');
    }
    return { path, mode, text };
  }
  // An answer is text, a decision, or a form's values: a file has no place in it.
  if (holdsFileParts(message)) {
    throw new ContentTypeNotSupportedError(
      `A file part is not read as an answer; this agent accepts ${inputModes.join(', ')}.`,
    );
  }
  const form = formSubmissionOf(message, view, forms);
  if (form !== undefined) {
    const submitted = tasksRespondInput.safeParse({
      taskId,
      messageId: message.messageId,
      data: form.data,
      signalName: form.signalName,
    });
    if (!submitted.success) {
      throw invalid(submitted.error.issues[0]?.message ?? 'The submission is not valid.');
    }
    return { path, input: submitted.data };
  }
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
  if (decision === undefined && text === '') {
    throw invalid('An answer needs a text part, or a data part with a decision.');
  }
  const input = tasksRespondInput.safeParse({
    taskId,
    messageId: message.messageId,
    ...(decision === undefined ? { answer: text } : { decision }),
    ...(reason === undefined ? {} : { reason }),
    ...(typeof signalName === 'string' ? { signalName } : {}),
    ...(typeof callId === 'string' ? { callId } : {}),
  });
  if (!input.success) throw invalid(input.error.issues[0]?.message ?? 'The answer is not valid.');
  return { path, input: input.data };
}

/**
 * Refuses the replay of a recorded projection to a credential without the scopes the first
 * attempt needed: `bureau.assets:read` for any asset it names (answered as a missing asset, so
 * the scope's absence is not told apart), and `bureau.assets:write` where bytes were admitted.
 */
function refuseWithoutScopes(
  projection: InboundProjection,
  admittedAssets: readonly AdmittedAsset[] | undefined,
  context: InboundContext,
): void {
  const named = projection.content.flatMap((part) =>
    'source' in part && part.source.kind === 'managed-asset' ? [part.source.assetId] : [],
  );
  if (named.length > 0 && !context.mayReadAssets) {
    throw invalid(`Asset '${named[0]}' was not found.`);
  }
  if ((admittedAssets?.length ?? 0) > 0 && !context.mayWriteAssets) {
    throw invalid('Sending file bytes requires bureau.assets:write.');
  }
}

/** Whether an error is the handler's own refusal of a send: raised before anything took effect. */
function isRefusal(error: unknown): boolean {
  return (
    error instanceof RequestMalformedError ||
    error instanceof TaskNotFoundError ||
    error instanceof ContentTypeNotSupportedError ||
    error instanceof UnsupportedOperationError ||
    error instanceof CommandReceiptError
  );
}

/** Creates the request handler that serves one published agent. */
export function createBureauA2ARequestHandler(
  options: BureauA2ARequestHandlerOptions,
): A2ARequestHandler {
  const { agentName, bureau, records, ledger } = options;
  const cancelWait = options.cancelWaitMilliseconds ?? 0;
  const timers = options.timers ?? createDefaultRuntimeServices().timers;
  const runtime = options.runtime ?? createDefaultRuntimeServices();
  const declared = declaredExtensionsOf(options.card());
  const inputModes = options.card().defaultInputModes;
  const assets = bureau.assets;

  /** What reading a caller's file parts needs: their scopes, owner, and the card's input modes. */
  function inboundContext(principal: Principal, owner: Owner): InboundContext {
    const authenticated = principal.method !== 'unauthenticated';
    return {
      publicUrl: options.publicUrl,
      assets,
      owner,
      mayReadAssets: authenticated && principal.hasScope('bureau.assets:read'),
      mayWriteAssets: authenticated && principal.hasScope('bureau.assets:write'),
      inputModes,
    };
  }
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

  const reader = createTaskReader({ bureau, records, publicUrl: options.publicUrl });
  const replyOf = (view: TaskView) => reader.replyOf(view);
  const push = options.card().capabilities?.pushNotifications === true ? options.push : undefined;

  /** The push support the card declares, or the answer a deployment without it gives. */
  function requirePush(): NonNullable<typeof push> {
    if (push === undefined) {
      throw new PushNotificationNotSupportedError(
        'This agent does not deliver push notifications.',
      );
    }
    return push;
  }

  function callerOf(context: ServerCallContext | undefined): A2APushCaller {
    const user = userOf(context);
    return { authenticated: user.isAuthenticated, userName: user.userName };
  }

  /**
   * Installs a push configuration on a task and starts its checkpoint at `cursor`, under the
   * task's fence (see `a2a-push-install.ts`). `held` is set by a caller that already holds it.
   */
  async function installPush(
    taskId: string,
    configuration: TaskPushNotificationConfig,
    context: ServerCallContext | undefined,
    cursor: string,
    held = false,
  ): Promise<TaskPushNotificationConfig> {
    const { delivery, checkpoints, projector, ready } = requirePush();
    // Recovery settles every pending checkpoint it finds, so an install starts after it: a
    // recovery that read a checkpoint this install reuses could otherwise remove it.
    await ready;
    const install = () =>
      installPushConfiguration(
        { store: delivery.sender.pushStore, checkpoints, watch: (id) => projector.watch(id) },
        {
          taskId,
          configuration,
          context: context as ServerCallContext,
          caller: callerOf(context),
          cursor,
        },
      );
    return held ? install() : projector.fence(taskId, install);
  }

  /** The task as one response shows it, with the command's receipt when it has one. */
  async function respondWith(
    view: TaskView,
    shape: ProjectionShape,
    receipt?: Receipt,
  ): Promise<Task> {
    const { task, record } = await reader.read(view, shape);
    if (receipt !== undefined && shape.activated.has(COMMAND_RECEIPTS_EXTENSION_URI)) {
      task.metadata = {
        ...task.metadata,
        [COMMAND_RECEIPTS_EXTENSION_URI]: receiptMetadata(
          currentState(receipt, view),
          receipt.commandId,
          revisionOf(view, record),
          receipt.reason,
        ),
      };
    }
    return task;
  }

  /**
   * The task's revision, from durable state alone so every instance computes the same one: its
   * status, the waits open on it, and how many messages its A2A history holds (each admitted
   * continuation adds one). A process that does not hold the run reads it exactly as one that does.
   */
  function revisionOf(view: TaskView, record: A2ATaskRecord | undefined): string {
    const waits = view.openWaits
      .map((wait) => (wait.kind === 'human-wait' ? wait.reviewId : wait.callId))
      .toSorted();
    return `${view.status}:${waits.join(',')}:${record?.history.length ?? 0}`;
  }

  /**
   * How far a command has gone now. A new task's command is `accepted` until its run starts,
   * `applied` once it has, and `observed` once the task's end is in its history; an answer or an
   * input keeps the state its admission reported, which a retry reads again.
   */
  function currentState(receipt: Receipt, view: TaskView): SendReceiptState {
    if (receipt.path !== 'create' || receipt.state === 'expired') return receipt.state;
    if (isTerminal(view.status)) return 'observed';
    return view.status === 'submitted' ? 'accepted' : 'applied';
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

  /**
   * {@link settledView}, bounded by the command's deadline: a blocking send its deadline
   * overtakes is a `TIMEOUT` error, and the task goes on.
   */
  async function settledUntil(
    taskId: string,
    context: ServerCallContext | undefined,
    deadline: number | undefined,
    commandId: string,
  ): Promise<TaskView> {
    const signal = context === undefined ? undefined : requestSignalOf(context);
    if (deadline === undefined) return settledView(taskId, signal);
    const controller = new AbortController();
    let timedOut = false;
    const timer = timers.setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      Math.max(0, deadline - runtime.clock.now()),
    );
    const forward = () => controller.abort();
    signal?.addEventListener('abort', forward, { once: true });
    try {
      const view = await settledView(taskId, controller.signal);
      // Once the deadline has fired, only a settlement that happened by it counts.
      if (timedOut && !(isSettled(view.status) && Date.parse(view.updatedAt) <= deadline)) {
        throw new CommandTimeoutError('The command’s deadline passed before the task settled.', {
          commandId,
          taskId,
        });
      }
      return view;
    } finally {
      timers.clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    }
  }

  /** The checks a message that starts a task passes before anything is admitted. Resolves its text. */
  async function checkNewTask(message: Message, owner: Owner): Promise<string> {
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
    if (text === '' && !holdsMedia(message, inputModes)) {
      throw invalid('A message that starts a task must hold a text part.');
    }
    return text;
  }

  async function createTask(
    message: Message,
    owner: Owner,
    version: string,
    onEffect: () => void,
    inbound: Inbound,
  ): Promise<string> {
    const text = await checkNewTask(message, owner);
    let run;
    try {
      run = await bureau.createRun({
        agentName,
        principal: owner,
        // A message of text alone starts the run as a string; one with files starts it as a row
        // whose id follows from the `messageId`, so an exact retry appends the same row.
        ...(inbound.content === undefined
          ? { message: text }
          : {
              appendMessages: [
                {
                  // The id follows from the whole command (version, agent, message), not the bare
                  // `messageId`: the same id sent to two agents in one context is two commands, and
                  // their rows must not collide. A retry derives the same id.
                  id: `a2a:${version}:${agentName}:${message.messageId}`,
                  role: 'user' as const,
                  content: inbound.content,
                  position: 0,
                  createdAt: new Date(runtime.clock.now()).toISOString(),
                  metadata: {},
                  hidden: false,
                },
              ],
            }),
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
      // A failure that is not a refusal may have come after the run took its row: the assets
      // that row names must outlive it, so the claim keeps them for the retry to deliver.
      if (inbound.content !== undefined) onEffect();
      throw error;
    }
    onEffect();
    await records.create({
      recordVersion: 1,
      taskId: run.id,
      contextId: run.sessionId,
      history: [historyEntryOf(inbound.history, run.id, run.sessionId)],
      replyRecorded: false,
    });
    recordReplyWhenSettled(run.id);
    return run.id;
  }

  /**
   * Records a task's reply (its generated media included) in its A2A record when the task
   * settles, on the instance that ran it: a restart before anyone reads the task then loses
   * nothing. A failure leaves the lazy fold of a later read to do it.
   */
  function recordReplyWhenSettled(taskId: string): void {
    let stop: (() => void) | undefined;
    // Returned to the registry, so the settlement that announced it (and a shutdown's idle) waits
    // for the fold; a failure leaves the lazy fold of a later read to do it.
    const record = async (view: TaskView): Promise<void> => {
      stop?.();
      await reader.recordSettled(view).catch(() => undefined);
    };
    stop = bureau.tasks.onSettled(taskId, record);
    // A task that settled before the listener was added is not announced.
    void (async () => {
      const view = await bureau.tasks.get(taskId);
      if (view !== undefined && isTerminal(view.status)) await record(view);
    })().catch(() => undefined);
  }

  /**
   * A task whose creating command's deadline passed before it could start: recorded as failed
   * with a deadline reason, and no run is created for it.
   */
  async function createExpiredTask(
    message: Message,
    owner: Owner,
    version: string,
    onEffect: () => void,
  ): Promise<string> {
    await checkNewTask(message, owner);
    // The identifier follows from the command, so a retry after a lost receipt finds this task
    // instead of recording a second one.
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${owner}\0${agentName}\0${version}\0${message.messageId}`),
    );
    const taskId = `agent-run-expired-${[...new Uint8Array(digest).slice(0, 16)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')}`;
    // A retry after a failed step resumes it: each step below is skipped once it has happened.
    // The task's own record keeps the message, so there is no side record to outlive its retention.
    const existing = await bureau.tasks.get(taskId);
    // From here the task may exist: a failure later keeps the claim, so a retry finishes this
    // task instead of claiming afresh.
    onEffect();
    if (existing === undefined) {
      await bureau.tasks.recordAdmission({
        taskId,
        contextId:
          message.contextId === '' ? runtime.identifiers.next('session') : message.contextId,
        incarnation: '',
        agentName,
        owner,
        message: textOf(message),
      });
    }
    if (existing === undefined || !['completed', 'failed', 'canceled'].includes(existing.status)) {
      await bureau.tasks.recordSettled(taskId, {
        at: new Date(runtime.clock.now()).toISOString(),
        status: 'failed',
        finishReason: 'deadline-exceeded',
        message: 'The command’s deadline passed before the task started.',
      });
    }
    return taskId;
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
    // A context deleted and created again under the same id is a new one: a task of the earlier
    // incarnation does not continue in it, whatever state the task is in.
    const stored = await bureau.tasks.record(view.id);
    if (stored !== undefined && stored.incarnation !== '') {
      const session = await bureau.getSession(view.contextId);
      if ((session?.incarnation ?? '') !== stored.incarnation) {
        throw invalid(
          `Task '${view.id}' belongs to an earlier incarnation of context '${view.contextId}', which was deleted.`,
        );
      }
    }
    if (isTerminal(view.status)) {
      throw new UnsupportedOperationError(
        `Task '${view.id}' is ${view.status}, so it accepts no further message.`,
      );
    }
    return view;
  }

  /** Admits a message to a working task's mailbox; the same message again replays its receipt. */
  async function submitInput(
    message: Message,
    view: TaskView,
    owner: Owner,
    deadline: number | undefined,
    command: Extract<ContinuationCommand, { path: 'input' }>,
    inbound: Inbound,
  ) {
    const outcome = await bureau.submitSessionInput(view.contextId, {
      id: message.messageId,
      principal: owner,
      deliveryMode: command.mode,
      payload: (inbound.content ?? command.text) as SessionInputAdmissionRequest['payload'],
      ...(deadline === undefined ? {} : { expiresAt: new Date(deadline).toISOString() }),
    });
    if (outcome.outcome === 'not-found') throw taskNotFound(view.id);
    if (outcome.outcome === 'conflict') {
      throw invalid(`messageId '${message.messageId}' was already used with a different payload.`);
    }
    if (outcome.outcome === 'session-terminal') {
      throw new UnsupportedOperationError(`Task '${view.id}' accepts no further message.`);
    }
    if (outcome.outcome !== 'admitted' && outcome.outcome !== 'replayed') {
      throw new UnsupportedOperationError(
        `The message could not be admitted (${outcome.outcome}).`,
      );
    }
    return outcome;
  }

  /** The message's content for the run and its form in the task's history, as recorded. */
  function inboundOf(message: Message, projection: InboundProjection | undefined): Inbound {
    if (projection === undefined) return { content: undefined, history: message };
    return {
      content: projection.content,
      history: Message.fromJSON(projection.history),
    };
  }

  /**
   * A retried input's receipt as the mailbox holds it now (queued, promoted, superseded,
   * expired): the ledger kept only the state at admission. Whatever cannot be read again keeps
   * the ledger's.
   */
  async function currentInputResult(
    message: Message,
    owner: Owner,
    deadline: number | undefined,
    stored: A2ASendResult,
  ): Promise<A2ASendResult> {
    if (stored.path !== 'input' || stored.reason !== undefined) return stored;
    try {
      const view = await ownTask(stored.taskId, owner);
      const command = parseContinuation(message, 'input', view, [], inputModes);
      if (command.path !== 'input') return stored;
      // The replay delivers the input it delivered, from the projection the first attempt recorded.
      const inbound = inboundOf(message, stored.inbound);
      const outcome = await submitInput(message, view, owner, deadline, command, inbound);
      return { ...stored, state: inputReceiptState(outcome.receipt.state) };
    } catch {
      return stored;
    }
  }

  async function continueTask(
    message: Message,
    view: TaskView,
    owner: Owner,
    principal: Principal,
    deadline: number | undefined,
    command: ContinuationCommand,
    onEffect: () => void,
    inbound: Inbound,
  ): Promise<{ readonly path: SendPath; readonly state: SendReceiptState }> {
    let answered: { readonly path: SendPath; readonly state: SendReceiptState };
    if (command.path === 'answer') {
      try {
        const result = (await options.respond(principal, command.input)) as { receipt?: unknown };
        onEffect();
        answered = {
          path: 'answer',
          state: result.receipt === 'superseded' ? 'superseded' : 'applied',
        };
      } catch (error) {
        const fault = error as { code?: unknown; message?: unknown } | null;
        if (typeof fault?.code !== 'string') throw error;
        if (fault.code === 'NotFound') throw taskNotFound(view.id);
        throw invalid(
          typeof fault.message === 'string' ? fault.message : 'The answer was refused.',
        );
      }
    } else {
      const outcome = await submitInput(message, view, owner, deadline, command, inbound);
      onEffect();
      answered = { path: 'input', state: inputReceiptState(outcome.receipt.state) };
    }
    await records.update(view.id, (current) => {
      const entry = historyEntryOf(inbound.history, view.id, view.contextId);
      const already = current.history.some((held) => held['messageId'] === message.messageId);
      return already ? undefined : { ...current, history: [...current.history, entry] };
    });
    return answered;
  }

  /**
   * A send that continues a task and carries an inline push configuration runs under that task's
   * fence, from the preflight check to the install, so a concurrent create or delete of the same
   * configuration cannot land between the check and the install it vouched for.
   */
  async function admit(
    params: SendMessageRequest,
    context: ServerCallContext | undefined,
  ): Promise<Admitted> {
    const taskId = params.message?.taskId ?? '';
    if (
      push === undefined ||
      taskId === '' ||
      params.configuration?.taskPushNotificationConfig === undefined
    ) {
      return admitUnfenced(params, context, false);
    }
    await push.ready;
    return push.projector.fence(taskId, () => admitUnfenced(params, context, true));
  }

  async function admitUnfenced(
    params: SendMessageRequest,
    context: ServerCallContext | undefined,
    fenced: boolean,
  ): Promise<Admitted> {
    const user = userOf(context);
    const owner = ownerOf(context);
    const message = requireMessage(params, inputModes);
    // Snapshotted before the first await: the request object is the caller's.
    const embedded = params.configuration?.taskPushNotificationConfig;
    const inlinePush = embedded === undefined ? undefined : structuredClone(embedded);
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
      supportedCatalogIds: supportedCatalogIdsOf(
        message.metadata?.[A2UI_CLIENT_CAPABILITIES_METADATA_KEY],
      ),
    };
    const receiptsActive = activated.has(COMMAND_RECEIPTS_EXTENSION_URI);
    // Extension fields are ignored unless the request activated the extension.
    const request = receiptsActive
      ? readCommandReceiptsRequest(message.metadata)
      : { expectedRevision: undefined, deadline: undefined };
    const admitted = (result: A2ASendResult): Admitted => ({
      taskId: result.taskId,
      shape,
      receipt: {
        path: result.path ?? 'create',
        state: result.state ?? 'applied',
        commandId: message.messageId,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      },
      deadline: request.deadline,
    });
    /** The answer to a reused `messageId`: typed for a client that activated receipts. */
    const conflict = (original: A2ASendResult | undefined): Error => {
      const text = `messageId '${message.messageId}' was already used with a different payload.`;
      if (!receiptsActive) return invalid(text);
      return new CommandReceiptError('CONFLICT', text, {
        commandId: message.messageId,
        ...(original === undefined
          ? {}
          : { taskId: original.taskId, receiptState: original.state ?? 'applied' }),
      });
    };
    // The caller's own binding first: an exact retry is owed its task whatever has changed since.
    const located = await ledger.locate(identity);
    if (located.state === 'retained' && located.entry.state === 'completed') {
      if (located.entry.payloadDigest !== digest) throw conflict(located.entry.result);
      return admitted(
        await currentInputResult(message, owner, request.deadline, located.entry.result),
      );
    }
    // A claim an earlier attempt left pending already took effect, or may have: it is finished
    // by the path it was admitted on, and the task's state since does not refuse it.
    const pending =
      located.state === 'retained' && located.entry.state === 'pending'
        ? located.entry.claim
        : undefined;
    if (!continuing && pending === undefined && options.acceptsNewTasks?.() === false) {
      throw new TaskNotFoundError(`Agent '${agentName}' was withdrawn and takes no new task.`);
    }

    if (inlinePush !== undefined) {
      const { delivery } = requirePush();
      // Refused before the claim: a configuration the store refuses once the input is applied
      // would leave a pending claim whose every exact retry repeats the effect and throws. The
      // store's conflict is answered as -32602.
      if (continuing) {
        try {
          await delivery.sender.pushStore.check(
            message.taskId,
            context as ServerCallContext,
            structuredClone(inlinePush),
          );
        } catch (error) {
          if (error instanceof A2APushConfigurationConflictError) throw invalid(error.message);
          throw error;
        }
      }
    }
    const outputModes = params.configuration?.acceptedOutputModes ?? [];
    const answers = options.card().defaultOutputModes;
    if (outputModes.length > 0 && !outputModes.some((mode) => modeAccepted(answers, mode))) {
      throw new ContentTypeNotSupportedError(
        `This agent answers only in ${answers.join(', ')}, which acceptedOutputModes excludes.`,
      );
    }
    const continued = !continuing
      ? undefined
      : pending === undefined
        ? await checkContinuation(message, owner)
        : await ownTask(message.taskId, owner);
    const path: 'answer' | 'input' | undefined =
      continued === undefined
        ? undefined
        : (pending?.path ?? (continued.status === 'input-required' ? 'answer' : 'input'));
    // An A2UI action on one of the task's surfaces is admitted by the surface store first; the
    // answer it stands for then travels the same path as any other answer.
    const surfaceAction =
      continued === undefined || path !== 'answer' || pending?.answer !== undefined
        ? undefined
        : await surfaceActionOf({ bureau, message, view: continued, activated });
    if (surfaceAction?.ok === false) {
      throw surfaceAction.stale === undefined
        ? invalid(surfaceAction.message)
        : new CommandReceiptError('STALE_REVISION', surfaceAction.message, {
            taskId: message.taskId,
            surfaceId: surfaceAction.stale.surfaceId,
            currentRevision: String(surfaceAction.stale.currentRevision),
          });
    }
    const answerOwed =
      pending?.answer ?? (surfaceAction?.ok === true ? surfaceAction.input : undefined);
    const command: ContinuationCommand | undefined =
      answerOwed !== undefined
        ? { path: 'answer', input: answerOwed }
        : continued === undefined || path === undefined
          ? undefined
          : parseContinuation(
              message,
              path,
              continued,
              await formsOf(bureau, continued),
              inputModes,
            );
    // The message's parts, read and authorized before anything is admitted. An answer to a wait
    // reads no file, so only a new task and input to a working task plan any.
    const inboundContextOfCaller = inboundContext(user.principal, owner);
    // A pending claim that recorded its projection completes from it: the assets are not read again.
    const plan: InboundPlan | undefined =
      pending?.inbound === undefined && (continued === undefined || command?.path === 'input')
        ? await planInbound(message, inboundContextOfCaller)
        : undefined;
    // A pending claim's effect may already have moved the revision it was checked against.
    if (
      pending === undefined &&
      continued !== undefined &&
      request.expectedRevision !== undefined
    ) {
      const current = revisionOf(continued, await records.read(continued.id));
      if (current !== request.expectedRevision) {
        throw new CommandReceiptError(
          'STALE_REVISION',
          `expectedRevision ${request.expectedRevision} is stale.`,
          {
            commandId: message.messageId,
            taskId: continued.id,
            expectedRevision: request.expectedRevision,
            currentRevision: current,
          },
        );
      }
    }

    // The install this send owes is decided here, once, and recorded in the claim: a retry of a
    // claim left pending reads it back, so it installs the same configuration at the same cursor
    // whatever the task has become since.
    const passed = () => request.deadline !== undefined && runtime.clock.now() >= request.deadline;
    // Inline bytes are admitted as the caller's assets before the claim, and the claim records
    // them: a retry of a claim left pending reads them back instead of admitting the bytes again.
    // An expired command applies nothing, so it admits nothing; and admission can outlast the
    // deadline (a scan, an extraction), so the deadline is read again after it, and a command it
    // overtook discards what it admitted and takes the expired path.
    let mine: readonly AdmittedAsset[] =
      plan === undefined || plan.inlineCount === 0 || pending?.assets !== undefined || passed()
        ? []
        : await admitInline(plan, inboundContextOfCaller);
    if (mine.length > 0 && passed()) {
      await discardAssets(assets, owner, mine);
      mine = [];
    }
    const expired = passed();
    const owed = owedInstallOf({
      hasInline: inlinePush !== undefined,
      continuing: continued !== undefined,
      expired,
      pending,
      tail:
        inlinePush === undefined || continued === undefined || pending?.pushOwed !== undefined
          ? undefined
          : await push?.projector.tailOf(continued.id),
    });
    const discardMine = () => discardAssets(assets, owner, mine);
    // What this send delivers is decided once, here, and the claim records it.
    const projection =
      plan === undefined || expired
        ? undefined
        : projectionOf(message, plan, mine, options.publicUrl);
    let claimed;
    try {
      claimed = await ledger.claim(identity, digest, {
        ...(path === undefined ? {} : { path }),
        ...(owed === undefined ? {} : owed),
        ...(mine.length === 0 ? {} : { assets: mine }),
        ...(projection === undefined ? {} : { inbound: projection }),
        ...(answerOwed === undefined ? {} : { answer: answerOwed }),
      });
    } catch (error) {
      await discardMine();
      if (error instanceof BureauLedgerConflictError) {
        const original = await ledger.locate(identity);
        throw conflict(
          original.state === 'retained' && original.entry.state === 'completed'
            ? original.entry.result
            : undefined,
        );
      }
      throw error;
    }
    // The assets this send delivers are the claim's: another attempt's claim wins over this one's.
    const claimedAssets = claimed.entry.claim.assets;
    if (claimed.outcome === 'existing') await discardMine();
    if (claimed.outcome === 'existing' && claimed.entry.state === 'completed') {
      return admitted(
        await currentInputResult(message, owner, request.deadline, claimed.entry.result),
      );
    }
    const delivered: readonly AdmittedAsset[] = claimedAssets ?? [];
    const recorded = claimed.entry.claim.inbound;
    const entry = claimed.entry as Parameters<A2ASendLedger['release']>[0];
    let result: A2ASendResult;
    // Whether the command may have taken effect: a run created, a wait answered, an input
    // admitted. From then on the claim is kept, so a retry finishes it by the same path rather
    // than claiming afresh against the task's later state.
    let effected = false;
    let installed = false;
    const markEffected = () => {
      effected = true;
    };
    let inbound: Inbound = { content: undefined, history: message };
    try {
      // Everything from here may throw with the claim held, so it is inside the try that releases
      // it. An expired command applies nothing and admitted nothing: it reads no assets.
      if (recorded !== undefined) {
        // A projection is replayed without reading its assets again, but never to a credential
        // that may not use them: the scopes are this request's own.
        refuseWithoutScopes(recorded, claimedAssets, inboundContextOfCaller);
        inbound = inboundOf(message, recorded);
      } else if (!expired && plan?.hasMedia === true) {
        throw invalid(
          `messageId '${message.messageId}' was already used with a different payload.`,
        );
      }
      if (continued === undefined) {
        result = expired
          ? {
              taskId: await createExpiredTask(message, owner, version, markEffected),
              path: 'create',
              state: 'expired',
              reason: 'deadline-exceeded',
            }
          : {
              taskId: await createTask(message, owner, version, markEffected, inbound),
              path: 'create',
              state: 'applied',
            };
      } else if (expired && pending === undefined) {
        // An expired continuation leaves the task as it is, still waiting if it was.
        result = {
          taskId: continued.id,
          path: 'input',
          state: 'expired',
          reason: 'deadline-exceeded',
        };
      } else {
        const answered = await continueTask(
          message,
          continued,
          owner,
          user.principal,
          request.deadline,
          command as ContinuationCommand,
          markEffected,
          inbound,
        );
        result = { taskId: continued.id, ...answered };
      }
      // Installed before the binding completes, so an exact retry of a send that crashed here
      // runs this again and finds the one configuration.
      if (owed?.pushOwed === true && inlinePush !== undefined) {
        await installPush(result.taskId, inlinePush, context, owed.pushCursor, fenced);
        installed = true;
      }
    } catch (error) {
      // Refused before anything was admitted: a retry may claim the binding afresh.
      if (claimed.outcome === 'claimed' && !effected) {
        // A failure that is not a refusal may have come after the run or the mailbox record was
        // committed: the claim then stays, with the assets it names, for the retry to finish.
        const refused = isRefusal(error);
        if (refused || (delivered.length === 0 && recorded === undefined)) {
          const released = await ledger.release(entry).catch(() => false);
          // Deleted only when this send provably took no effect and the claim is really gone:
          // otherwise another attempt may have completed it and its rows name these assets.
          if (refused && released) await discardMine();
        }
      }
      throw error;
    }
    const completed: A2ASendResult =
      recorded === undefined ? result : { ...result, inbound: recorded };
    await completeSend(ledger, entry, completed, owed, installed);
    return admitted(completed);
  }

  /** Follows an admitted or existing task as a stream, starting from its current snapshot. */
  function follow(
    taskId: string,
    shape: ProjectionShape,
    context: ServerCallContext | undefined,
    receipt?: Receipt,
    resuming = false,
  ): AsyncGenerator<StreamResponse> {
    const durableHistoryActive = shape.activated.has(DURABLE_HISTORY_EXTENSION_URI);
    return followTask({
      bureau,
      taskId,
      // Only an activated SubscribeToTask resumes: a send, or a request that did not activate
      // the extension, ignores the header, and so can never be refused for it after an effect.
      lastEventId:
        resuming && durableHistoryActive ? headerOf(context, 'last-event-id') : undefined,
      durableHistoryActive,
      snapshot: (view) => respondWith(view, shape, receipt),
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
      const { taskId, shape, receipt, deadline } = await admitOnce(params, context);
      const view =
        params.configuration?.returnImmediately === true
          ? await bureau.tasks.get(taskId)
          : await settledUntil(taskId, context, deadline, receipt.commandId);
      if (view === undefined) throw taskNotFound(taskId);
      return respondWith(view, shape, receipt);
    },

    async *sendMessageStream(params, context) {
      // `returnImmediately` has no effect on a stream, which stays open through INPUT_REQUIRED
      // and AUTH_REQUIRED and closes only once the task is terminal.
      const { taskId, shape, receipt } = await admitOnce(params, context);
      yield* follow(taskId, shape, context, receipt);
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
      yield* follow(view.id, { includeArtifacts: true, activated }, context, undefined, true);
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
      params: TaskPushNotificationConfig,
      context,
    ): Promise<TaskPushNotificationConfig> {
      const { projector } = requirePush();
      const view = await ownTask(params.taskId, ownerOf(context));
      const { delivery, ready } = requirePush();
      // Start-up recovery reconciles tasks under their fences, so it settles before this one is
      // taken: an install holding the fence while it waited on recovery would deadlock with it.
      await ready;
      // Under the task's fence, with the cursor read before the configuration exists so an event
      // that lands meanwhile reaches it.
      return projector.fence(view.id, async () => {
        const cursor = (await projector.tailOf(view.id)) ?? '-1';
        // A withdrawn agent's tombstone keeps its tasks readable and their webhooks flowing, but
        // starts no new delivery for a task that has ended (COR-1669). The task is read again
        // after the cursor: one that ended before the cursor is refused here, and one that ends
        // later has its terminal event after the cursor, so the new webhook receives it. Nothing
        // is committed before this check. A retry of a create that committed while the task was
        // live names an existing configuration, which is replayed rather than refused.
        if (options.acceptsNewTasks?.() === false) {
          const current = await ownTask(params.taskId, ownerOf(context));
          if (isTerminal(current.status)) {
            let existing: TaskPushNotificationConfig | undefined;
            try {
              existing = await delivery.sender.pushStore.check(
                view.id,
                context,
                structuredClone(params),
              );
            } catch (error) {
              if (error instanceof A2APushConfigurationConflictError) throw invalid(error.message);
              throw error;
            }
            if (existing !== undefined) return existing;
            throw new UnsupportedOperationError(
              `Agent '${agentName}' was withdrawn, and task '${view.id}' has ended.`,
            );
          }
        }
        return installPush(view.id, params, context, cursor, true);
      });
    },

    async getTaskPushNotificationConfig(
      params: GetTaskPushNotificationConfigRequest,
      context,
    ): Promise<TaskPushNotificationConfig> {
      const { delivery } = requirePush();
      const view = await ownTask(params.taskId, ownerOf(context));
      const config = await delivery.sender.pushStore.get(view.id, params.id, context);
      if (config === undefined) {
        throw new TaskNotFoundError(
          `Push notification config with id '${params.id}' not found for task ${view.id}.`,
        );
      }
      return config;
    },

    async listTaskPushNotificationConfigs(
      params: ListTaskPushNotificationConfigsRequest,
      context,
    ): Promise<ListTaskPushNotificationConfigsResponse> {
      const { delivery } = requirePush();
      const view = await ownTask(params.taskId, ownerOf(context));
      return delivery.sender.pushStore.list(
        { taskId: view.id, pageSize: params.pageSize, pageToken: params.pageToken },
        context,
      );
    },

    async deleteTaskPushNotificationConfig(
      params: DeleteTaskPushNotificationConfigRequest,
      context,
    ): Promise<void> {
      const { delivery, checkpoints, projector } = requirePush();
      const view = await ownTask(params.taskId, ownerOf(context));
      // The sender's store stops the configuration's deliveries before it returns; the checkpoint
      // goes with the configuration.
      // Under the task's fence, so it never lands between an install's checkpoint and its
      // configuration.
      await projector.fence(view.id, async () => {
        await delivery.sender.pushStore.delete(view.id, context, params.id);
        await checkpoints.remove(view.id, params.id);
      });
      // A task left with no configuration has nothing to project: its watcher finds that and stops.
      projector.watch(view.id);
    },
  };
}
