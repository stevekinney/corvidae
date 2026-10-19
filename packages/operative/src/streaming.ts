import {
  readBackendDescriptors,
  withBackendDescriptors,
} from './providers/backend-descriptor-attachment';
import { createStreamingRow } from './streaming/streaming-row';
import type {
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  StreamingGenerateFunction,
} from './types';

/**
 * Wraps a streaming generate function into a standard GenerateFunction.
 *
 * The wrapper manages the streaming lifecycle on the Conversation:
 * appendStreamingMessage → updateStreamingMessage → finalizeStreamingMessage. The row it
 * finalizes carries the response's settled parts (thinking, server-tool blocks, generated
 * media admitted as managed assets), not only its text, and the response it returns names the
 * row in `messageId`. A response with no parts commits no row.
 *
 * Propagates `fn`'s attached `BackendDescriptor`(s) (AB-64, AB-245) onto the
 * returned wrapper — without this, `createAgent({ generate:
 * withStreaming(createOpenAIProviderStream(...)) })`, the documented way to
 * use a streaming provider factory as an Agent's `generate`, would silently
 * lose the descriptor the factory attached and report `mode: 'opaque'`.
 */
export function withStreaming(fn: StreamingGenerateFunction): GenerateFunction {
  const wrapped: GenerateFunction = async (context: GenerateContext): Promise<GenerateResponse> => {
    const row = createStreamingRow({ conversation: context.conversation, context });

    try {
      const response = await fn({ ...context, streaming: row.handle });
      return await row.finish(response);
    } catch (error) {
      await row.abandon();
      throw error;
    }
  };

  return withBackendDescriptors(wrapped, readBackendDescriptors(fn));
}
