import { conversationSchema, type ConversationHistory } from 'conversationalist';
import { z } from 'zod';

/**
 * The conversation as a renderer actually holds it, validated as the schema
 * defines it.
 *
 * `conversationSchema`'s OUTPUT is `Conversation`, but its INPUT is the
 * mutable projection Zod infers from the object shape — arrays without
 * `readonly`, all the way down. `ConversationHistory` is deeply readonly, so
 * handing one straight to a request typed from `z.input` fails on `ids`, then
 * on `messages`, then on each message's `content`. Piping a typed input in
 * front of the schema states the caller's real type once and keeps the runtime
 * validation exactly as it was, rather than casting at every call site or
 * deep-copying a value that is about to be serialized anyway.
 */
const conversationInput = z
  .custom<ConversationHistory>()
  // `readonly` is erased at runtime and the value is serialized across the RPC
  // boundary immediately after this, so widening it to the schema's own input
  // type changes nothing about what is validated — `conversationSchema` still
  // parses and transforms every field below.
  .transform((value) => value as z.input<typeof conversationSchema>)
  .pipe(conversationSchema);

export type RpcRequestDefinition = {
  input: z.ZodType;
  output: z.ZodType;
};

export type RpcContract = {
  requests: Record<string, RpcRequestDefinition>;
  messages?: Record<string, z.ZodType>;
};

export type ElectrobunRpcContract = {
  bun: RpcContract;
  webview: RpcContract;
};

type RequestSchema<T extends RpcContract> = {
  [K in keyof T['requests']]: {
    params: z.input<T['requests'][K]['input']>;
    response: z.output<T['requests'][K]['output']>;
  };
};

export type RpcRequestClient<T extends RpcContract> = {
  [K in keyof T['requests']]-?: (
    params: z.input<T['requests'][K]['input']>,
  ) => Promise<z.output<T['requests'][K]['output']>>;
};

type MessageSchema<T extends RpcContract> =
  T['messages'] extends Record<string, z.ZodType>
    ? { [K in keyof T['messages']]: z.output<T['messages'][K]> }
    : Record<never, never>;

export type InferElectrobunRPCSchema<T extends ElectrobunRpcContract> = {
  bun: {
    requests: RequestSchema<T['bun']>;
    messages: MessageSchema<T['bun']>;
  };
  webview: {
    requests: RequestSchema<T['webview']>;
    messages: MessageSchema<T['webview']>;
  };
};

export const defineRpcContract = <const T extends ElectrobunRpcContract>(contract: T) => contract;

/**
 * The contract is identical in every build. Smoke behavior is a main-process
 * handler concern, never a request that exists in one build and not another —
 * a build-conditional contract can only be expressed with a type assertion that
 * lies to every renderer consuming the client type.
 */
const applicationRequests = {
  /*
   * Starts one chat turn and RETURNS IMMEDIATELY, before a single token is
   * generated. The frames arrive separately, as `chatStreamLine` messages.
   *
   * This split is forced by the transport, not chosen for taste: Electrobun's
   * `createRPC` rejects any request still outstanding after `maxRequestTime`,
   * which defaults to 1000ms. A chat turn takes far longer than that, so a
   * request that resolved with the finished turn would reject every time.
   * Messages carry no timeout, which is what makes them the streaming half.
   *
   * A refusal is a result, not a transport failure: `unavailable` is how a
   * missing `ANTHROPIC_API_KEY` reaches the person as a banner rather than as
   * a rejected promise with a stack trace behind it.
   */
  startChatRun: {
    input: z.object({
      runId: z.string().min(1),
      conversation: conversationInput,
    }),
    output: z.discriminatedUnion('status', [
      z.object({ status: z.literal('started') }),
      z.object({ status: z.literal('unavailable'), message: z.string() }),
    ]),
  },
  /*
   * Cancels an in-flight run. Idempotent, and an unknown run id is a normal
   * outcome rather than an error — the run may have settled between the
   * renderer deciding to abort and this request arriving.
   */
  abortChatRun: {
    input: z.object({ runId: z.string().min(1) }),
    output: z.object({ aborted: z.boolean() }),
  },
};

/**
 * Frames travel to the renderer as WHOLE NDJSON LINES, exactly as the main
 * process encoded them, and are decoded there by `@lostgradient/chat`'s own
 * `decodeChatStreamEvents`.
 *
 * The line stays a string on purpose. Re-describing the frame vocabulary in
 * Zod here would create a second, competing definition of the wire contract
 * that `@lostgradient/chat` already owns — and the moment the two disagreed, the
 * published decoder would be overruled by a copy living in this application.
 * The envelope invariants (`wireVersion`, a strictly increasing `sequence`,
 * exactly one terminal frame) are checked by that decoder, which is the only
 * component entitled to check them.
 */
const applicationMessages = {
  chatStreamLine: z.object({
    runId: z.string().min(1),
    line: z.string(),
  }),
  /*
   * Closes the renderer's iterator for a run.
   *
   * Necessary even though every run writes a terminal frame: the decoder stops
   * at the terminal frame only if one arrives, and a main process that dies
   * mid-turn sends nothing further. Without an explicit end the renderer would
   * await a frame that is never coming, leaving the composer disabled with no
   * way back. `reason` distinguishes an orderly finish from that case.
   */
  chatStreamEnd: z.object({
    runId: z.string().min(1),
    reason: z.enum(['completed', 'failed']),
  }),
};

/**
 * Chat frames are declared on the WEBVIEW side because that is the side that
 * handles them. `defineElectrobunRPC` resolves each side's outgoing `send`
 * proxy from the *other* side's `messages`, so declaring them here is what
 * lets the main process send them and the renderer receive them.
 */
export const applicationRpcContract = defineRpcContract({
  bun: {
    requests: applicationRequests,
    messages: {},
  },
  webview: { requests: {}, messages: applicationMessages },
});

export type ApplicationRPCSchema = InferElectrobunRPCSchema<typeof applicationRpcContract>;
export type ApplicationBunRequestClient = RpcRequestClient<typeof applicationRpcContract.bun>;
export type ApplicationRendererRpc = {
  request: ApplicationBunRequestClient;
};

export type ApplicationMessageName = Extract<keyof typeof applicationMessages, string>;
export type ChatStreamLineMessage = z.output<typeof applicationMessages.chatStreamLine>;
export type ChatStreamEndMessage = z.output<typeof applicationMessages.chatStreamEnd>;
export type StartChatRunResult = z.output<
  typeof applicationRpcContract.bun.requests.startChatRun.output
>;

/** The main process's outgoing half: one sender per renderer-handled message. */
export type ApplicationWebviewMessageSender = {
  [K in ApplicationMessageName]: (payload: z.output<(typeof applicationMessages)[K]>) => void;
};
