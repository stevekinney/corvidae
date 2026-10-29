/**
 * Test doubles for the Gemini provider — `@lostgradient/operative-gemini/testing`.
 *
 * Canned `generateContent` responses and streaming chunks, and mock models that record the
 * requests they receive, so a test can drive `createGeminiProvider` and its siblings without the
 * Google Gen AI SDK or a network.
 *
 * @module operative-gemini/testing
 */

export {
  geminiFunctionCallResponse,
  geminiMixedResponse,
  geminiNoUsageResponse,
  geminiStreamEmptyChunks,
  geminiStreamFunctionCallChunks,
  geminiStreamMixedChunks,
  geminiStreamMultiFunctionCallChunks,
  geminiStreamTextChunks,
  geminiTextResponse,
} from './test/gemini-fixtures.ts';
export {
  createMockGeminiModel,
  createMockGeminiStreamingModel,
} from './test/gemini-mock-clients.ts';
export type { MockGeminiModel, MockGeminiStreamingModel } from './test/gemini-mock-clients.ts';
