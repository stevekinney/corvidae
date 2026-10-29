import type {
  GeminiGenerateContentRequest,
  GeminiGenerateContentResult,
  GeminiGenerativeModel,
  GeminiStreamingModel,
} from '../gemini-types.ts';

/** A mock Gemini client: records every `generateContent` request it receives and returns the queued responses. */
export interface MockGeminiModel extends GeminiGenerativeModel {
  /** Every request the mock received, in order. */
  _calls: GeminiGenerateContentRequest[];
  /** The queued responses, returned one per call. */
  _responses: GeminiGenerateContentResult[];
  /** The queued errors, thrown before any response, one per call. */
  _errors: Error[];
}

/**
 * Creates a mock `@google/genai` client that records calls and returns queued
 * responses. Calls land on the `models` namespace, matching the maintained SDK.
 */
export function createMockGeminiModel(
  responses: GeminiGenerateContentResult[],
  errors: Error[] = [],
): MockGeminiModel {
  const calls: GeminiGenerateContentRequest[] = [];
  let responseIndex = 0;
  let errorIndex = 0;

  return {
    _calls: calls,
    _responses: responses,
    _errors: errors,
    models: {
      async generateContent(
        params: GeminiGenerateContentRequest,
      ): Promise<GeminiGenerateContentResult> {
        calls.push(params);
        const error = errors[errorIndex];
        if (error && errorIndex < errors.length) {
          errorIndex++;
          throw error;
        }
        const response = responses[responseIndex];
        if (!response) {
          throw new Error(
            `MockGeminiModel: no response at index ${responseIndex} (${responses.length} total)`,
          );
        }
        responseIndex++;
        return response;
      },
    },
  };
}

/** A mock streaming Gemini client: records every `generateContentStream` request and yields the queued chunk sequences. */
export interface MockGeminiStreamingModel extends GeminiStreamingModel {
  /** Every request the mock received, in order. */
  _calls: GeminiGenerateContentRequest[];
  /** The queued chunk sequences, one yielded per call. */
  _chunkSequences: GeminiGenerateContentResult[][];
  /** The queued errors, thrown mid-stream or before the stream, one per call. */
  _errors: Error[];
}

/**
 * Creates a mock `@google/genai` streaming client that yields queued chunk
 * sequences. `models.generateContentStream` resolves to the async iterable
 * directly, matching the maintained SDK — there is no `{ stream }` wrapper.
 *
 * When `errorAfterEvents` is set, the async generator yields that many chunks
 * from the current sequence before throwing the next error from `errors`.
 */
export function createMockGeminiStreamingModel(
  chunkSequences: GeminiGenerateContentResult[][],
  errors: Error[] = [],
  options?: { errorAfterEvents?: number },
): MockGeminiStreamingModel {
  const calls: GeminiGenerateContentRequest[] = [];
  let sequenceIndex = 0;
  let errorIndex = 0;
  const errorAfterEvents = options?.errorAfterEvents;

  return {
    _calls: calls,
    _chunkSequences: chunkSequences,
    _errors: errors,
    models: {
      async generateContentStream(
        params: GeminiGenerateContentRequest,
      ): Promise<AsyncIterable<GeminiGenerateContentResult>> {
        calls.push(params);
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
  };
}
