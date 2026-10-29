/**
 * Native batch-inference clients, one per provider that has a batch endpoint.
 *
 * One factory per provider that has a native asynchronous batch API. OpenAI and
 * Gemini get one here; Anthropic's lives in `@lostgradient/operative-anthropic`
 * beside the rest of that provider. An OpenAI-compatible
 * local server — Ollama, vLLM, LM Studio — does not: it reuses OpenAI's chat
 * shape and implements no `/v1/batches`, so there is deliberately nothing here
 * to import for it. That is the whole convention: a capability a provider does
 * not have is absent at compile time, never a factory that throws or no-ops at
 * runtime. `getProviderCapabilities` in `providers/capabilities.ts` reports the
 * same fact for code that picks a provider dynamically.
 *
 * The surfaces are not unified, because the providers' are not. See each
 * module's `*BatchOperations` interface for what its provider actually offers.
 */
export { createGeminiBatchClient } from './gemini.ts';
export type { GeminiBatchClientOptions, GeminiBatchOperations } from './gemini.ts';
export { createOpenAIBatchClient } from './openai.ts';
export type { OpenAIBatchClientOptions, OpenAIBatchOperations } from './openai.ts';
