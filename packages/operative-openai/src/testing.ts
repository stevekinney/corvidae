/**
 * Test doubles for the OpenAI provider — `@lostgradient/operative-openai/testing`.
 *
 * Canned Chat Completions responses and streaming chunks, and mock clients that record the
 * requests they receive, so a test can drive `createOpenAIProvider` and its siblings without the
 * OpenAI SDK or a network.
 *
 * @module operative-openai/testing
 */

export {
  openAIMixedResponse,
  openAINoUsageResponse,
  openAIStreamEmptyChunks,
  openAIStreamMixedChunks,
  openAIStreamMultiToolChunks,
  openAIStreamTextChunks,
  openAIStreamToolCallChunks,
  openAITextResponse,
  openAIToolCallResponse,
} from './test/openai-fixtures.ts';
export {
  createMockOpenAIClient,
  createMockOpenAIStreamingClient,
} from './test/openai-mock-clients.ts';
export type { MockOpenAIClient, MockOpenAIStreamingClient } from './test/openai-mock-clients.ts';
