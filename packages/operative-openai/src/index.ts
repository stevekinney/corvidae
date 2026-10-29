/**
 * The OpenAI model provider for Operative — `@lostgradient/operative-openai`.
 *
 * {@link openaiProvider} is the definition a host registers with Operative's provider machinery;
 * {@link createOpenAIProvider} and {@link createOpenAIProviderStream} are the factories it wraps.
 * The OpenAI SDK loads on first call, so a host that never reaches this provider never loads it.
 * The same factories work against any OpenAI-compatible endpoint (LM Studio, Ollama, Groq, and
 * the like) through `baseURL`. Everything else exported here is what those factories are built
 * from: the structural client types a test or a proxy can satisfy, the response-format and
 * tool-choice mappers, the message mapper, the batch client, the embedder, and the stream
 * normalizer. The doubles that exercise them are in `@lostgradient/operative-openai/testing`.
 *
 * @module operative-openai
 */

export { createOpenAIBatchClient } from './batches/openai.ts';
export type { OpenAIBatchClientOptions, OpenAIBatchOperations } from './batches/openai.ts';
export { createOpenAIEmbedder } from './embeddings/openai.ts';
export type { OpenAIEmbedderOptions, OpenAIEmbeddingClient } from './embeddings/openai.ts';
export { openaiProvider } from './openai-definition.ts';
export type { OpenAIProviderConfiguration } from './openai-definition.ts';
export { mapOpenAIMessage, mergeAssembledField } from './openai-parts.ts';
export type { OpenAIMessageMapping } from './openai-parts.ts';
export { toOpenAIResponseFormat } from './openai-response-format.ts';
export { toOpenAIToolChoice } from './openai-tool-choice.ts';
export type {
  OpenAIBatch,
  OpenAIBatchClient,
  OpenAIBatchCreateRequest,
  OpenAIBatchListQuery,
  OpenAIBatchRequestCounts,
  OpenAIChatCompletion,
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionCreateRequest,
  OpenAIClient,
  OpenAIProviderOptions,
  OpenAIRequestOptions,
  OpenAIStreamingClient,
} from './openai-types.ts';
export { createOpenAIProvider, createOpenAIProviderStream } from './openai.ts';
export { normalizeOpenAIStream } from './streaming/normalize-openai.ts';
