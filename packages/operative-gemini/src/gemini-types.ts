import type { RuntimeServices } from '@lostgradient/lifecycle';
import type {
  BaseProviderOptions,
  ContextAssembler,
  TokenBudget,
  TokenCountResult,
} from '@lostgradient/operative/provider-kit';
import type { Message } from 'conversationalist';

/**
 * Minimal shape of a `@google/genai` `GenerateContentParameters` request body.
 *
 * The SDK's own `GenerateContentParameters` is an `interface`, so it carries no
 * implicit index signature and is therefore *not* assignable to
 * `Record<string, unknown>`. Naming the required `model`/`contents` fields here
 * — and widening only the payload-shaped fields to `unknown` — is what lets a
 * real `GoogleGenAI` instance satisfy {@link GeminiGenerativeModel} and
 * {@link GeminiStreamingModel} without a cast, while keeping consumer fakes
 * trivial to write. Do not add an index signature: that would put the
 * assignability back where it was.
 */
export interface GeminiGenerateContentRequest {
  /** Provider-native model id, sent with every request by the maintained SDK. */
  model: string;
  /** `ContentListUnion` in the SDK; widened here so fakes need not model it. */
  contents: unknown;
  /** `GenerateContentConfig` in the SDK; omitted when no options are set. */
  config?: unknown;
}

/**
 * Structural interface for a `@google/genai` client.
 *
 * The maintained SDK centres on a `GoogleGenAI` client whose `models`
 * namespace takes the model id on every request, rather than binding a model
 * handle at construction time the way the previous SDK's `getGenerativeModel()`
 * did.
 *
 * A real `GoogleGenAI` instance is assignable to this interface — see
 * `gemini-client-assignability.test-d.ts`, which locks that in.
 */
export interface GeminiGenerativeModel {
  /** The `models` namespace of a `@google/genai` client, narrowed to `generateContent`. */
  models: {
    generateContent(params: GeminiGenerateContentRequest): Promise<GeminiGenerateContentResult>;
  };
}

/**
 * Minimal shape of a `@google/genai` `GenerateContentResponse`.
 *
 * Candidates and usage sit at the top level — the frozen SDK's `.response`
 * wrapper is gone. `functionCall.name` and `functionCall.args` are both
 * optional in the maintained SDK, so parts must be narrowed before they are
 * handed to armorer's stricter `GeminiPart` union.
 */
export interface GeminiGenerateContentResult {
  /** The response candidates; each carries the content parts the model produced. */
  candidates?:
    | Array<{
        content?: {
          parts?: Array<{
            text?: string;
            functionCall?: { name?: string; args?: Record<string, unknown> };
            /** True for a thought-summary text part; never answer text. */
            thought?: boolean;
            /** Opaque replay data Gemini 2.5 attaches to a part; it has no content representation. */
            thoughtSignature?: string;
            /** Inline media output (image, audio, video, document), base64. */
            inlineData?: { mimeType?: string; data?: string };
            /** Every other `Part` field `@google/genai` declares, kept opaque so it is detected. */
            fileData?: unknown;
            executableCode?: unknown;
            codeExecutionResult?: unknown;
            functionResponse?: unknown;
            toolCall?: unknown;
            toolResponse?: unknown;
            audioTranscription?: unknown;
            videoMetadata?: unknown;
            partMetadata?: unknown;
            mediaResolution?: unknown;
            mediaProcessing?: unknown;
          }>;
        };
      }>
    | undefined;
  /** Token accounting for the call, when the response reports it. */
  usageMetadata?: GeminiUsageMetadata | undefined;
}

/**
 * Minimal shape of a `@google/genai` `GenerateContentResponseUsageMetadata`.
 *
 * `promptTokenCount` INCLUDES `cachedContentTokenCount` — the SDK states it
 * outright: "When `cached_content` is set, this also includes the number of
 * tokens in the cached content." That makes Gemini match OpenAI's inclusive
 * accounting rather than Anthropic's disjoint buckets, which is why
 * `buildGeminiUsage` subtracts rather than passing the count straight through.
 * Gemini reports no cache-write counterpart, so there is nothing to map to
 * `cacheCreationTokens`.
 */
export interface GeminiUsageMetadata {
  /** Tokens in the prompt, including any served from a context cache. */
  promptTokenCount?: number | undefined;
  /** Tokens in the generated candidates. */
  candidatesTokenCount?: number | undefined;
  /** Prompt plus candidate tokens. */
  totalTokenCount?: number | undefined;
  /** Tokens of the prompt served from a context cache, per the SDK's own docs. */
  cachedContentTokenCount?: number | undefined;
}

/**
 * Minimal shape of a `@google/genai` `CreateCachedContentParameters`.
 *
 * `model` is required in the SDK and required here. `config` is
 * `CreateCachedContentConfig` — carrying `contents`, `systemInstruction`,
 * `ttl`, `displayName`, `tools`, and `toolConfig` — widened to `unknown` for
 * the same reason {@link GeminiGenerateContentRequest} widens its own
 * payload-shaped fields: the SDK's config types are `interface`s with no
 * implicit index signature, so a `Record<string, unknown>` here would take a
 * real `GoogleGenAI` out of reach without a cast.
 */
export interface GeminiCreateCachedContentRequest {
  /** Provider-native model id. Must match the model used to generate. */
  model: string;
  /** `CreateCachedContentConfig` in the SDK; omitted when no options are set. */
  config?: unknown;
}

/**
 * Minimal shape of a `@google/genai` `CachedContent`. Every field is optional
 * in the SDK, so every field is optional here.
 */
export interface GeminiCachedContent {
  /** Server-generated resource name — the handle passed back as `cachedContent`. */
  name?: string | undefined;
  /** The human-readable name the cache was created with. */
  displayName?: string | undefined;
  /** The provider-native model id the cache belongs to. */
  model?: string | undefined;
  /** When the cache was created, as an ISO timestamp. */
  createTime?: string | undefined;
  /** When the cache was last updated, as an ISO timestamp. */
  updateTime?: string | undefined;
  /** When the cache expires, as an ISO timestamp. */
  expireTime?: string | undefined;
  /** `CachedContentUsageMetadata` in the SDK, carrying `totalTokenCount`. */
  usageMetadata?: { totalTokenCount?: number } | undefined;
}

/**
 * Structural interface for the `caches` namespace of a `@google/genai` client.
 *
 * Deliberately narrower than the SDK's `Caches` class, which also exposes
 * `get`, `list`, `update`, and `delete`. This package only ever creates a cache
 * resource, so only `create` is named — a smaller surface for a caller's fake
 * to satisfy, and the same minimal-interface rule the batch and generate
 * interfaces follow. A real `GoogleGenAI` satisfies this; see
 * `gemini-client-assignability.test-d.ts`.
 */
export interface GeminiCacheCreatingClient {
  /** The `caches` namespace of a `@google/genai` client, narrowed to `create`. */
  caches: {
    create(params: GeminiCreateCachedContentRequest): Promise<GeminiCachedContent>;
  };
}

/**
 * Minimal shape of a `@google/genai` `CountTokensParameters`.
 *
 * `model` and `contents` are required in the SDK and required here; `config`
 * is `CountTokensConfig` — carrying `systemInstruction`, `tools`, and
 * `generationConfig`, none of which this package needs to inspect — widened to
 * `unknown` for the same reason {@link GeminiGenerateContentRequest} widens its
 * own payload-shaped fields: the SDK's config types are `interface`s with no
 * implicit index signature, so a `Record<string, unknown>` here would take a
 * real `GoogleGenAI` out of reach without a cast.
 */
export interface GeminiCountTokensRequest {
  /** Provider-native model id. Token counts are model-specific. */
  model: string;
  /** `ContentListUnion` in the SDK; widened here so fakes need not model it. */
  contents: unknown;
  /** `CountTokensConfig` in the SDK; omitted when no options are set. */
  config?: unknown;
}

/**
 * Structural interface for the `models.countTokens` operation of a
 * `@google/genai` client.
 *
 * Deliberately narrower than the SDK's `Models` class, which also exposes
 * `generateContent`, `embedContent`, and much more — this package only ever
 * calls `countTokens` through this interface, matching the minimal-interface
 * rule {@link GeminiCacheCreatingClient} and the batch interfaces follow. A
 * real `GoogleGenAI` satisfies this; see `gemini-client-assignability.test-d.ts`.
 *
 * The response shape is declared inline, matching the SDK's own
 * `CountTokensResponse` field names, rather than naming a package-level type:
 * this keeps the interface structural so a real `GoogleGenAI` satisfies it
 * with no cast. `createGeminiTokenCounter` maps this shape to
 * {@link TokenCountResult} at its own boundary — see that type's doc comment
 * for why the mapping normalizes `totalTokens` but not `cachedTokens`.
 */
export interface GeminiTokenCountingClient {
  /** The `models` namespace of a `@google/genai` client, narrowed to `countTokens`. */
  models: {
    countTokens(params: GeminiCountTokensRequest): Promise<{
      /** Total token count for `contents` (and `config`, when supplied). */
      totalTokens?: number | undefined;
      /** Tokens attributable to a referenced context cache. */
      cachedContentTokenCount?: number | undefined;
    }>;
  };
}

/**
 * Options for createGeminiProvider.
 */
export interface GeminiProviderOptions extends BaseProviderOptions {
  /** A client to use instead of constructing a `GoogleGenAI`; the factory then never loads the SDK. */
  client?: GeminiGenerativeModel | undefined;
  /** The API key; falls back to the `GOOGLE_API_KEY` environment variable, and a missing key throws a `ProviderError`. */
  apiKey?: string | undefined;
  /**
   * Overrides the Gemini SDK's default base URL (`HttpOptions.baseUrl`).
   * Accepts any string — including a credential-injecting proxy origin —
   * with no shape validation.
   */
  baseURL?: string | undefined;
  /**
   * Names an already-created `CachedContent` resource to serve this run's
   * prompt prefix from, lowered verbatim to `config.cachedContent`.
   *
   * ## Contract: the conversation you pass must be the tail only
   *
   * A `CachedContent` resource *is* the head of the prompt — it holds the
   * `systemInstruction` and `contents` the model sees before anything on the
   * request. Setting this option therefore does not append a cache to your
   * conversation; it declares that the head of the conversation already lives
   * server-side. Every call must pass **only the turns that are not in that
   * cache**. Passing the same full conversation you would have sent uncached
   * states the cached prefix twice, which changes the prompt the model reads and
   * bills you for the duplicate tokens on every request.
   *
   * Operative cannot do the subtraction for you. It never sees inside a resource
   * it did not create, so it has no boundary to split on — unlike the
   * provider-managed path below, where it created the prefix and knows exactly
   * where it ends. You own the cache, so you own the boundary.
   *
   * The one half of the contract that *is* checkable is enforced: a conversation
   * carrying a system message is rejected with a `ProviderError` at the point of
   * use, because that message would be sent as `config.systemInstruction`
   * beside `config.cachedContent` and duplicate or contradict the instruction
   * the cache holds. Re-sent conversational turns cannot be detected from here
   * and are yours to keep out.
   *
   * ## Naming and exclusivity
   *
   * Named after the SDK's own `GenerateContentConfig.cachedContent` field
   * rather than after anything on `AnthropicProviderOptions`, because
   * there is no Anthropic analog to rename it to: Anthropic's prompt cache is
   * an unnamed, per-request `cache_control` breakpoint with no handle, while
   * Gemini's is an explicitly-created server resource addressed by its
   * server-generated name.
   *
   * Mutually exclusive with {@link GeminiProviderOptions.assembler} +
   * {@link GeminiProviderOptions.contextBudget}: one names a cache you own,
   * the other has the provider create and own one. Setting both is rejected at
   * factory-construction time rather than silently resolved.
   */
  cachedContent?: string | undefined;
  /**
   * Enables prompt-cache-aware context assembly. When set (together with
   * {@link GeminiProviderOptions.contextBudget}), each call runs `assembler`
   * in stable-prefix mode instead of sending the conversation verbatim. The
   * `cacheBoundary` mark on the assembled system/pinned prefix splits the
   * conversation: everything up to and including the boundary is created as a
   * `CachedContent` resource, and every request then sends only the tail and
   * references the cache by name.
   *
   * A resource is created once **per distinct stable prefix**, not once per
   * generated function. A generate function is reusable across runs, so a
   * second conversation with a different system prompt or different pinned
   * content gets its own resource rather than inheriting the first run's — it
   * would otherwise omit its own prefix while pointing at another run's, which
   * is both a wrong answer and a leak of that run's instructions into it. The
   * retained set is bounded, and the least recently used entry is evicted past
   * the bound; eviction abandons the resource to its own server-side TTL and
   * costs at most one extra creation the next time that prefix comes back.
   *
   * Expiry is tracked per entry, from the SDK's own `CachedContent.expireTime`
   * where it reports one and from {@link GeminiProviderOptions.cacheTtl}
   * otherwise, so a lapsed resource is replaced rather than referenced until
   * the API rejects it. A resource that dies inside the remaining window — it
   * lapsed between the check and the request, or was deleted elsewhere — is
   * detected from the rejection and rebuilt once for that request.
   *
   * Same name, same type, and the same `assembler && contextBudget`
   * engagement condition as `AnthropicProviderOptions.assembler` — the
   * concept genuinely matches, so the name does too. What differs is the
   * lowering: `toGeminiMessages` documents `cacheBoundary` as a wire-level
   * no-op for Gemini, because Gemini has no per-message annotation to lower it
   * to. The mark is still the mechanism here; it just steers an out-of-band
   * `caches.create` call rather than a `cache_control` field.
   */
  assembler?: ContextAssembler | undefined;
  /** Token budget passed to `assembler`. Required when `assembler` is set. */
  contextBudget?: TokenBudget | undefined;
  /** Passed through to `assembler` as `pinnedMessages` (e.g. reference docs, tool usage notes). */
  pinnedMessages?: ReadonlyArray<Message> | undefined;
  /**
   * TTL for the provider-created cache resource, as the SDK's duration string
   * (`'3600s'`, up to nine fractional digits). Passed to `caches.create` as
   * `config.ttl`; when omitted, Gemini applies its own server-side default.
   *
   * The deliberate divergence from
   * `AnthropicProviderOptions.extendedCacheTtl`: that option is a
   * boolean because Anthropic offers exactly two fixed lifetimes (5 minutes,
   * or 1 hour) for an annotation on a request that is about to be sent
   * anyway. Gemini's TTL is an arbitrary duration on a standalone resource
   * with its own lifecycle, so a boolean could not express it and the
   * `extended` framing would be a fiction. No effect unless `assembler` +
   * `contextBudget` actually produce a provider-created cache — a cache named
   * through {@link GeminiProviderOptions.cachedContent} carries the TTL it was
   * created with.
   *
   * Also the fallback for local expiry bookkeeping: the provider replaces a
   * lapsed cache rather than referencing it, and prefers the SDK's own
   * `CachedContent.expireTime` for that — it accounts for Gemini's server-side
   * default when this is unset, which nothing here could otherwise know. This
   * value is used only when the response reports no usable `expireTime`.
   */
  cacheTtl?: string | undefined;
  /**
   * Cache-capable client used for the `caches.create` calls the `assembler` +
   * `contextBudget` path makes.
   *
   * Precedence is: a {@link GeminiProviderOptions.client} that itself exposes
   * `caches`, then this, then the client the factory imports for itself. A
   * real `GoogleGenAI` exposes `caches`, and so does the imported client, so
   * this is purely an escape hatch for a hand-written fake or a narrowed
   * wrapper — and it is deliberately the *lower* precedence of the two: the
   * two clients may carry different credentials, projects, or endpoints, so
   * creating through this one while generating through a perfectly capable
   * `client` risks referencing a cache the generating client cannot see.
   *
   * With no injected client at all, this is still used when supplied; it names
   * a cache-capable client, which is exactly what the path needs. Supplying
   * neither, with the assembler path enabled and an injected client that has
   * no `caches`, is rejected at factory-construction time.
   */
  cacheClient?: GeminiCacheCreatingClient | undefined;
  /**
   * The AB-92/AB-252/AB-253 injectable runtime-service seam: wall time
   * (`managedCaches` entry `createdAt`/expiry comparisons). Resolved exactly
   * once at construction — omitted, this provider reads the real globals via
   * `createDefaultRuntimeServices()`; a test composes its own deterministic
   * instance with `createManualRuntimeServices()` so cache-expiry timing is
   * fully time-controlled.
   */
  runtime?: RuntimeServices | undefined;
}

/**
 * Structural interface for a `@google/genai` client that supports streaming.
 *
 * `models.generateContentStream` resolves to the async iterable of chunks
 * directly; the frozen SDK's `{ stream }` wrapper object is gone, and each
 * chunk is a full `GenerateContentResponse`.
 *
 * A real `GoogleGenAI` instance is assignable to this interface — see
 * `gemini-client-assignability.test-d.ts`, which locks that in.
 */
export interface GeminiStreamingModel {
  /** The `models` namespace of a `@google/genai` client, narrowed to `generateContentStream`. */
  models: {
    generateContentStream(
      params: GeminiGenerateContentRequest,
    ): Promise<AsyncIterable<GeminiGenerateContentResult>>;
  };
}

/**
 * Minimal shape of a `@google/genai` `CreateBatchJobParameters`.
 *
 * `model` is optional in the SDK and stays optional here: making it required
 * would fail assignability in both directions and take a real `GoogleGenAI`
 * out of reach without a cast.
 */
export interface GeminiCreateBatchJobRequest {
  /** Provider-native model id. Optional in the SDK — see the type's note. */
  model?: string | undefined;
  /**
   * `BatchJobSourceUnion` in the SDK: inline requests, a GCS/BigQuery URI, or
   * an uploaded file name. Widened so fakes need not model the union.
   */
  src: unknown;
  /** `CreateBatchJobConfig` in the SDK; omitted when no options are set. */
  config?: unknown;
}

/**
 * Names one existing `@google/genai` batch job. Gemini addresses jobs by a
 * server-generated resource name inside a parameter object, where Anthropic and
 * OpenAI take a bare id string — an asymmetry these interfaces keep rather than
 * paper over.
 */
export interface GeminiBatchJobReference {
  /** A fully-qualified batch job resource name, or its trailing id. */
  name: string;
  /** Per-request config in the SDK; omitted when no options are set. */
  config?: unknown;
}

/**
 * Minimal shape of a `@google/genai` `ListBatchJobsParameters`.
 */
export interface GeminiListBatchJobsRequest {
  /** `ListBatchJobsConfig` in the SDK, carrying `pageSize`/`pageToken`. */
  config?: unknown;
}

/**
 * Minimal shape of a `@google/genai` `BatchJob`. Every field is optional in the
 * SDK, so every field is optional here.
 */
export interface GeminiBatchJob {
  /** Server-generated resource name — the handle for `get`/`cancel`/`delete`. */
  name?: string | undefined;
  /** The human-readable name the job was created with. */
  displayName?: string | undefined;
  /** `JobState` in the SDK, a string enum such as `'JOB_STATE_SUCCEEDED'`. */
  state?: string | undefined;
  /** When the job was created, as an ISO timestamp. */
  createTime?: string | undefined;
  /** When the job started running, as an ISO timestamp. */
  startTime?: string | undefined;
  /** When the job finished, as an ISO timestamp. */
  endTime?: string | undefined;
  /** When the job was last updated, as an ISO timestamp. */
  updateTime?: string | undefined;
  /** The provider-native model id the job runs against. */
  model?: string | undefined;
  /** `BatchJobDestination` in the SDK: where the results were written. */
  dest?: unknown;
  /** `JobError` in the SDK; set only for failed or cancelled jobs. */
  error?: unknown;
}

/**
 * Minimal shape of the `@google/genai` `DeleteResourceJob` returned by
 * `batches.delete`.
 */
export interface GeminiDeleteResourceJob {
  /** The resource name of the deletion operation. */
  name?: string | undefined;
  /** Whether the deletion has finished. */
  done?: boolean | undefined;
  /** `JobError` in the SDK. */
  error?: unknown;
}

/**
 * Structural interface for a `@google/genai` client's `batches` namespace.
 *
 * Shaped nothing like the other two on purpose. `create` takes
 * `{ model, src, config }` instead of a request list or a file id; jobs are
 * addressed by resource name rather than id; the retrieval verb is `get`, not
 * `retrieve`; `cancel` resolves to nothing; and Gemini alone exposes `delete`.
 * `list` resolves to a `Pager`, so it is `Promise<AsyncIterable<…>>` where
 * Anthropic's and OpenAI's directly-iterable page promises are `AsyncIterable`.
 */
export interface GeminiBatchClient {
  /** The `batches` namespace of a `@google/genai` client. */
  batches: {
    create(params: GeminiCreateBatchJobRequest): Promise<GeminiBatchJob>;
    get(params: GeminiBatchJobReference): Promise<GeminiBatchJob>;
    list(params?: GeminiListBatchJobsRequest): Promise<AsyncIterable<GeminiBatchJob>>;
    cancel(params: GeminiBatchJobReference): Promise<void>;
    delete(params: GeminiBatchJobReference): Promise<GeminiDeleteResourceJob>;
  };
}
