/**
 * The Anthropic model provider for Operative — `@lostgradient/operative-anthropic`.
 *
 * {@link anthropicProvider} is the definition a host registers with Operative's provider
 * machinery; {@link createAnthropicProvider} and {@link createAnthropicProviderStream} are the
 * factories it wraps. The Anthropic SDK loads on first call, so a host that never reaches this
 * provider never loads it. Everything else exported here is what those factories are built from:
 * the structural client types a test or a proxy can satisfy, the request builders, the thinking
 * and tool-choice rules, the batch client, the token counter, and the stream normalizer. The
 * doubles that exercise them are in `@lostgradient/operative-anthropic/testing`.
 *
 * @module operative-anthropic
 */

export {
  ANTHROPIC_CONTROL_EVENT_TYPES,
  anthropicOpeningState,
  anthropicPartFromBlock,
  anthropicPartsFromBlocks,
  isAnthropicPartBlock,
} from './anthropic-blocks.ts';
export { anthropicProvider } from './anthropic-definition.ts';
export type { AnthropicProviderConfiguration } from './anthropic-definition.ts';
export {
  createAnthropicSdkClient,
  isAnthropicClient,
  isAnthropicStreamingClient,
  isAnthropicTokenCountingClient,
} from './anthropic-sdk.ts';
export {
  anthropicDescriptorsFor,
  assertDisabledThinkingSupported,
  assertManualThinkingSupported,
  assertSamplingParametersSupported,
  assertThinkingBudgetBelowMaximum,
  assertThinkingBudgetMeetsMinimum,
  assertThinkingParametersCompatible,
  assertToolChoiceSupported,
  buildAnthropicMessageRequest,
  buildAnthropicUsage,
} from './anthropic-shared.ts';
export { createAnthropicProviderStream } from './anthropic-stream.ts';
export {
  ANTHROPIC_DISABLED_THINKING,
  ANTHROPIC_MANUAL_THINKING,
  EFFORTS_THAT_FORBID_DISABLED_THINKING,
  anthropicDisabledThinkingRule,
  anthropicRejectsManualThinking,
} from './anthropic-thinking.ts';
export type { DisabledThinkingRule } from './anthropic-thinking.ts';
export { createAnthropicTokenCounter } from './anthropic-token-counter.ts';
export type {
  AnthropicTokenCounterOptions,
  AnthropicTokenCountingOperations,
} from './anthropic-token-counter.ts';
export {
  ANTHROPIC_FORCED_TOOL_CHOICE_REJECTED,
  toAnthropicToolChoice,
} from './anthropic-tool-choice.ts';
export type {
  AnthropicBatchClient,
  AnthropicBatchCreateRequest,
  AnthropicBatchCreateRequestItem,
  AnthropicBatchListQuery,
  AnthropicClient,
  AnthropicCountTokensRequest,
  AnthropicMessageBatch,
  AnthropicMessageBatchIndividualResponse,
  AnthropicMessageBatchRequestCounts,
  AnthropicMessageBatchResult,
  AnthropicMessageCreateRequest,
  AnthropicMessageResponse,
  AnthropicProviderOptions,
  AnthropicRequestOptions,
  AnthropicStreamEvent,
  AnthropicStreamingClient,
  AnthropicThinkingConfig,
  AnthropicTokenCountingClient,
} from './anthropic-types.ts';
export { createAnthropicProvider } from './anthropic.ts';
export { createAnthropicBatchClient } from './batches/anthropic.ts';
export type { AnthropicBatchClientOptions, AnthropicBatchOperations } from './batches/anthropic.ts';
export { normalizeAnthropicStream } from './streaming/normalize-anthropic.ts';
