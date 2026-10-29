/**
 * The Gemini model provider for Operative — `@lostgradient/operative-gemini`.
 *
 * {@link geminiProvider} is the definition a host registers with Operative's provider machinery;
 * {@link createGeminiProvider} and {@link createGeminiProviderStream} are the factories it wraps.
 * The Google Gen AI SDK loads on first call, so a host that never reaches this provider never
 * loads it. Everything else exported here is what those factories are built from: the structural
 * client types a test or a proxy can satisfy, the response-format and tool-choice mappers, the
 * part mapper, the batch client, the token counter, the embedder, and the API-key resolver. The
 * doubles that exercise them are in `@lostgradient/operative-gemini/testing`. `GOOGLE_API_KEY`
 * is read by this package's own environment module, not by Operative.
 *
 * @module operative-gemini
 */

export { createGeminiBatchClient } from './batches/gemini.ts';
export type { GeminiBatchClientOptions, GeminiBatchOperations } from './batches/gemini.ts';
export { createGeminiEmbedder } from './embeddings/gemini.ts';
export type {
  GeminiEmbedderOptions,
  GeminiEmbeddingClient,
  GeminiEmbeddingModel,
} from './embeddings/gemini.ts';
export { resolveGeminiApiKey } from './gemini-api-key.ts';
export { geminiProvider } from './gemini-definition.ts';
export type { GeminiProviderConfiguration } from './gemini-definition.ts';
export {
  createGeminiPartMapper,
  droppedReplayDataMetadata,
  geminiViolationError,
} from './gemini-parts.ts';
export type { GeminiMapping, GeminiMappingViolation } from './gemini-parts.ts';
export { toGeminiResponseFormat } from './gemini-response-format.ts';
export { toGeminiToolChoice } from './gemini-tool-choice.ts';
export type {
  GeminiBatchClient,
  GeminiBatchJob,
  GeminiBatchJobReference,
  GeminiCacheCreatingClient,
  GeminiCachedContent,
  GeminiCountTokensRequest,
  GeminiCreateBatchJobRequest,
  GeminiCreateCachedContentRequest,
  GeminiDeleteResourceJob,
  GeminiGenerateContentRequest,
  GeminiGenerateContentResult,
  GeminiGenerativeModel,
  GeminiListBatchJobsRequest,
  GeminiProviderOptions,
  GeminiStreamingModel,
  GeminiTokenCountingClient,
  GeminiUsageMetadata,
} from './gemini-types.ts';
export {
  createGeminiProvider,
  createGeminiProviderStream,
  createGeminiTokenCounter,
} from './gemini.ts';
export type { GeminiTokenCounterOptions, GeminiTokenCountingOperations } from './gemini.ts';
