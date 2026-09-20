/**
 * The Operative-backed agent loop for `/api/chat`, factored out of the route
 * so the exact same pump — the code that turns run events into NDJSON
 * frames and a terminal envelope — runs under both the real HTTP handler and
 * the deterministic unit tests in `chat-agent.test.ts`. Only the `generate`
 * function differs: the route wraps `createAnthropicProviderStream`, the
 * tests wrap a local fixture with no network or model calls.
 *
 * The wire is `@corvidae/chat`'s `ChatStreamEvent` vocabulary, encoded by
 * its own `encodeChatStreamEvent` so this side can never emit a frame the
 * published decoder rejects. Every frame carries the `wireVersion: 2` +
 * `sequence` envelope, assigned by {@link createChatStreamWriter}; the three
 * legacy frames (`text`, `tool_call`, `tool_result`) keep their exact
 * pre-Operative shape underneath it, so a client that renders only those
 * (today's `session-controller.ts`) is unaffected by the wider vocabulary.
 */
import { encodeChatStreamEvent, type ChatStreamEvent } from '@corvidae/chat';
import {
  AgentRunError,
  classifyError,
  createAgent,
  HookRegistry,
  stopWhen,
  withEnhancedStreaming,
  type AgentRunErrorKind,
  type AnyToolbox,
  type ConversationHistory,
  type EnhancedStreamingOptions,
  type OnElicitation,
  type OperativeHookMap,
  type StepResult,
  type StopCondition,
  type StreamBlock,
  type StreamEvent,
  type StreamingGenerateFunction,
} from '@corvidae/operative';

import type { JSONValue, ToolRequestContext } from '@corvidae/armorer';
import { toJSONValue } from './json-value.ts';

/**
 * One frame as the pump produces it — a `ChatStreamEvent` before the writer
 * stamps the envelope on. Distributive so every member of the union loses
 * exactly its two envelope keys and nothing else.
 */
export type ChatStreamFrame = ChatStreamEvent extends infer Member
  ? Member extends ChatStreamEvent
    ? Omit<Member, 'wireVersion' | 'sequence'>
    : never
  : never;

export type ChatSerializedRunError = Extract<ChatStreamEvent, { type: 'run.error' }>['error'];

/**
 * The wire version every frame this lab writes carries.
 *
 * TWO, because this lab emits the vocabulary version 2 introduced:
 * `assistant.step.*` and `elicitation.*`. `@corvidae/chat` gates those members
 * behind a version 2 envelope on purpose — a version 1 producer cannot
 * construct one at all — so emitting them means speaking version 2.
 *
 * ONE VERSION FOR THE WHOLE APPLICATION, not per route. A stream commits to a
 * single version for its length and `decodeChatStreamEvents` rejects a mix, so
 * the choice is per stream; making it per route as well would mean every frame
 * the shared plumbing writes has to know which family it is serving, and any
 * frame the two families come to share would need gating that is invisible
 * until the wrong route emits it.
 */
const WIRE_VERSION = 2;

class StreamingEventTarget extends EventTarget {
  dispatch(event: Event): boolean {
    return this.dispatchEvent(event);
  }
}

/**
 * The request-scoped sink for one response body. Owns the two invariants the
 * reference architecture's wire contract puts on the producer: `sequence` is
 * strictly increasing from zero across EVERY frame (legacy and typed alike,
 * one counter), and nothing follows the single terminal `run.*` frame — a
 * late `stream:*` event from a listener that outlives the run, or a second
 * terminal from a defensive code path, is dropped here rather than reaching
 * the wire.
 */
export type ChatStreamWriter = {
  write(frame: ChatStreamFrame): void;
  /** True once a terminal `run.*` frame has been written. */
  readonly terminated: boolean;
};

export function createChatStreamWriter(sink: (line: string) => void): ChatStreamWriter {
  let sequence = 0;
  let terminated = false;
  return {
    write(frame) {
      if (terminated) return;
      // `encodeChatStreamEvent` re-projects and validates every field, so a
      // malformed frame throws HERE, at the producer, instead of decoding
      //
      // The counter advances and the stream is marked terminated only
      // AFTER the line is encoded and sunk: a frame that throws never
      // reached the wire, so it must not consume a sequence number or
      // close the stream against the corrected frame that follows it.
      const line = encodeChatStreamEvent({
        ...frame,
        wireVersion: WIRE_VERSION,
        sequence,
      });
      sink(line);
      sequence += 1;
      if (frame.type.startsWith('run.')) terminated = true;
    },
    get terminated() {
      return terminated;
    },
  };
}

/** The terminal, non-streamed outcome of a chat run — never written to the NDJSON body. */
export type ChatRunEnvelope =
  | { ok: true; status: 'completed'; content: string; output?: unknown }
  | {
      ok: false;
      status: string;
      error: {
        kind: AgentRunErrorKind;
        code: ChatSerializedRunError['code'];
        message: string;
        /** See {@link classifyRetryability}. Absent means "not stated". */
        retryable?: boolean;
      };
    };

/**
 * Every error code `@corvidae/chat`'s wire contract admits, as a total
 * record so this list cannot silently fall behind that union: adding a member
 * to it makes this object fail to typecheck for the missing key.
 *
 * The narrowing exists because the two unions grow independently. Operative's
 * `AgentRunErrorCode` gained `INVALID_AGENT_HANDLE` in 0.9.0, and
 * `decodeChatStreamEvent` REJECTS a frame carrying a code it does not know —
 * so forwarding a new Operative code verbatim does not deliver an unfamiliar
 * error, it drops the whole terminal frame and the client sees nothing at all.
 * Reporting `UNKNOWN`, which the wire does know, keeps the failure visible.
 * Admitting a new code into the contract is a `components/chat` decision with a
 * published release behind it, not something a lab widens on its own.
 */
/** Projects an Operative error code onto the codes the chat wire accepts. */
export function toChatWireErrorCode(code: string): ChatSerializedRunError['code'] {
  switch (code) {
    case 'INVALID_EXPORT':
    case 'LOAD_FAILED':
    case 'ABORTED':
    case 'BUDGET_EXCEEDED':
    case 'ELICITATION_DENIED':
    case 'INVALID_OUTPUT':
    case 'MAXIMUM_STEPS':
    case 'TRIPWIRE':
    case 'UNKNOWN':
      return code;
    default:
      return 'UNKNOWN';
  }
}

/**
 * Stops the loop the instant a step produces ANY tool call, approval-gated
 * or not — restoring the pre-Operative contract byte-for-byte: one server
 * step per HTTP request, never a follow-up generate call in the same
 * response. Without this, `stopWhen: [pendingApproval(), noToolCalls()]`
 * alone lets an ordinary (non-approval) tool call run to completion AND
 * generate its follow-up reply within one request — which collides with
 * `components/chat`'s `createChatSessionController`, whose continuation loop
 * (`session-controller.ts`, `while (++turn <= maxTurns)`) already re-POSTs
 * whenever it sees a resolved, non-approval tool result, regardless of
 * whether a follow-up reply also arrived in that same response. Two real
 * problems traced back to that same collision during review: a redundant
 * second (billed) turn after the answer had already streamed, and a message-
 * ordering bug on the client when a tool step and assistant text landed in
 * one response. `components/chat` is out of scope for this change — this stop
 * condition is the fix that belongs on this side of the boundary, and it
 * makes both problems moot by never producing that response shape.
 *
 * This makes `pendingApproval()` redundant (every approval-gated call also
 * has `toolCalls.length > 0`), but it stays in the list for clarity — the
 * intent ("stop and hand control back on an approval") is easy to read at
 * the call site even though this condition alone already covers it.
 */
const stopAfterAnyToolCall = (step: StepResult): boolean => step.toolCalls.length > 0;

/**
 * Values Operative types as `unknown` (`stream:tool-call-complete.arguments`,
 * every `error`) go through here before they are written. An `Error` becomes
 * its `{ name, message }` and NOTHING else — never `cause`, which for a
 * provider failure can be the raw HTTP response, credential headers
 * included, and never `stack`. Anything else round-trips through JSON,
 * which is exactly what the wire would do to it anyway, so the type is
 * honest rather than a cast.
 */
export const SAFE_CHAT_FAILURE_MESSAGE = 'The assistant could not complete this turn.';

function toSafeStreamError(): JSONValue {
  return { name: 'Error', message: SAFE_CHAT_FAILURE_MESSAGE };
}

type ChatStreamBlock = Extract<ChatStreamFrame, { type: 'stream:block-start' }>['block'];
type ChatCompleteState = Extract<ChatStreamFrame, { type: 'stream:complete' }>['state'];

function toChatStreamBlock(block: StreamBlock): ChatStreamBlock {
  return {
    id: block.id,
    type: block.type,
    index: block.index,
    content: block.content,
    complete: block.complete,
    ...(block.toolName === undefined ? {} : { toolName: block.toolName }),
    ...(block.partialArguments === undefined ? {} : { partialArguments: block.partialArguments }),
  };
}

function toChatCompleteState(
  state: Extract<StreamEvent, { type: 'stream:complete' }>['state'],
): ChatCompleteState {
  return {
    textContent: state.textContent,
    complete: state.complete,
    blocks: state.blocks.map(toChatStreamBlock),
    toolCalls: state.toolCalls.map(toChatStreamBlock),
    ...(state.activeBlock === undefined
      ? {}
      : { activeBlock: toChatStreamBlock(state.activeBlock) }),
    ...(state.usage === undefined ? {} : { usage: state.usage }),
  };
}

const STREAM_EVENT_TYPES = [
  'stream:block-start',
  'stream:block-delta',
  'stream:block-complete',
  'stream:text-delta',
  'stream:tool-call-start',
  'stream:tool-call-delta',
  'stream:tool-call-complete',
  'stream:usage',
  'stream:complete',
  'stream:error',
] as const satisfies readonly StreamEvent['type'][];

/**
 * Mirrors one Operative `StreamEvent` field-for-field onto the wire, only
 * projecting the two `unknown`-typed fields to JSON-safe values.
 */
function toStreamFrame(event: StreamEvent): ChatStreamFrame {
  switch (event.type) {
    case 'stream:block-start':
    case 'stream:block-delta':
    case 'stream:block-complete':
      return { ...event, block: toChatStreamBlock(event.block) };
    case 'stream:tool-call-complete':
      return { ...event, arguments: toJSONValue(event.arguments) };
    case 'stream:error':
      return { type: 'stream:error', error: toSafeStreamError() };
    case 'stream:complete':
      // Operative's `StreamState` holds `readonly` block arrays; the wire
      // type owns mutable copies, so copy and preserve exact optional
      // property semantics at the chat wire boundary.
      return { type: 'stream:complete', state: toChatCompleteState(event.state) };
    default:
      return event;
  }
}

/**
 * Brackets each step's generate call with its `assistant.step.*` frames.
 *
 * WRAPPED AROUND THE INNER GENERATE, inside `withEnhancedStreaming` rather
 * than outside it, and that placement is the whole reason this works.
 * `withEnhancedStreaming` mints the row with `appendStreamingMessage` and puts
 * its id on `streaming.messageId` BEFORE it calls the function it wraps — so
 * by the time this runs, the authoritative id for the row the provider is
 * about to stream into already exists and nothing has been emitted into it
 * yet. Wrapping on the outside would read the handle before it was built.
 *
 * `messageId` IS OPERATIVE'S. Not a provider block id — those are per-block
 * and per-provider, and several belong to one row. Not one this lab minted
 * either: the client would then be reconciling its own guess against the
 * server's history instead of being told which row the text belongs to, which
 * is exactly the reconciliation the step frames exist to remove.
 *
 * `completed` is written only when the generate call RESOLVES. A step that
 * threw did not complete, and saying it did would finalize a row on the way
 * to a terminal failure frame that is about to describe the same step.
 */
function withAssistantStepFrames(
  generate: StreamingGenerateFunction,
  writer: ChatStreamWriter,
): StreamingGenerateFunction {
  return async (context) => {
    const { step, streaming } = context;
    const messageId = streaming.messageId;
    writer.write({ type: 'assistant.step.started', step, messageId });
    const response = await generate(context);
    writer.write({ type: 'assistant.step.completed', step, messageId });
    return response;
  };
}

/**
 * The run options a chat turn needs, without the conversation.
 *
 * Split out of `createChatAgent` because `createSessionHandle` takes exactly
 * this shape (`SessionRunOptions = Omit<RunOptions, 'conversation'>`) and
 * supplies the conversation itself from the session store. Both callers get
 * the same wire plumbing, the same stop conditions, and the same request
 * context from one definition — the alternative was a second copy of the
 * `withEnhancedStreaming` wiring, which is where the two vocabularies would
 * start to diverge.
 *
 * The `TypedEventTarget` is created here rather than accepted, so the route
 * cannot accidentally share one across requests: every `stream:*` event the
 * wrapper dispatches goes straight to THIS request's writer. `liveToolCalls`
 * is what makes `stream:tool-call-start`/`-delta` arrive while the provider
 * response is still open — the streaming adapter calls
 * `streaming.report?.(...)` the moment it sees a tool-use block, and without
 * the option the wrapper installs no `report` and synthesizes both events
 * only after the response resolves.
 *
 * `stopWhen` defaults to the BROWSER-OWNED set: `noToolCalls()` (a plain text
 * reply is done after one step) plus `stopAfterAnyToolCall` (any step with
 * tool calls is also done after one step, whether or not those calls need
 * approval) and, for intent-at-a-glance, `pendingApproval()`. Without at
 * least one condition that stops on ordinary text, a plain reply would
 * otherwise run to `maximumSteps` — see the declarations' own example for the
 * same pairing.
 *
 * A CALLER CAN REPLACE IT, and the server-owned family has to. Stopping after
 * a tool call hands control back to the client, which is right when the
 * client drives the next turn — and wrong when the server owns the run and
 * the approval happens mid-step. There the loop should carry on to a second
 * generate and finish with the assistant's reply, so the browser receives one
 * complete turn instead of a tool result with nothing after it.
 */
export function createChatRunOptions(options: {
  generate: StreamingGenerateFunction;
  toolbox: AnyToolbox;
  requestContext: ToolRequestContext;
  writer: ChatStreamWriter;
  /**
   * Operative's elicitation callback, for a caller whose approval decision
   * comes from a person rather than from a signed token on the next request.
   *
   * OPTIONAL, and the loop reads its presence rather than its value:
   * `run-step.ts` builds `ctx.elicit` only when `onElicitation` is supplied,
   * so passing `undefined` is not the same as passing a callback that denies
   * — it means the hooks never get an `elicit` at all. The browser-owned
   * route omits it on purpose; its approvals park through the toolbox.
   */
  onElicitation?: OnElicitation;
  /**
   * The caller's hook plan. This module registers none of its own, so
   * whatever arrives here is the whole plan for the run.
   *
   * A `beforeToolExecution` handler can filter calls out of the array it
   * returns, which Operative supports explicitly: it seals a filtered call
   * with an error result so no dangling tool call is left to break a later
   * replay.
   *
   * COR-1268: this was `beforeToolExecution?: BeforeToolExecutionHook[]`
   * until `HookRegistry` became the only hook surface on a run. The array
   * field kept type-checking after that surface was removed — it reached
   * `RunOptions` through a spread, which TypeScript does not
   * excess-property-check — so the hook silently stopped firing rather than
   * failing to build.
   */
  hooks?: HookRegistry<OperativeHookMap>;
  /**
   * Replaces the default stop conditions entirely rather than adding to them,
   * because the thing a caller needs to change here is which conditions are
   * ABSENT — merging would make `stopAfterAnyToolCall` impossible to remove.
   */
  stopWhen?: StopCondition[];
}): {
  generate: ReturnType<typeof withEnhancedStreaming>;
  toolbox: AnyToolbox;
  executeOptions: { requestContext: ToolRequestContext };
  stopWhen: StopCondition[];
  onElicitation?: OnElicitation;
  hooks?: HookRegistry<OperativeHookMap>;
} {
  // Operative's `TypedEventTarget` class is not a public export, only its
  // type (through `EnhancedStreamingOptions`); the wrapper dispatches via
  // plain `dispatchEvent`, so a bare `EventTarget` is the same object at
  // runtime — this cast only buys the typed `addEventListener` overloads.
  const eventTarget: NonNullable<EnhancedStreamingOptions['eventTarget']> =
    new StreamingEventTarget();

  // Registered first so the legacy `text` frame precedes its typed mirror
  // on the wire — listeners fire in registration order — and the
  // legacy-only client sees each delta at the earliest sequence number.
  eventTarget.addEventListener('stream:text-delta', (event) => {
    options.writer.write({ type: 'text', text: event.detail.content });
  });
  for (const type of STREAM_EVENT_TYPES) {
    eventTarget.addEventListener(type, (event) => {
      options.writer.write(toStreamFrame(event.detail));
    });
  }

  return {
    generate: withEnhancedStreaming(withAssistantStepFrames(options.generate, options.writer), {
      eventTarget,
      liveToolCalls: true,
    }),
    toolbox: options.toolbox,
    executeOptions: { requestContext: options.requestContext },
    stopWhen: options.stopWhen ?? [
      stopWhen.noToolCalls(),
      stopWhen.pendingApproval(),
      stopAfterAnyToolCall,
    ],
    // SPREAD rather than assigned, because `exactOptionalPropertyTypes` makes
    // `onElicitation: undefined` a different thing from an absent key — and
    // the loop distinguishes them: an absent `onElicitation` means the hook
    // contexts carry no `elicit` at all, while a present-but-undefined one
    // would not type-check against `RunOptions`.
    ...(options.onElicitation === undefined ? {} : { onElicitation: options.onElicitation }),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  };
}

/** The same options, as a standalone agent, for the browser-owned route. */
export function createChatAgent(options: {
  generate: StreamingGenerateFunction;
  toolbox: AnyToolbox;
  requestContext: ToolRequestContext;
  writer: ChatStreamWriter;
  hooks?: HookRegistry<OperativeHookMap>;
}) {
  return createAgent(createChatRunOptions(options));
}

export type ChatAgent = ReturnType<typeof createChatAgent>;

export function startChatRun(
  agent: ChatAgent,
  conversation: ConversationHistory,
): ReturnType<ChatAgent['run']> {
  return agent.run({ conversation });
}

/**
 * Operative's own read on whether a failure is worth retrying.
 *
 * `kind` cannot answer this — a rate-limited provider and a rejected API key
 * are both `kind: 'generate'` — so without this the client would have to guess
 * from the code, and would offer a retry button for failures that can only
 * ever fail again.
 *
 * ONLY `retryable` crosses. `ClassifiedError` also carries `original: unknown`,
 * which for a provider failure can be the raw HTTP response with credential
 * headers on it — the same hazard as `AgentRunError.cause`, and the same rule
 * applies: it never reaches the browser. `category`, `statusCode`, and
 * `provider` are withheld too, for now because the wire has nowhere to put
 * them rather than because they are unsafe.
 *
 * An abort is not a failure and is never classified here: the route ends an
 * aborted turn with `run.aborted`, which carries no error at all.
 */
function classifyRetryability(error: unknown): boolean | undefined {
  try {
    // The CAUSE first, deliberately. `classifyError` reads `statusCode` /
    // `status` off the value it is given, and an `AgentRunError` carries
    // neither — the provider's 429 or 401 is on the SDK error it wrapped.
    // Classifying the wrapper alone falls through to message matching and
    // reports every provider failure as terminal, including the ones a
    // retry would fix.
    const classified = classifyError(
      error instanceof AgentRunError && error.cause !== undefined ? error.cause : error,
    );
    return classified.retryable;
  } catch {
    // A classifier that throws must not take the whole failure path with
    // it: the client still needs the error frame it was about to receive,
    // just without a retryability claim on it.
    return undefined;
  }
}

/** Spreads a retryability claim only when there is one to make. */
function withRetryability(error: unknown): { retryable?: boolean } {
  const retryable = classifyRetryability(error);
  return retryable === undefined ? {} : { retryable };
}

/**
 * Turns one classified failure into the safe `{ kind, code, message }`
 * envelope. `RunResultBase.error` and a caught `result()` rejection are both
 * typed `unknown` — this is the one place that narrows them, rather than
 * serializing an unknown error object (which could carry a credential-bearing
 * provider response) straight onto the wire.
 *
 * Exported so `chat-agent.test.ts` can pin the `AgentRunError` shapes
 * `@corvidae/operative` documents directly — most usefully
 * `OutputValidationError` (`kind: 'output'`, `code: 'INVALID_OUTPUT'`; it replaced
 * `StandardSchemaValidationError`, which 0.10.0 removed with no alias),
 * which this route never triggers live: `createChatAgent` sets no `output`
 * schema, and even an agent that does only ever raises it from
 * `AgentRun.output()`/`.unwrap()`, not from `run.result()` — confirmed
 * empirically, contrary to `RunResultBase.schemaValidation`, which records a
 * failed validation without changing `finishReason` or setting `.error`.
 */
export function classifyChatRunFailure(
  error: unknown,
  fallbackStatus: string,
): Extract<ChatRunEnvelope, { ok: false }> {
  if (error instanceof AgentRunError) {
    return {
      ok: false,
      status: error.kind === 'abort' ? 'aborted' : fallbackStatus,
      error: {
        kind: error.kind,
        code: toChatWireErrorCode(error.code),
        message: error.message,
        // An abort is a user decision rather than a failure, so it
        // carries no retryability claim on either branch of this
        // function — "you can try that again" on a deliberate stop is
        // nonsense, and "retrying will not help" is worse.
        ...(error.kind === 'abort' ? {} : withRetryability(error)),
      },
    };
  }

  // An abort that arrives as something other than an `AgentRunError` is still
  // an abort, and the caller has already told us so through `fallbackStatus`.
  //
  // This matters because the abort path is the one place where misclassifying
  // is user-visible. `0.7.0` observably RESOLVES `result()` on abort, carrying
  // a real `AgentRunError`, so today every abort takes the branch above. But
  // Operative documents `result()` as REJECTING on abort, and a version that
  // follows its own documentation — or that rejects with the underlying
  // signal's `DOMException` rather than an `AgentRunError` — lands here
  // instead. Reporting `kind: 'generate'` then would make the route call
  // `controller.error(...)` rather than closing cleanly, turning a user
  // pressing "stop generating" into an error banner they never caused.
  const aborted = fallbackStatus === 'aborted';

  return {
    ok: false,
    status: fallbackStatus,
    error: {
      kind: aborted ? 'abort' : 'generate',
      code: aborted ? 'ABORTED' : 'UNKNOWN',
      message: error instanceof Error ? error.message : 'Unknown error',
      ...(aborted ? {} : withRetryability(error)),
    },
  };
}
