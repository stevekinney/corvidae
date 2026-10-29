import type { BaseProviderOptions } from '@lostgradient/operative/provider-kit';

/**
 * The subset of the `openai` SDK's per-request `RequestOptions` that operative
 * passes as `chat.completions.create`'s second argument.
 *
 * `signal` lives here and never in the body params: like the Anthropic SDK
 * (see `AnthropicRequestOptions`, AB-189), the OpenAI SDK only honors
 * an abort signal handed to it as request options — a signal inside the
 * body is JSON-serialized away and ignored, so `run.abort()` used to leave
 * the upstream stream open until the model finished on its own (AB-238).
 */
export interface OpenAIRequestOptions {
  /** Aborts the in-flight HTTP request, closing a streaming response early. */
  signal?: AbortSignal | undefined;
}

/**
 * Minimal shape of an OpenAI `chat.completions.create` request body.
 *
 * Mirrors `ChatCompletionCreateParamsBase` in the installed `openai` SDK
 * (7.15.0): `model` and `messages` are required, everything else is optional.
 * Shared by {@link OpenAIClient} and {@link OpenAIStreamingClient}, so
 * `stream` is `unknown` rather than a literal. There is deliberately no
 * `signal` field: the abort signal travels in {@link OpenAIRequestOptions}.
 *
 * Bodies are widened to `unknown` rather than `Record<string, unknown>`. The
 * SDK's parameter types are `interface`s with no implicit index signature, so
 * `Record<string, unknown>` fails the bivariant method check in both
 * directions and makes a real `OpenAI` un-injectable without a cast.
 * `openai-client-assignability.test-d.ts` asserts every SDK field is named.
 */
export interface OpenAIChatCompletionCreateRequest {
  /** Provider-native model id. */
  model: string;
  /** `Array<ChatCompletionMessageParam>` in the SDK; widened so fakes need not model it. */
  messages: unknown;
  /** Audio output parameters; accepted so a request can carry them, never set by Operative. */
  audio?: unknown;
  /** Penalizes tokens by how often they have already appeared. */
  frequency_penalty?: unknown;
  /** The deprecated single-function selector; never set by Operative. */
  function_call?: unknown;
  /** The deprecated function definitions; never set by Operative. */
  functions?: unknown;
  /** Per-token bias applied before sampling. */
  logit_bias?: unknown;
  /** Whether to return log probabilities of the output tokens. */
  logprobs?: unknown;
  /** Upper bound on generated tokens, reasoning tokens included. */
  max_completion_tokens?: unknown;
  /** Upper bound on generated tokens; what Operative sends for `maximumTokens`. */
  max_tokens?: unknown;
  /** Caller-supplied key-value metadata attached to the request. */
  metadata?: unknown;
  /** The output modalities the model should produce. */
  modalities?: unknown;
  /** Moderation settings applied to the request. */
  moderation?: unknown;
  /** How many completions to generate. */
  n?: unknown;
  /** Whether the model may call several tools in one turn. */
  parallel_tool_calls?: unknown;
  /** A predicted output the model can use to speed up generation. */
  prediction?: unknown;
  /** Penalizes tokens that have already appeared at all. */
  presence_penalty?: unknown;
  /** A stable key that groups requests sharing a prompt prefix for caching. */
  prompt_cache_key?: unknown;
  /** Options that tune how the prompt cache is used. */
  prompt_cache_options?: unknown;
  /** How long a cached prompt prefix is retained. */
  prompt_cache_retention?: unknown;
  /** How much reasoning a reasoning model spends; set from Operative's `effort`. */
  reasoning_effort?: unknown;
  /** The output format: plain text, a JSON object, or a JSON schema. */
  response_format?: unknown;
  /** A stable identifier for the end user, for abuse detection. */
  safety_identifier?: unknown;
  /** Seed for best-effort deterministic sampling. */
  seed?: unknown;
  /** The processing tier the request asks for. */
  service_tier?: unknown;
  /** Sequences at which generation stops. */
  stop?: unknown;
  /** Whether OpenAI stores the completion for later retrieval. */
  store?: unknown;
  /** Whether the response streams; `unknown` because both client shapes share this request type. */
  stream?: unknown;
  /** Streaming options, such as including usage in the final chunk. */
  stream_options?: unknown;
  /** Sampling temperature. */
  temperature?: unknown;
  /** Which tool, if any, the model must call; set from Operative's `toolChoice`. */
  tool_choice?: unknown;
  /** The tool definitions the model may call. */
  tools?: unknown;
  /** How many of the most likely tokens to return log probabilities for. */
  top_logprobs?: unknown;
  /** Nucleus-sampling probability mass. */
  top_p?: unknown;
  /** The deprecated end-user identifier. */
  user?: unknown;
  /** How verbose the model's answer should be. */
  verbosity?: unknown;
  /** Options for the built-in web-search tool. */
  web_search_options?: unknown;
}

/**
 * Structural interface for the OpenAI SDK client surface the provider uses.
 */
export interface OpenAIClient {
  /** The Chat Completions resource; `chat.completions.create` returns one whole completion. */
  chat: {
    completions: {
      create(
        params: OpenAIChatCompletionCreateRequest,
        options?: OpenAIRequestOptions,
      ): Promise<OpenAIChatCompletion>;
    };
  };
}

/**
 * Minimal shape of an OpenAI Chat Completion response.
 */
export interface OpenAIChatCompletion {
  /** The generated choices; Operative reads the first. */
  choices: Array<{
    message: {
      content?: (string | null) | undefined;
      /** The model's refusal text; model output, kept in metadata. */
      refusal?: (string | null) | undefined;
      /** Citation annotations on `content`; kept in metadata. */
      annotations?: unknown;
      /** Audio output; unadvertised, so a response carrying it fails typed. */
      audio?: unknown;
      /** The deprecated single function call; unmapped, so a response carrying it fails typed. */
      function_call?: unknown;
      tool_calls?:
        | Array<
            | {
                id: string;
                type: 'function';
                function: { name: string; arguments: string };
              }
            | {
                id: string;
                type: 'custom';
                custom: { name: string; input: string };
              }
          >
        | undefined;
    };
    finish_reason?: string | undefined;
  }>;
  /** Token counts for the request, when the API reports them. */
  usage?:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      }
    | undefined;
}

/**
 * Options for createOpenAIProvider.
 */
export interface OpenAIProviderOptions extends BaseProviderOptions {
  /** An injected client; when absent the provider loads the OpenAI SDK on first call and builds one. */
  client?: OpenAIClient | undefined;
  /** The API key handed to the SDK; the SDK falls back to `OPENAI_API_KEY` when absent. */
  apiKey?: string | undefined;
  /**
   * Overrides the OpenAI SDK's default base URL. Accepts any string —
   * including a credential-injecting proxy origin — with no shape
   * validation. Enables LM Studio, Ollama, Groq, etc.
   */
  baseURL?: string | undefined;
}

/**
 * A single chunk from the OpenAI Chat Completions streaming API.
 */
export interface OpenAIChatCompletionChunk {
  /** The choice deltas this chunk carries; Operative reads the first. */
  choices: Array<{
    delta: {
      content?: (string | null) | undefined;
      refusal?: (string | null) | undefined;
      role?: string | undefined;
      /** Audio output; unadvertised, so a stream carrying it fails typed. */
      audio?: unknown;
      /** The deprecated single function call; unmapped, so a stream carrying it fails typed. */
      function_call?: unknown;
      tool_calls?:
        | Array<{
            index: number;
            id?: string;
            type?: 'function' | 'custom';
            function?: { name?: string; arguments?: string };
          }>
        | undefined;
    };
    finish_reason?: (string | null) | undefined;
  }>;
  /** Token counts, present on the final chunk when usage streaming is requested. */
  usage?:
    | ({
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      } | null)
    | undefined;
}

/**
 * Structural interface for an OpenAI client that supports streaming.
 */
export interface OpenAIStreamingClient {
  /** The Chat Completions resource; `chat.completions.create` returns the stream of chunks. */
  chat: {
    completions: {
      create(
        params: OpenAIChatCompletionCreateRequest,
        options?: OpenAIRequestOptions,
      ):
        | AsyncIterable<OpenAIChatCompletionChunk>
        | Promise<AsyncIterable<OpenAIChatCompletionChunk>>;
    };
  };
}

/**
 * Minimal shape of an OpenAI `batches.create` request body.
 *
 * Unlike Anthropic and Gemini, OpenAI takes no inline requests: the batch is
 * built from a JSONL file already uploaded with purpose `batch`, named here by
 * `input_file_id`.
 */
export interface OpenAIBatchCreateRequest {
  /** Only `'24h'` is currently accepted by the API. */
  completion_window: '24h';
  /**
   * The API route every request in the file targets, e.g.
   * `'/v1/chat/completions'`, `'/v1/responses'`, or `'/v1/embeddings'`. Typed
   * as `string` rather than pinned to the SDK's literal union so a newly
   * supported route does not require an operative release; the installed SDK's
   * `BatchCreateParams['endpoint']` is the authority on what the API accepts.
   */
  endpoint: string;
  /** Id of an uploaded JSONL file containing the batched requests. */
  input_file_id: string;
  /** Caller-supplied key-value metadata attached to the batch. */
  metadata?: (Record<string, string> | null) | undefined;
}

/**
 * Minimal shape of OpenAI's `batches.list` query, mirroring the SDK's
 * `CursorPageParams`.
 */
export interface OpenAIBatchListQuery {
  /** Cursor: return the batches after this batch id. */
  after?: string;
  /** Maximum number of batches per page. */
  limit?: number;
}

/**
 * Per-status request tallies on an OpenAI batch.
 */
export interface OpenAIBatchRequestCounts {
  /** Requests in the batch that completed successfully. */
  completed: number;
  /** Requests in the batch that failed. */
  failed: number;
  /** Requests in the batch. */
  total: number;
}

/**
 * Minimal shape of an OpenAI `Batch`.
 */
export interface OpenAIBatch {
  /** The batch id. */
  id: string;
  /** Always `'batch'`. */
  object: 'batch';
  /** The API route every request in the batch targets. */
  endpoint: string;
  /** Id of the uploaded JSONL file the batch was built from. */
  input_file_id: string;
  /** The window within which the batch must finish, such as `'24h'`. */
  completion_window: string;
  /** Unix seconds. */
  created_at: number;
  /** Where the batch is in its lifecycle. */
  status:
    | 'validating'
    | 'failed'
    | 'in_progress'
    | 'finalizing'
    | 'completed'
    | 'expired'
    | 'cancelling'
    | 'cancelled';
  /** Id of the file holding results for the requests that succeeded. */
  output_file_id?: string | undefined;
  /** Id of the file holding results for the requests that errored. */
  error_file_id?: string | undefined;
  /** Per-status request tallies, once the API reports them. */
  request_counts?: OpenAIBatchRequestCounts | undefined;
}

/**
 * Structural interface for the OpenAI SDK client surface the batch factory
 * uses: the top-level `client.batches` resource.
 *
 * There is deliberately no `results` member: OpenAI returns results as an
 * uploaded file, so a caller reads `output_file_id` through `client.files`
 * rather than streaming them off the batch itself.
 */
export interface OpenAIBatchClient {
  /** The `client.batches` resource: create, retrieve, list, and cancel. */
  batches: {
    create(body: OpenAIBatchCreateRequest): Promise<OpenAIBatch>;
    retrieve(batchId: string): Promise<OpenAIBatch>;
    list(query?: OpenAIBatchListQuery): AsyncIterable<OpenAIBatch>;
    cancel(batchId: string): Promise<OpenAIBatch>;
  };
}
