import type {
  BaseProviderOptions,
  ContextAssembler,
  TokenBudget,
  TokenCountResult,
} from '@lostgradient/operative/provider-kit';
import type { Message } from 'conversationalist';

/**
 * Structural interface for the Anthropic SDK client surface the provider uses.
 *
 * `create` returns a plain `Promise` rather than mirroring the SDK's real
 * overloaded signature (`MessageCreateParamsNonStreaming` /
 * `MessageCreateParamsStreaming` / `MessageCreateParamsBase`, each returning a
 * different `APIPromise<...>` shape). This shape is pinned against a real
 * `Anthropic` client (SDK 0.122.0) by
 * `anthropic-client-assignability.test-d.ts`, confirmed empirically rather
 * than derived from a documented TypeScript overload-assignability rule —
 * `AnthropicMessageResponse` widening `stop_reason` and the cache-token
 * `usage` fields to allow `null` was what made a real client satisfy this
 * interface, since the SDK's `Message`/`Usage` types declare them nullable,
 * not merely optional.
 */
export interface AnthropicClient {
  /** The Messages resource; `create` sends one non-streaming request. */
  messages: {
    create(
      params: AnthropicMessageCreateRequest,
      options?: AnthropicRequestOptions,
    ): Promise<AnthropicMessageResponse>;
  };
}

/**
 * The subset of the SDK's per-request `RequestOptions` that operative passes
 * as `messages.create`'s second argument.
 *
 * `signal` lives here and NOT on {@link AnthropicMessageCreateRequest}: the
 * SDK only honors an abort signal handed to it as request options — a signal
 * placed in the body is JSON-serialized into `{}` and ignored, which is how
 * `run.abort()` used to leave the upstream stream open (AB-189).
 */
export interface AnthropicRequestOptions {
  /** Aborts the in-flight HTTP request, closing a streaming response early. */
  signal?: AbortSignal | undefined;
}

/**
 * Minimal shape of an Anthropic `messages.create` request body.
 *
 * Mirrors `MessageCreateParamsBase` in the installed `@anthropic-ai/sdk`
 * (0.122.0): `model`, `messages`, and `max_tokens` are required, everything
 * else is optional. There is deliberately no `signal` field: the abort
 * signal travels in {@link AnthropicRequestOptions}, the SDK's separate
 * `options` argument, because a signal in the body is ignored (AB-189).
 *
 * Every optional field is declared even though this package never inspects
 * some of them. An object literal passed at a call site is subject to excess
 * property checking against this interface, so a field omitted here would be
 * unpassable by a caller — the interface has to name the whole request
 * surface to stay usable, not just the part operative reads.
 *
 * Bodies are widened to `unknown` rather than `Record<string, unknown>`. The
 * SDK's parameter types are `interface`s with no implicit index signature, so
 * `Record<string, unknown>` fails the bivariant method check in *both*
 * directions and makes a real `Anthropic` un-injectable without a cast. That
 * is the defect AB-154 found on the Gemini migration, and it is why
 * {@link AnthropicClient} needed an `as unknown as` at its construction site
 * before this type existed — see {@link AnthropicCountTokensRequest} for the
 * AB-167 precedent this follows.
 */
export interface AnthropicMessageCreateRequest {
  /** Provider-native model id. */
  model: string;
  /** `Array<MessageParam>` in the SDK; widened so fakes need not model it. */
  messages: unknown;
  /** Maximum tokens to generate before stopping. */
  max_tokens: number;
  /** `CacheControlEphemeral | null` in the SDK. */
  cache_control?: unknown;
  /** `MessageCreateParamsContainer | null` in the SDK. */
  container?: unknown;
  /** `string | null` in the SDK. */
  inference_geo?: unknown;
  /** `Metadata` in the SDK. */
  metadata?: unknown;
  /** `OutputConfig` in the SDK. */
  output_config?: unknown;
  /** `'auto' | 'standard_only'` in the SDK. */
  service_tier?: unknown;
  /** `Array<string>` in the SDK. */
  stop_sequences?: unknown;
  /** `boolean` in the SDK. */
  stream?: unknown;
  /** `string | Array<TextBlockParam>` in the SDK. */
  system?: unknown;
  /** `number` in the SDK. Deprecated on newer models. */
  temperature?: unknown;
  /** `ThinkingConfigParam` in the SDK. */
  thinking?: unknown;
  /** `ToolChoice` in the SDK. */
  tool_choice?: unknown;
  /** `Array<ToolUnion>` in the SDK. */
  tools?: unknown;
  /** `number` in the SDK. Deprecated on newer models. */
  top_k?: unknown;
  /** `number` in the SDK. Deprecated on newer models. */
  top_p?: unknown;
  /** `string` in the SDK; header param, not a body field. */
  user_profile_id?: unknown;
}

/**
 * Minimal shape of an Anthropic Messages API response.
 *
 * `stop_reason` and the two cache-token `usage` fields are widened to allow
 * `null` because the SDK's real `Message`/`Usage` types declare them
 * `string | null` and `number | null` respectively, not merely optional —
 * `anthropic-client-assignability.test-d.ts` is what caught this.
 */
export interface AnthropicMessageResponse {
  /** The response content blocks, in order: text, tool use, thinking, and server-tool blocks. */
  content: Array<{
    type: string;
    text?: string | undefined;
    id?: string | undefined;
    name?: string | undefined;
    input?: unknown;
    /** A `thinking` block's reasoning text. */
    thinking?: string | undefined;
    /** A `thinking` block's signature; replayed verbatim. */
    signature?: string | undefined;
    /** A `redacted_thinking` block's encrypted payload; replayed verbatim. */
    data?: string | undefined;
    /** A `text` block's citations (`null` when absent); kept opaque. */
    citations?: unknown;
    /** The server tool use a result block answers. */
    tool_use_id?: string | undefined;
    /** A server-tool result block's content; kept opaque. */
    content?: unknown;
    /** A `container_upload` block's file id. */
    file_id?: string | undefined;
  }>;
  /**
   * Token usage for the call, including prompt-cache reads and writes when the API reports them.
   */
  usage?:
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      }
    | undefined;
  /** Why generation stopped (`end_turn`, `tool_use`, `max_tokens`, ...), or `null` when absent. */
  stop_reason?: (string | null) | undefined;
}

/**
 * Structural mirror of the Anthropic SDK's `ThinkingConfigParam` union, for
 * {@link AnthropicProviderOptions.thinking}.
 *
 * Declared structurally rather than re-exported from `@anthropic-ai/sdk`
 * because that SDK is an *optional* peer dependency: a direct type import
 * would drag it into this package's published declarations and break every
 * consumer who does not install it. `anthropic-thinking-assignability.test-d.ts`
 * pins this against drift by asserting the SDK's own `ThinkingConfigParam` is
 * assignable to this type, so a fourth variant added upstream fails the build
 * here rather than silently becoming unreachable.
 *
 * All three of the SDK's variants are present on purpose. An earlier revision
 * declared only `enabled`/`disabled`, which narrowed a supposedly native-shaped
 * escape hatch and left `{ type: 'adaptive' }` — a mode Anthropic actually
 * accepts — unreachable without defeating the type system.
 */
export type AnthropicThinkingConfig =
  | {
      type: 'enabled';
      /**
       * Anthropic's constraint, quoted from the SDK's own declaration: "Must
       * be ≥1024 and less than `max_tokens`." Both provider factories check
       * this rather than letting the API reject the request — the ≥1024 floor
       * at construction, and the `< max_tokens` bound per request, since
       * {@link GenerateContext.maximumTokens} can raise the effective
       * `max_tokens` above the construction-time value on any given call.
       */
      budget_tokens: number;
      /** `'omitted'` redacts thinking content but keeps a signature for multi-turn continuity. */
      display?: 'summarized' | 'omitted' | null;
    }
  | { type: 'disabled' }
  | {
      type: 'adaptive';
      /** `'omitted'` redacts thinking content but keeps a signature for multi-turn continuity. */
      display?: 'summarized' | 'omitted' | null;
    };

/**
 * Options for createAnthropicProvider.
 */
export interface AnthropicProviderOptions extends BaseProviderOptions {
  /**
   * A client to use instead of constructing the SDK one; any object satisfying {@link AnthropicClient}, such as a test double or a proxy.
   */
  client?: AnthropicClient | undefined;
  /**
   * The API key for the SDK client. Defaults to the `ANTHROPIC_API_KEY` environment variable. Ignored when `client` is given.
   */
  apiKey?: string | undefined;
  /**
   * Overrides the Anthropic SDK's default base URL. Accepts any string —
   * including a credential-injecting proxy origin — with no shape
   * validation. Passed straight to the `Anthropic` client constructor.
   */
  baseURL?: string | undefined;
  /**
   * Opts every `cache_control` breakpoint lowered from a conversation
   * `cacheBoundary` into Anthropic's extended one-hour cache TTL instead of
   * the default 5-minute one. No effect unless `assembler`/`contextBudget`
   * (or an already-marked conversation) actually produce a cache boundary.
   */
  extendedCacheTtl?: boolean | undefined;
  /**
   * Enables prompt-cache-aware context assembly. When set (together with
   * {@link AnthropicProviderOptions.contextBudget}), each call runs
   * `assembler` in stable-prefix mode instead of sending the conversation
   * verbatim. The resulting `cacheBoundary` mark on the assembled
   * system/pinned prefix is preserved through to the request, so
   * `toAnthropicMessages` lowers it to a `cache_control` breakpoint — see
   * `createContextAssembler`'s `stablePrefix` option.
   */
  assembler?: ContextAssembler | undefined;
  /** Token budget passed to `assembler`. Required when `assembler` is set. */
  contextBudget?: TokenBudget | undefined;
  /** Passed through to `assembler` as `pinnedMessages` (e.g. reference docs, tool usage notes). */
  pinnedMessages?: ReadonlyArray<Message> | undefined;
  /**
   * Requests Anthropic's extended-thinking mode, mirroring the native
   * `thinking` request field shape directly — see
   * {@link AnthropicThinkingConfig} for the full union (`enabled`, `disabled`,
   * and `adaptive`).
   *
   * This is deliberately a second, provider-native escape hatch rather than
   * a provider-neutral abstraction: `effort` is already operative's one
   * neutral knob over this dimension, and layering a second abstraction over
   * the same concept would just create two competing vocabularies for the
   * same thing. `thinking` and `effort` lower to different wire fields
   * (`thinking` vs. `output_config.effort`) and neither overrides the
   * other — when both are set, both are sent, and Anthropic applies its own
   * documented interaction between them. This sits alongside
   * `extendedCacheTtl` and `baseURL` as the other native-shape options on
   * this type.
   *
   * The `thinking` and `redacted_thinking` blocks a response carries are kept as ordered
   * `GenerateResponse.parts` in both factories, committed to the assistant row, and replayed
   * byte-identical, before `tool_use` in the same assistant turn, on the next request, so thinking
   * and tool calls combine without losing reasoning continuity.
   *
   * ## Validation
   *
   * `{ type: 'enabled' }`'s budget is checked against Anthropic's documented
   * bounds; see {@link AnthropicThinkingConfig}. Both factories additionally
   * reject, at construction, the combinations Anthropic documents as
   * incompatible with an active thinking configuration: a non-default
   * {@link BaseProviderOptions.temperature}, a
   * {@link BaseProviderOptions.topP} below 0.95, and — for `{ type: 'enabled' }`
   * only — a forced {@link BaseProviderOptions.toolChoice} (`'required'` or a
   * named tool). Forced tool use is fine with `{ type: 'adaptive' }`, which
   * Anthropic explicitly supports.
   */
  thinking?: AnthropicThinkingConfig | undefined;
}

/**
 * Events emitted by the Anthropic Messages API when streaming.
 */
export interface AnthropicStreamEvent {
  /** Which stream event this is. */
  type:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop';
  /** On `message_start`, the message envelope with its initial usage. */
  message?:
    | {
        /** The input and output token counts the message starts with. */
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number | null;
          cache_read_input_tokens?: number | null;
        };
      }
    | undefined;
  /** The index of the content block a block event refers to. */
  index?: number | undefined;
  /** On `content_block_start`, the block that is opening. */
  content_block?:
    | {
        type: string;
        id?: string;
        name?: string;
        text?: string;
        thinking?: string;
        signature?: string;
        data?: string;
        citations?: unknown;
        tool_use_id?: string;
        content?: unknown;
        file_id?: string;
        input?: unknown;
      }
    | undefined;
  /** On `content_block_delta` and `message_delta`, the incremental change. */
  delta?:
    | {
        type?: string;
        text?: string;
        thinking?: string;
        signature?: string;
        citation?: unknown;
        partial_json?: string;
        /**
         * Widened to allow `null`: the SDK's `RawMessageDeltaEvent.Delta.stop_reason`
         * is `StopReason | null`, not merely optional.
         */
        stop_reason?: string | null;
        usage?: { output_tokens?: number };
      }
    | undefined;
  /** On `message_delta`, the cumulative output token count. */
  usage?: { output_tokens?: number } | undefined;
}

/**
 * Structural interface for an Anthropic client that supports streaming.
 *
 * `create` resolves to `Promise<AsyncIterable<...>>` rather than a bare
 * `AsyncIterable<...>`. The real SDK's streaming overload returns
 * `APIPromise<Stream<RawMessageStreamEvent>>` — a `Promise`, not itself
 * iterable (`APIPromise extends Promise<T>` with no `Symbol.asyncIterator`)
 * — so a bare `AsyncIterable` return type is not satisfied by a real
 * `Anthropic` client; see `anthropic-client-assignability.test-d.ts`. Callers
 * already `await Promise.resolve(client.messages.create(params))` before
 * iterating, so this matches existing call-site behavior for both a real
 * client and a synchronous mock.
 */
export interface AnthropicStreamingClient {
  /** The Messages resource; `create` opens one streaming request. */
  messages: {
    /**
     * Returns either a directly iterable stream or a promise of one.
     *
     * The real `@anthropic-ai/sdk` streaming overload returns an `APIPromise`,
     * which is a `Promise` and not itself async-iterable, so the promise arm is
     * required for a real `Anthropic` to satisfy this interface without a cast.
     * The bare-iterable arm is kept so a hand-rolled or mock client that returns
     * its generator synchronously stays valid — narrowing to promise-only would
     * be a runtime break for anyone doing
     * `for await (const event of client.messages.create(params))` against their
     * own client. `createAnthropicProviderStream` awaits the result, which is a
     * no-op on the non-promise arm.
     */
    create(
      params: AnthropicMessageCreateRequest,
      options?: AnthropicRequestOptions,
    ): AsyncIterable<AnthropicStreamEvent> | Promise<AsyncIterable<AnthropicStreamEvent>>;
  };
}

//
// Three providers expose a native batch-inference endpoint and their request
// shapes have almost nothing in common: Anthropic inlines the per-request
// Messages bodies, OpenAI points at a previously uploaded JSONL file, and
// Gemini names a source (`src`) that may be inline requests, a GCS/BigQuery
// URI, or an uploaded file name. The structural interfaces below mirror each
// SDK as it actually is rather than flattening the three into one invented
// shape — see `batches/` for the factories built on them, and
// `getProviderCapabilities` in `providers/capabilities.ts` for which providers
// have a batch endpoint at all.
//
// Every member is declared with method syntax on purpose. TypeScript compares
// method parameters bivariantly, which is what lets a real SDK client satisfy
// these interfaces without a cast even though the SDKs' own parameter types are
// `interface`s (no implicit index signature) and some of their members are
// arrow-function properties. Declaring a request parameter as
// `Record<string, unknown>` would break that in both directions — the mistake
// documented on `GeminiGenerateContentRequest` in @lostgradient/operative-gemini. Widen only the
// payload-shaped fields, and name the rest.
//
// `anthropic-batch-client-assignability.test-d.ts` locks the Anthropic half of this in against
// the real `Anthropic` class; Operative's `openai-` and `gemini-` counterparts do the same for
// `OpenAI` and `GoogleGenAI`.

/**
 * One request inside an Anthropic Message Batch.
 */
export interface AnthropicBatchCreateRequestItem {
  /** Caller-chosen id, unique within the batch, used to match up results. */
  custom_id: string;
  /**
   * `MessageCreateParamsNonStreaming` in the SDK — the same body
   * `messages.create` takes. Widened here so fakes need not model the whole
   * Messages request surface.
   */
  params: unknown;
}

/**
 * Minimal shape of an Anthropic `messages.batches.create` request body.
 */
export interface AnthropicBatchCreateRequest {
  /** The requests in the batch, each paired with a `custom_id`. */
  requests: ReadonlyArray<AnthropicBatchCreateRequestItem>;
}

/**
 * Minimal shape of Anthropic's `messages.batches.list` query, mirroring the
 * SDK's cursor `PageParams`.
 */
export interface AnthropicBatchListQuery {
  /** The maximum number of batches to return per page. */
  limit?: number;
  /** Returns the page that ends just before this batch id. */
  before_id?: string;
  /** Returns the page that starts just after this batch id. */
  after_id?: string;
}

/**
 * Per-status request tallies on an Anthropic Message Batch. Every request
 * starts in `processing` and moves to one of the other buckets only once the
 * whole batch ends.
 */
export interface AnthropicMessageBatchRequestCounts {
  /** Requests canceled before they were processed. */
  canceled: number;
  /** Requests that failed. */
  errored: number;
  /** Requests that expired before they were processed. */
  expired: number;
  /** Requests still being processed. */
  processing: number;
  /** Requests that completed successfully. */
  succeeded: number;
}

/**
 * Minimal shape of an Anthropic `MessageBatch`.
 */
export interface AnthropicMessageBatch {
  /** The batch identifier. */
  id: string;
  /** Where the batch is in its lifecycle. */
  processing_status: 'in_progress' | 'canceling' | 'ended';
  /** Per-status tallies of the batch's requests. */
  request_counts: AnthropicMessageBatchRequestCounts;
  /** Set only once processing ends. */
  results_url: string | null;
  /** When the batch was created, as an RFC 3339 timestamp. */
  created_at: string;
  /** Set only once processing ends. */
  ended_at: string | null;
  /** When the batch expires, as an RFC 3339 timestamp. */
  expires_at: string;
}

/**
 * Processing result for a single request in an Anthropic Message Batch.
 *
 * Kept as a discriminated union rather than a widened object so callers can
 * narrow on `type`. `message` and `error` are widened because they are the
 * full Messages response and error payloads.
 */
export type AnthropicMessageBatchResult =
  | { type: 'succeeded'; message: unknown }
  | { type: 'errored'; error: unknown }
  | { type: 'canceled' }
  | { type: 'expired' };

/**
 * One line of the `.jsonl` results stream for an Anthropic Message Batch.
 * Results are not guaranteed to arrive in request order — match them up by
 * `custom_id`.
 */
export interface AnthropicMessageBatchIndividualResponse {
  /** The `custom_id` the request carried, which pairs this line with its request. */
  custom_id: string;
  /** How the request ended. */
  result: AnthropicMessageBatchResult;
}

/**
 * Structural interface for the Anthropic SDK client surface the batch factory
 * uses: the stable `client.messages.batches` resource.
 *
 * `list` is typed as an `AsyncIterable` rather than a promise because the SDK
 * returns a `PagePromise`, which is directly iterable and fetches further pages
 * as it goes. `results` keeps the SDK's `Promise<AsyncIterable<…>>` shape: the
 * request that opens the `.jsonl` stream is awaited first, then the lines are
 * iterated.
 */
export interface AnthropicBatchClient {
  /**
   * The Messages resource; its `batches` sub-resource creates, polls, lists, cancels, and reads batches.
   */
  messages: {
    batches: {
      create(params: AnthropicBatchCreateRequest): Promise<AnthropicMessageBatch>;
      retrieve(messageBatchId: string): Promise<AnthropicMessageBatch>;
      list(query?: AnthropicBatchListQuery): AsyncIterable<AnthropicMessageBatch>;
      cancel(messageBatchId: string): Promise<AnthropicMessageBatch>;
      results(
        messageBatchId: string,
      ): Promise<AsyncIterable<AnthropicMessageBatchIndividualResponse>>;
    };
  };
}

/**
 * Minimal shape of an Anthropic `messages.countTokens` request body.
 *
 * Mirrors `MessageCountTokensParams` in the installed `@anthropic-ai/sdk`
 * (0.122.0): `messages` and `model` are required, everything else is optional.
 *
 * Every optional field is declared even though this package never inspects one
 * of them. An object literal passed at a call site is subject to excess
 * property checking against this interface, so a field omitted here would be
 * unpassable by a caller — the interface has to name the whole request surface
 * to stay usable, not just the part operative reads.
 *
 * Bodies are widened to `unknown` rather than `Record<string, unknown>`. The
 * SDK's parameter types are `interface`s with no implicit index signature, so
 * `Record<string, unknown>` fails the bivariant method check in *both*
 * directions and makes a real `Anthropic` un-injectable without a cast. That is
 * the defect AB-154 found on the Gemini migration, and it is the same defect
 * AB-174 fixed on {@link AnthropicClient} and {@link AnthropicStreamingClient}
 * (see {@link AnthropicMessageCreateRequest}), which previously needed an
 * `as unknown as` at their construction sites for the same reason.
 * `anthropic-token-counting-assignability.test-d.ts` pins this one down so it
 * cannot regress the same way.
 */
export interface AnthropicCountTokensRequest {
  /** Provider-native model id. Token counts are model-specific. */
  model: string;
  /** `Array<MessageParam>` in the SDK; widened so fakes need not model it. */
  messages: unknown;
  /** `string | Array<TextBlockParam>` in the SDK. */
  system?: unknown;
  /** `Array<ToolUnion>` in the SDK. Tools count toward the total. */
  tools?: unknown;
  /** `ToolChoice` in the SDK. */
  tool_choice?: unknown;
  /** `ThinkingConfigParam` in the SDK. */
  thinking?: unknown;
  /** `OutputConfig` in the SDK. */
  output_config?: unknown;
  /** `CacheControlEphemeral | null` in the SDK. */
  cache_control?: unknown;
}

/**
 * Structural interface for the `messages.countTokens` operation of an
 * `@anthropic-ai/sdk` client.
 *
 * Deliberately narrower than the SDK's `Messages` resource, which also exposes
 * `create`, `stream`, and `batches` — this package only ever calls
 * `countTokens` through this interface, matching the minimal-interface rule
 * {@link AnthropicBatchClient} and the Gemini interfaces follow. A real
 * `Anthropic` satisfies this; see
 * `anthropic-token-counting-assignability.test-d.ts`.
 *
 * **`input_tokens` is optional here although the SDK declares it required.**
 * That is deliberate, not a transcription slip. The declared type describes
 * what Anthropic's own endpoint returns; it is not a runtime guarantee, and
 * this package is routinely pointed at something else — see
 * {@link AnthropicProviderOptions.baseURL}, which accepts any origin including
 * a credential-injecting proxy. Typing the field as required would let a
 * response that genuinely omits it surface as `undefined` through a `number`.
 * A required property is still assignable to an optional one of the same
 * type, so a real `MessageTokensCount` satisfies this interface with no cast.
 * The response shape is declared inline rather than naming a package-level
 * type, matching `GeminiTokenCountingClient` in @lostgradient/operative-gemini: `createAnthropicTokenCounter`
 * maps it to {@link TokenCountResult} at its own boundary.
 */
export interface AnthropicTokenCountingClient {
  /** The Messages resource; `countTokens` counts a request's input tokens without running it. */
  messages: {
    countTokens(params: AnthropicCountTokensRequest): Promise<{
      /**
       * Total tokens across the request's messages, system prompt, and tools.
       * Absent when the response genuinely omits it; never fabricated as `0`.
       */
      input_tokens?: number | undefined;
    }>;
  };
}
