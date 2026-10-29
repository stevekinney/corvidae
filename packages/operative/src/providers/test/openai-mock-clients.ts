import type {
  OpenAIChatCompletion,
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionCreateRequest,
  OpenAIClient,
  OpenAIRequestOptions,
  OpenAIStreamingClient,
} from '../openai-types.ts';

export interface MockOpenAIClient extends OpenAIClient {
  _calls: OpenAIChatCompletionCreateRequest[];
  /** The request options (second `create` argument) recorded per call. */
  _requestOptions: Array<OpenAIRequestOptions | undefined>;
  _responses: OpenAIChatCompletion[];
  _errors: Error[];
}

/**
 * Creates a mock OpenAI client that records calls and returns queued responses.
 */
export function createMockOpenAIClient(
  responses: OpenAIChatCompletion[],
  errors: Error[] = [],
): MockOpenAIClient {
  const calls: OpenAIChatCompletionCreateRequest[] = [];
  const requestOptions: Array<OpenAIRequestOptions | undefined> = [];
  let responseIndex = 0;
  let errorIndex = 0;

  return {
    _calls: calls,
    _requestOptions: requestOptions,
    _responses: responses,
    _errors: errors,
    chat: {
      completions: {
        async create(
          params: OpenAIChatCompletionCreateRequest,
          options?: OpenAIRequestOptions,
        ): Promise<OpenAIChatCompletion> {
          calls.push(params);
          requestOptions.push(options);
          const error = errors[errorIndex];
          if (error && errorIndex < errors.length) {
            errorIndex++;
            throw error;
          }
          const response = responses[responseIndex];
          if (!response) {
            throw new Error(
              `MockOpenAIClient: no response at index ${responseIndex} (${responses.length} total)`,
            );
          }
          responseIndex++;
          return response;
        },
      },
    },
  };
}

export interface MockOpenAIStreamingClient extends OpenAIStreamingClient {
  _calls: OpenAIChatCompletionCreateRequest[];
  /** The request options (second `create` argument) recorded per call. */
  _requestOptions: Array<OpenAIRequestOptions | undefined>;
  _chunkSequences: OpenAIChatCompletionChunk[][];
  _errors: Error[];
}

/**
 * Creates a mock OpenAI streaming client that yields queued chunk sequences.
 *
 * When `errorAfterEvents` is set, the async generator yields that many chunks
 * from the current sequence before throwing the next error from `errors`.
 */
export function createMockOpenAIStreamingClient(
  chunkSequences: OpenAIChatCompletionChunk[][],
  errors: Error[] = [],
  options?: { errorAfterEvents?: number },
): MockOpenAIStreamingClient {
  const calls: OpenAIChatCompletionCreateRequest[] = [];
  const requestOptions: Array<OpenAIRequestOptions | undefined> = [];
  let sequenceIndex = 0;
  let errorIndex = 0;
  const errorAfterEvents = options?.errorAfterEvents;

  return {
    _calls: calls,
    _requestOptions: requestOptions,
    _chunkSequences: chunkSequences,
    _errors: errors,
    chat: {
      completions: {
        create(
          params: OpenAIChatCompletionCreateRequest,
          createOptions?: OpenAIRequestOptions,
        ): AsyncIterable<OpenAIChatCompletionChunk> {
          calls.push(params);
          requestOptions.push(createOptions);
          const error = errors[errorIndex];
          if (error && errorIndex < errors.length && errorAfterEvents === undefined) {
            errorIndex++;
            throw error;
          }
          const chunks = chunkSequences[sequenceIndex++] ?? [];
          const midStreamError =
            errorAfterEvents !== undefined && errorIndex < errors.length
              ? errors[errorIndex++]
              : undefined;
          const threshold = errorAfterEvents ?? 0;

          return (async function* () {
            let yielded = 0;
            for (const chunk of chunks) {
              if (midStreamError && yielded >= threshold) {
                throw midStreamError;
              }
              yield chunk;
              yielded++;
            }
            if (midStreamError && yielded <= threshold) {
              throw midStreamError;
            }
          })();
        },
      },
    },
  };
}
