import { type RuntimeServices } from '@lostgradient/lifecycle';
import {
  type ActiveRun,
  AgentContractError,
  type AgentInput,
  type SessionInputPayload,
  payloadText,
  assertAgentInput,
  reservedIdentifierReason,
} from '@lostgradient/operative';
import {
  type ConditionalTextValueStore,
  MemoryStorage,
  textValueStore,
} from '@lostgradient/storage';
import {
  Conversation,
  isConversationHistory,
  type Message,
  type MessageInput,
  getOwn,
} from 'conversationalist';
import { unopenableNewSessionIdentifierReason } from './reserved-identifiers';
import { type CommandLedger, createPrunedCommandLedger } from './command-ledger';
import { parseStartTaskOrigin, type StartTaskOrigin } from './task-origin';
import type { CreateRunRequest } from './bureau-types/runs';
import type { StartTaskOptions, TaskInput, TaskRespondResult } from './bureau-types/tasks';
import { TASKS_RESPOND_LEDGER_KEY_PREFIX, type TasksRespondClaim } from './tasks/respond-to-task';
import { toBadRequest } from './bureau-errors';

/**
 * COR-851 — an id an ordinary caller chooses may not sit in a namespace durable
 * goals own (see `reserved-identifiers.ts`). Refused as `BAD_REQUEST` with a
 * message beginning `reserved-identifier:`.
 */
export function rejectReservedIdentifier(kind: string, id: string): void {
  const reason = reservedIdentifierReason(kind, id);
  if (reason !== undefined) toBadRequest(reason);
}

/**
 * COR-1590 — `.` and `..` may not name a session that does not exist yet (see
 * `unopenableNewSessionIdentifierReason`). Refused as `BAD_REQUEST` with a message beginning
 * `unopenable-session-identifier:`.
 */
export function rejectUnopenableNewSessionIdentifier(
  kind: string,
  id: string,
  exists: boolean,
): void {
  const reason = exists ? undefined : unopenableNewSessionIdentifierReason(kind, id);
  if (reason !== undefined) toBadRequest(reason);
}

/**
 * A schedule's stored input with its text replaced by `text` (COR-2018). A text input is replaced
 * whole; an input of parts keeps its media, after the new text, so an edit of the message never
 * drops an attachment the schedule sends.
 */
export function replaceInputText(stored: SessionInputPayload, text: string): SessionInputPayload {
  if (typeof stored === 'string') return text;
  return [{ type: 'text', text }, ...stored.filter((part) => part.type !== 'text')];
}

/** The text of the last user row in `rows`, or `''` when there is none. */
function lastUserTextOf(rows: ReadonlyArray<Message> | undefined): string {
  const last = rows?.findLast((row) => row.role === 'user');
  if (last === undefined) return '';
  if (typeof last.content === 'string') return last.content;
  return last.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** Appends a request's rows verbatim, refusing rows the conversation cannot take. */
export function appendRequestRows(
  conversation: Conversation,
  rows: ReadonlyArray<Message> | undefined,
): void {
  if (rows === undefined || rows.length === 0) return;
  try {
    // Built rows keep their ids and content parts; `MessageInput` is the type
    // the history's `appendMessages` declares, and a built `Message` is the
    // input it also accepts.
    conversation.appendMessages(...(rows as unknown as MessageInput[]));
  } catch (error) {
    toBadRequest(
      `"appendMessages" cannot be appended to the session's conversation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function assertConversationAnswerable(conversation: Conversation): void {
  const last = conversation.getMessages({ includeHidden: true }).at(-1);
  if (last?.role !== 'user' && last?.role !== 'tool-result') {
    toBadRequest(
      'The conversation a run starts from must end in a user or tool-result message; ' +
        'pass "message" or "appendMessages", or start from a session that ends in one',
    );
  }
}

function validateMessageRequest(
  request: {
    message?: unknown;
    maximumSteps?: unknown;
    maximumTokens?: unknown;
    systemPrompt?: unknown;
  },
  options: { readonly messageOptional?: boolean } = {},
): void {
  if (request.message === undefined && options.messageOptional === true) {
    // The caller appends rows instead, or answers the conversation as it stands.
  } else if (!request.message || typeof request.message !== 'string') {
    toBadRequest('Request must include a "message" string');
  }
}

/**
 * What a task start adds to a run-creation request inside Bureau: the input it was given (the
 * receipt digest covers it), the parts of a part-list input, and a hook that sees the run's
 * `ActiveRun` the moment it exists, before any of its events can be missed.
 */
export type SessionTaskFields = {
  readonly taskInput?: TaskInput | undefined;
  /** Where the task came from, as the caller declared it. See {@link StartTaskOptions.origin}. */
  readonly origin?: StartTaskOrigin | undefined;
  readonly inputParts?: Exclude<SessionInputPayload, string> | undefined;
  readonly onActiveRun?: ((activeRun: ActiveRun) => void) | undefined;
  /**
   * The caller's start signal, bound to the run once its workflow is prepared and before its
   * receipt is recorded: the run executes from that point, so an abort must reach it from there.
   */
  readonly signal?: AbortSignal | undefined;
  /** The caller's trace context: the run's `parentContext`, the parent of its spans. */
  readonly traceContext?: unknown;
  /** The caller's tracer binding, which runs the run's generate and tool calls under the parent. */
  readonly withTraceContext?:
    (<T>(parent: unknown, fn: () => Promise<T>) => Promise<T>) | undefined;
};

/** The run-creation fields a task input becomes: a message, its parts, or rows to append. */
export function taskRequestFieldsOf(
  input: TaskInput,
): Pick<CreateRunRequest & SessionTaskFields, 'message' | 'inputParts' | 'appendMessages'> {
  if (typeof input === 'string') return { message: input };
  if (Array.isArray(input)) {
    // COR-716: an ordered list of user text and media parts, checked as every start path checks it.
    try {
      assertAgentInput(input);
    } catch (error) {
      if (error instanceof AgentContractError) toBadRequest(`"input" is invalid: ${error.message}`);
      throw error;
    }
    return { inputParts: input };
  }
  if (typeof input !== 'object' || input === null) {
    return toBadRequest('"input" must be a string, a list of parts, or a task input object');
  }
  if ('append' in input) return { appendMessages: input.append };
  if ('conversation' in input) {
    const history = input.conversation;
    if (!isConversationHistory(history)) {
      return toBadRequest('"input.conversation" must be a valid ConversationHistory');
    }
    return { appendMessages: history.ids.map((id) => getOwn(history.messages, id)!) };
  }
  if ('continue' in input) return {};
  return toBadRequest('"input" must be a string, a list of parts, or a task input object');
}

/** The text that stands for a request where only text fits: its message, parts, or last user row. */
export function requestTextOf(request: CreateRunRequest & SessionTaskFields): string {
  if (request.message !== undefined) return request.message;
  return request.inputParts === undefined
    ? lastUserTextOf(request.appendMessages)
    : payloadText(request.inputParts);
}

/** The input a request that names no `taskInput` stands for, so its digest covers what it ran. */
export function legacyTaskInputOf(request: CreateRunRequest): unknown {
  const rows = request.appendMessages ?? [];
  if (request.message !== undefined) {
    return rows.length === 0 ? request.message : { message: request.message, append: rows };
  }
  return rows.length === 0 ? { continue: true } : { append: rows };
}

export function validateCreateRunRequest(request: CreateRunRequest): void {
  validateMessageRequest(request, { messageOptional: true });

  if (request.appendMessages !== undefined) {
    if (
      !Array.isArray(request.appendMessages) ||
      !request.appendMessages.every(
        (row: unknown) =>
          typeof row === 'object' &&
          row !== null &&
          typeof (row as { id?: unknown }).id === 'string' &&
          (row as { id: string }).id.length > 0 &&
          typeof (row as { role?: unknown }).role === 'string',
      )
    ) {
      toBadRequest('"appendMessages" must be an array of messages, each with an "id" and a "role"');
    }
  }

  if (request.sessionId !== undefined) {
    if (typeof request.sessionId !== 'string') {
      toBadRequest('"sessionId" must be a string');
    }

    if (request.sessionId.trim().length === 0) {
      toBadRequest('"sessionId" must be a non-empty string');
    }
    rejectReservedIdentifier('"sessionId"', request.sessionId.trim());
  }

  if (request.agentName !== undefined) {
    if (typeof request.agentName !== 'string') {
      toBadRequest('"agentName" must be a string');
    }

    if (request.agentName.trim().length === 0) {
      toBadRequest('"agentName" must be a non-empty string');
    }
  }

  // COR-424 — the ledger keys a run-creation request id on the caller that
  // issued it. Without an authenticated principal there is no caller to
  // scope it to, and an unscoped key would let any caller replay another's.
  if (request.runCreationRequestId !== undefined) {
    if (
      typeof request.runCreationRequestId !== 'string' ||
      request.runCreationRequestId.trim().length === 0
    ) {
      toBadRequest('"runCreationRequestId" must be a non-empty string');
    }
    if (typeof request.principal !== 'string' || request.principal.trim().length === 0) {
      toBadRequest('"runCreationRequestId" requires an authenticated "principal"');
    }
  }
}

/**
 * AB-15/AB-22: `bureau.run`'s synchronous-throw surface — unknown agent name,
 * malformed `input`, or malformed `options` — validated BEFORE any async
 * work (durable-engine dispatch, definition resolution) begins. Everything
 * else (session, provider, tool, policy, abort) settles through the
 * returned `AgentRun` handle instead of throwing here.
 */
export function validateAgentRunInput(input: unknown): asserts input is AgentInput {
  if (typeof input === 'string') return;
  if (Array.isArray(input)) {
    // COR-716: an ordered list of user text and media parts. The same check
    // every start path makes, so a malformed list is refused here, before any
    // async work, rather than failing inside a step.
    try {
      assertAgentInput(input);
    } catch (error) {
      if (error instanceof AgentContractError) toBadRequest(`"input" is invalid: ${error.message}`);
      throw error;
    }
    return;
  }
  if (
    input !== null &&
    typeof input === 'object' &&
    'conversation' in input &&
    isConversationHistory(input.conversation)
  ) {
    return;
  }
  toBadRequest(
    '"input" must be a string, a non-empty array of text and media parts, or an object with a valid "conversation" ConversationHistory',
  );
}

/**
 * The ledger {@link BureauTasks.respond} records its receipts in, in the Bureau's store. An
 * ephemeral Bureau keeps it in memory: a receipt then lives as long as the process does.
 */
export function createTasksRespondLedger(
  kv: ConditionalTextValueStore | undefined,
  runtime: RuntimeServices,
): CommandLedger<TasksRespondClaim, TaskRespondResult> {
  return createPrunedCommandLedger<TasksRespondClaim, TaskRespondResult>(
    kv ?? textValueStore(new MemoryStorage()),
    TASKS_RESPOND_LEDGER_KEY_PREFIX,
    'respond-conflict',
    runtime,
  );
}

/**
 * The options of one {@link BureauTasks.start} call, each read once. A caller-owned bag is read
 * before the first `await` and never again, so a getter that answers differently on a later read
 * cannot slip a value past this check. A malformed bag is `BAD_REQUEST` before anything is
 * persisted; the owner and the context identifier are validated where the run is created.
 */
export function snapshotStartOptions(options: StartTaskOptions): StartTaskOptions {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    toBadRequest('"options" must be an object');
  }
  const {
    contextId,
    principal,
    commandId,
    requestContext,
    origin,
    signal,
    traceContext,
    withTraceContext,
  } = options;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    toBadRequest('"options.signal" must be an AbortSignal');
  }
  if (withTraceContext !== undefined && typeof withTraceContext !== 'function') {
    toBadRequest('"options.withTraceContext" must be a function');
  }
  let declaredOrigin: StartTaskOrigin | undefined;
  try {
    declaredOrigin = parseStartTaskOrigin(origin);
  } catch (error) {
    return toBadRequest(error instanceof Error ? error.message : '"options.origin" is not valid');
  }
  return {
    ...(contextId === undefined ? {} : { contextId }),
    ...(principal === undefined ? {} : { principal }),
    ...(commandId === undefined ? {} : { commandId }),
    ...(requestContext === undefined ? {} : { requestContext }),
    ...(declaredOrigin === undefined ? {} : { origin: declaredOrigin }),
    ...(signal === undefined ? {} : { signal }),
    ...(traceContext === undefined ? {} : { traceContext }),
    ...(withTraceContext === undefined ? {} : { withTraceContext }),
  };
}
