/**
 * Test doubles for the Anthropic provider — `@lostgradient/operative-anthropic/testing`.
 *
 * Canned Messages API responses and streaming events, and mock clients that record the requests
 * they receive, so a test can drive `createAnthropicProvider` and its siblings without the
 * Anthropic SDK or a network.
 *
 * @module operative-anthropic/testing
 */

export {
  anthropicMixedResponse,
  anthropicNoUsageResponse,
  anthropicStreamEmptyEvents,
  anthropicStreamMixedEvents,
  anthropicStreamMultiToolEvents,
  anthropicStreamTextEvents,
  anthropicStreamToolUseEvents,
  anthropicTextResponse,
  anthropicToolUseResponse,
} from './test/anthropic-fixtures.ts';
export {
  createMockAnthropicClient,
  createMockAnthropicStreamingClient,
} from './test/anthropic-mock-clients.ts';
export type {
  MockAnthropicClient,
  MockAnthropicStreamingClient,
} from './test/anthropic-mock-clients.ts';
