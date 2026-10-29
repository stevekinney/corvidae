import type { BaseProviderOptions } from './types.ts';

/**
 * The subset of the `openai` SDK's per-request `RequestOptions` that operative
 * passes as `chat.completions.create`'s second argument.
 *
 * `signal` lives here and never in the body params: like the Anthropic SDK
 * (see {@link AnthropicRequestOptions}, AB-189), the OpenAI SDK only honors
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
  audio?: unknown;
  frequency_penalty?: unknown;
  function_call?: unknown;
  functions?: unknown;
  logit_bias?: unknown;
  logprobs?: unknown;
  max_completion_tokens?: unknown;
  max_tokens?: unknown;
  metadata?: unknown;
  modalities?: unknown;
  moderation?: unknown;
  n?: unknown;
  parallel_tool_calls?: unknown;
  prediction?: unknown;
  presence_penalty?: unknown;
  prompt_cache_key?: unknown;
  prompt_cache_options?: unknown;
  prompt_cache_retention?: unknown;
  reasoning_effort?: unknown;
  response_format?: unknown;
  safety_identifier?: unknown;
  seed?: unknown;
  service_tier?: unknown;
  stop?: unknown;
  store?: unknown;
  stream?: unknown;
  stream_options?: unknown;
  temperature?: unknown;
  tool_choice?: unknown;
  tools?: unknown;
  top_logprobs?: unknown;
  top_p?: unknown;
  user?: unknown;
  verbosity?: unknown;
  web_search_options?: unknown;
}

/**
 * Structural interface for the OpenAI SDK client surface the provider uses.
 */
export interface OpenAIClient {
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
  client?: OpenAIClient | undefined;
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
  metadata?: (Record<string, string> | null) | undefined;
}

/**
 * Minimal shape of OpenAI's `batches.list` query, mirroring the SDK's
 * `CursorPageParams`.
 */
export interface OpenAIBatchListQuery {
  after?: string;
  limit?: number;
}

/**
 * Per-status request tallies on an OpenAI batch.
 */
export interface OpenAIBatchRequestCounts {
  completed: number;
  failed: number;
  total: number;
}

/**
 * Minimal shape of an OpenAI `Batch`.
 */
export interface OpenAIBatch {
  id: string;
  object: 'batch';
  endpoint: string;
  input_file_id: string;
  completion_window: string;
  /** Unix seconds. */
  created_at: number;
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
  batches: {
    create(body: OpenAIBatchCreateRequest): Promise<OpenAIBatch>;
    retrieve(batchId: string): Promise<OpenAIBatch>;
    list(query?: OpenAIBatchListQuery): AsyncIterable<OpenAIBatch>;
    cancel(batchId: string): Promise<OpenAIBatch>;
  };
}
