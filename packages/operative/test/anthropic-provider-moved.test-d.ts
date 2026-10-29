/**
 * Compile-time half of `anthropic-provider-moved.test.ts`: the Anthropic types that moved to
 * `@lostgradient/operative-anthropic` are exported by none of Operative's entry points or provider
 * barrels. Each alias below must fail to compile; a type that is exported again turns its
 * `@ts-expect-error` into an unused-directive error, so `tsc` fails.
 *
 * The aliases use `import()` types rather than `import type` declarations, because the formatter
 * removes an import whose binding nothing reads, and with it the assertion.
 */

// prettier-ignore
// @ts-expect-error `AnthropicBatchClient` moved to @lostgradient/operative-anthropic.
export type RootAnthropicBatchClient = import('@lostgradient/operative').AnthropicBatchClient;
// prettier-ignore
// @ts-expect-error `AnthropicBatchClientOptions` moved to @lostgradient/operative-anthropic.
export type RootAnthropicBatchClientOptions = import('@lostgradient/operative').AnthropicBatchClientOptions;
// prettier-ignore
// @ts-expect-error `AnthropicBatchCreateRequest` moved to @lostgradient/operative-anthropic.
export type RootAnthropicBatchCreateRequest = import('@lostgradient/operative').AnthropicBatchCreateRequest;
// prettier-ignore
// @ts-expect-error `AnthropicBatchCreateRequestItem` moved to @lostgradient/operative-anthropic.
export type RootAnthropicBatchCreateRequestItem = import('@lostgradient/operative').AnthropicBatchCreateRequestItem;
// prettier-ignore
// @ts-expect-error `AnthropicBatchListQuery` moved to @lostgradient/operative-anthropic.
export type RootAnthropicBatchListQuery = import('@lostgradient/operative').AnthropicBatchListQuery;
// prettier-ignore
// @ts-expect-error `AnthropicBatchOperations` moved to @lostgradient/operative-anthropic.
export type RootAnthropicBatchOperations = import('@lostgradient/operative').AnthropicBatchOperations;
// prettier-ignore
// @ts-expect-error `AnthropicClient` moved to @lostgradient/operative-anthropic.
export type RootAnthropicClient = import('@lostgradient/operative').AnthropicClient;
// prettier-ignore
// @ts-expect-error `AnthropicCountTokensRequest` moved to @lostgradient/operative-anthropic.
export type RootAnthropicCountTokensRequest = import('@lostgradient/operative').AnthropicCountTokensRequest;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatch` moved to @lostgradient/operative-anthropic.
export type RootAnthropicMessageBatch = import('@lostgradient/operative').AnthropicMessageBatch;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchIndividualResponse` moved to @lostgradient/operative-anthropic.
export type RootAnthropicMessageBatchIndividualResponse = import('@lostgradient/operative').AnthropicMessageBatchIndividualResponse;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchRequestCounts` moved to @lostgradient/operative-anthropic.
export type RootAnthropicMessageBatchRequestCounts = import('@lostgradient/operative').AnthropicMessageBatchRequestCounts;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchResult` moved to @lostgradient/operative-anthropic.
export type RootAnthropicMessageBatchResult = import('@lostgradient/operative').AnthropicMessageBatchResult;
// prettier-ignore
// @ts-expect-error `AnthropicMessageCreateRequest` moved to @lostgradient/operative-anthropic.
export type RootAnthropicMessageCreateRequest = import('@lostgradient/operative').AnthropicMessageCreateRequest;
// prettier-ignore
// @ts-expect-error `AnthropicMessageResponse` moved to @lostgradient/operative-anthropic.
export type RootAnthropicMessageResponse = import('@lostgradient/operative').AnthropicMessageResponse;
// prettier-ignore
// @ts-expect-error `AnthropicProviderConfiguration` moved to @lostgradient/operative-anthropic.
export type RootAnthropicProviderConfiguration = import('@lostgradient/operative').AnthropicProviderConfiguration;
// prettier-ignore
// @ts-expect-error `AnthropicProviderOptions` moved to @lostgradient/operative-anthropic.
export type RootAnthropicProviderOptions = import('@lostgradient/operative').AnthropicProviderOptions;
// prettier-ignore
// @ts-expect-error `AnthropicRequestOptions` moved to @lostgradient/operative-anthropic.
export type RootAnthropicRequestOptions = import('@lostgradient/operative').AnthropicRequestOptions;
// prettier-ignore
// @ts-expect-error `AnthropicStreamEvent` moved to @lostgradient/operative-anthropic.
export type RootAnthropicStreamEvent = import('@lostgradient/operative').AnthropicStreamEvent;
// prettier-ignore
// @ts-expect-error `AnthropicStreamingClient` moved to @lostgradient/operative-anthropic.
export type RootAnthropicStreamingClient = import('@lostgradient/operative').AnthropicStreamingClient;
// prettier-ignore
// @ts-expect-error `AnthropicThinkingConfig` moved to @lostgradient/operative-anthropic.
export type RootAnthropicThinkingConfig = import('@lostgradient/operative').AnthropicThinkingConfig;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCounterOptions` moved to @lostgradient/operative-anthropic.
export type RootAnthropicTokenCounterOptions = import('@lostgradient/operative').AnthropicTokenCounterOptions;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCountingClient` moved to @lostgradient/operative-anthropic.
export type RootAnthropicTokenCountingClient = import('@lostgradient/operative').AnthropicTokenCountingClient;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCountingOperations` moved to @lostgradient/operative-anthropic.
export type RootAnthropicTokenCountingOperations = import('@lostgradient/operative').AnthropicTokenCountingOperations;
// prettier-ignore
// @ts-expect-error `DisabledThinkingRule` moved to @lostgradient/operative-anthropic.
export type RootDisabledThinkingRule = import('@lostgradient/operative').DisabledThinkingRule;
// prettier-ignore
// @ts-expect-error `MockAnthropicClient` moved to @lostgradient/operative-anthropic.
export type RootMockAnthropicClient = import('@lostgradient/operative').MockAnthropicClient;
// prettier-ignore
// @ts-expect-error `MockAnthropicStreamingClient` moved to @lostgradient/operative-anthropic.
export type RootMockAnthropicStreamingClient = import('@lostgradient/operative').MockAnthropicStreamingClient;

// prettier-ignore
// @ts-expect-error `AnthropicBatchClient` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicBatchClient = import('@lostgradient/operative/provider-kit').AnthropicBatchClient;
// prettier-ignore
// @ts-expect-error `AnthropicBatchClientOptions` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicBatchClientOptions = import('@lostgradient/operative/provider-kit').AnthropicBatchClientOptions;
// prettier-ignore
// @ts-expect-error `AnthropicBatchCreateRequest` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicBatchCreateRequest = import('@lostgradient/operative/provider-kit').AnthropicBatchCreateRequest;
// prettier-ignore
// @ts-expect-error `AnthropicBatchCreateRequestItem` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicBatchCreateRequestItem = import('@lostgradient/operative/provider-kit').AnthropicBatchCreateRequestItem;
// prettier-ignore
// @ts-expect-error `AnthropicBatchListQuery` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicBatchListQuery = import('@lostgradient/operative/provider-kit').AnthropicBatchListQuery;
// prettier-ignore
// @ts-expect-error `AnthropicBatchOperations` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicBatchOperations = import('@lostgradient/operative/provider-kit').AnthropicBatchOperations;
// prettier-ignore
// @ts-expect-error `AnthropicClient` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicClient = import('@lostgradient/operative/provider-kit').AnthropicClient;
// prettier-ignore
// @ts-expect-error `AnthropicCountTokensRequest` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicCountTokensRequest = import('@lostgradient/operative/provider-kit').AnthropicCountTokensRequest;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatch` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicMessageBatch = import('@lostgradient/operative/provider-kit').AnthropicMessageBatch;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchIndividualResponse` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicMessageBatchIndividualResponse = import('@lostgradient/operative/provider-kit').AnthropicMessageBatchIndividualResponse;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchRequestCounts` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicMessageBatchRequestCounts = import('@lostgradient/operative/provider-kit').AnthropicMessageBatchRequestCounts;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchResult` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicMessageBatchResult = import('@lostgradient/operative/provider-kit').AnthropicMessageBatchResult;
// prettier-ignore
// @ts-expect-error `AnthropicMessageCreateRequest` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicMessageCreateRequest = import('@lostgradient/operative/provider-kit').AnthropicMessageCreateRequest;
// prettier-ignore
// @ts-expect-error `AnthropicMessageResponse` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicMessageResponse = import('@lostgradient/operative/provider-kit').AnthropicMessageResponse;
// prettier-ignore
// @ts-expect-error `AnthropicProviderConfiguration` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicProviderConfiguration = import('@lostgradient/operative/provider-kit').AnthropicProviderConfiguration;
// prettier-ignore
// @ts-expect-error `AnthropicProviderOptions` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicProviderOptions = import('@lostgradient/operative/provider-kit').AnthropicProviderOptions;
// prettier-ignore
// @ts-expect-error `AnthropicRequestOptions` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicRequestOptions = import('@lostgradient/operative/provider-kit').AnthropicRequestOptions;
// prettier-ignore
// @ts-expect-error `AnthropicStreamEvent` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicStreamEvent = import('@lostgradient/operative/provider-kit').AnthropicStreamEvent;
// prettier-ignore
// @ts-expect-error `AnthropicStreamingClient` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicStreamingClient = import('@lostgradient/operative/provider-kit').AnthropicStreamingClient;
// prettier-ignore
// @ts-expect-error `AnthropicThinkingConfig` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicThinkingConfig = import('@lostgradient/operative/provider-kit').AnthropicThinkingConfig;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCounterOptions` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicTokenCounterOptions = import('@lostgradient/operative/provider-kit').AnthropicTokenCounterOptions;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCountingClient` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicTokenCountingClient = import('@lostgradient/operative/provider-kit').AnthropicTokenCountingClient;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCountingOperations` moved to @lostgradient/operative-anthropic.
export type ProviderKitAnthropicTokenCountingOperations = import('@lostgradient/operative/provider-kit').AnthropicTokenCountingOperations;
// prettier-ignore
// @ts-expect-error `DisabledThinkingRule` moved to @lostgradient/operative-anthropic.
export type ProviderKitDisabledThinkingRule = import('@lostgradient/operative/provider-kit').DisabledThinkingRule;
// prettier-ignore
// @ts-expect-error `MockAnthropicClient` moved to @lostgradient/operative-anthropic.
export type ProviderKitMockAnthropicClient = import('@lostgradient/operative/provider-kit').MockAnthropicClient;
// prettier-ignore
// @ts-expect-error `MockAnthropicStreamingClient` moved to @lostgradient/operative-anthropic.
export type ProviderKitMockAnthropicStreamingClient = import('@lostgradient/operative/provider-kit').MockAnthropicStreamingClient;

// prettier-ignore
// @ts-expect-error `AnthropicBatchClient` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicBatchClient = import('@lostgradient/operative/provider-testing').AnthropicBatchClient;
// prettier-ignore
// @ts-expect-error `AnthropicBatchClientOptions` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicBatchClientOptions = import('@lostgradient/operative/provider-testing').AnthropicBatchClientOptions;
// prettier-ignore
// @ts-expect-error `AnthropicBatchCreateRequest` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicBatchCreateRequest = import('@lostgradient/operative/provider-testing').AnthropicBatchCreateRequest;
// prettier-ignore
// @ts-expect-error `AnthropicBatchCreateRequestItem` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicBatchCreateRequestItem = import('@lostgradient/operative/provider-testing').AnthropicBatchCreateRequestItem;
// prettier-ignore
// @ts-expect-error `AnthropicBatchListQuery` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicBatchListQuery = import('@lostgradient/operative/provider-testing').AnthropicBatchListQuery;
// prettier-ignore
// @ts-expect-error `AnthropicBatchOperations` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicBatchOperations = import('@lostgradient/operative/provider-testing').AnthropicBatchOperations;
// prettier-ignore
// @ts-expect-error `AnthropicClient` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicClient = import('@lostgradient/operative/provider-testing').AnthropicClient;
// prettier-ignore
// @ts-expect-error `AnthropicCountTokensRequest` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicCountTokensRequest = import('@lostgradient/operative/provider-testing').AnthropicCountTokensRequest;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatch` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicMessageBatch = import('@lostgradient/operative/provider-testing').AnthropicMessageBatch;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchIndividualResponse` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicMessageBatchIndividualResponse = import('@lostgradient/operative/provider-testing').AnthropicMessageBatchIndividualResponse;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchRequestCounts` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicMessageBatchRequestCounts = import('@lostgradient/operative/provider-testing').AnthropicMessageBatchRequestCounts;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchResult` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicMessageBatchResult = import('@lostgradient/operative/provider-testing').AnthropicMessageBatchResult;
// prettier-ignore
// @ts-expect-error `AnthropicMessageCreateRequest` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicMessageCreateRequest = import('@lostgradient/operative/provider-testing').AnthropicMessageCreateRequest;
// prettier-ignore
// @ts-expect-error `AnthropicMessageResponse` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicMessageResponse = import('@lostgradient/operative/provider-testing').AnthropicMessageResponse;
// prettier-ignore
// @ts-expect-error `AnthropicProviderConfiguration` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicProviderConfiguration = import('@lostgradient/operative/provider-testing').AnthropicProviderConfiguration;
// prettier-ignore
// @ts-expect-error `AnthropicProviderOptions` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicProviderOptions = import('@lostgradient/operative/provider-testing').AnthropicProviderOptions;
// prettier-ignore
// @ts-expect-error `AnthropicRequestOptions` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicRequestOptions = import('@lostgradient/operative/provider-testing').AnthropicRequestOptions;
// prettier-ignore
// @ts-expect-error `AnthropicStreamEvent` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicStreamEvent = import('@lostgradient/operative/provider-testing').AnthropicStreamEvent;
// prettier-ignore
// @ts-expect-error `AnthropicStreamingClient` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicStreamingClient = import('@lostgradient/operative/provider-testing').AnthropicStreamingClient;
// prettier-ignore
// @ts-expect-error `AnthropicThinkingConfig` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicThinkingConfig = import('@lostgradient/operative/provider-testing').AnthropicThinkingConfig;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCounterOptions` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicTokenCounterOptions = import('@lostgradient/operative/provider-testing').AnthropicTokenCounterOptions;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCountingClient` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicTokenCountingClient = import('@lostgradient/operative/provider-testing').AnthropicTokenCountingClient;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCountingOperations` moved to @lostgradient/operative-anthropic.
export type ProviderTestingAnthropicTokenCountingOperations = import('@lostgradient/operative/provider-testing').AnthropicTokenCountingOperations;
// prettier-ignore
// @ts-expect-error `DisabledThinkingRule` moved to @lostgradient/operative-anthropic.
export type ProviderTestingDisabledThinkingRule = import('@lostgradient/operative/provider-testing').DisabledThinkingRule;
// prettier-ignore
// @ts-expect-error `MockAnthropicClient` moved to @lostgradient/operative-anthropic.
export type ProviderTestingMockAnthropicClient = import('@lostgradient/operative/provider-testing').MockAnthropicClient;
// prettier-ignore
// @ts-expect-error `MockAnthropicStreamingClient` moved to @lostgradient/operative-anthropic.
export type ProviderTestingMockAnthropicStreamingClient = import('@lostgradient/operative/provider-testing').MockAnthropicStreamingClient;

// prettier-ignore
// @ts-expect-error `AnthropicBatchClient` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicBatchClient = import('../src/providers/index.ts').AnthropicBatchClient;
// prettier-ignore
// @ts-expect-error `AnthropicBatchClientOptions` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicBatchClientOptions = import('../src/providers/index.ts').AnthropicBatchClientOptions;
// prettier-ignore
// @ts-expect-error `AnthropicBatchCreateRequest` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicBatchCreateRequest = import('../src/providers/index.ts').AnthropicBatchCreateRequest;
// prettier-ignore
// @ts-expect-error `AnthropicBatchCreateRequestItem` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicBatchCreateRequestItem = import('../src/providers/index.ts').AnthropicBatchCreateRequestItem;
// prettier-ignore
// @ts-expect-error `AnthropicBatchListQuery` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicBatchListQuery = import('../src/providers/index.ts').AnthropicBatchListQuery;
// prettier-ignore
// @ts-expect-error `AnthropicBatchOperations` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicBatchOperations = import('../src/providers/index.ts').AnthropicBatchOperations;
// prettier-ignore
// @ts-expect-error `AnthropicClient` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicClient = import('../src/providers/index.ts').AnthropicClient;
// prettier-ignore
// @ts-expect-error `AnthropicCountTokensRequest` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicCountTokensRequest = import('../src/providers/index.ts').AnthropicCountTokensRequest;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatch` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicMessageBatch = import('../src/providers/index.ts').AnthropicMessageBatch;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchIndividualResponse` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicMessageBatchIndividualResponse = import('../src/providers/index.ts').AnthropicMessageBatchIndividualResponse;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchRequestCounts` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicMessageBatchRequestCounts = import('../src/providers/index.ts').AnthropicMessageBatchRequestCounts;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchResult` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicMessageBatchResult = import('../src/providers/index.ts').AnthropicMessageBatchResult;
// prettier-ignore
// @ts-expect-error `AnthropicMessageCreateRequest` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicMessageCreateRequest = import('../src/providers/index.ts').AnthropicMessageCreateRequest;
// prettier-ignore
// @ts-expect-error `AnthropicMessageResponse` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicMessageResponse = import('../src/providers/index.ts').AnthropicMessageResponse;
// prettier-ignore
// @ts-expect-error `AnthropicProviderConfiguration` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicProviderConfiguration = import('../src/providers/index.ts').AnthropicProviderConfiguration;
// prettier-ignore
// @ts-expect-error `AnthropicProviderOptions` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicProviderOptions = import('../src/providers/index.ts').AnthropicProviderOptions;
// prettier-ignore
// @ts-expect-error `AnthropicRequestOptions` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicRequestOptions = import('../src/providers/index.ts').AnthropicRequestOptions;
// prettier-ignore
// @ts-expect-error `AnthropicStreamEvent` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicStreamEvent = import('../src/providers/index.ts').AnthropicStreamEvent;
// prettier-ignore
// @ts-expect-error `AnthropicStreamingClient` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicStreamingClient = import('../src/providers/index.ts').AnthropicStreamingClient;
// prettier-ignore
// @ts-expect-error `AnthropicThinkingConfig` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicThinkingConfig = import('../src/providers/index.ts').AnthropicThinkingConfig;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCounterOptions` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicTokenCounterOptions = import('../src/providers/index.ts').AnthropicTokenCounterOptions;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCountingClient` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicTokenCountingClient = import('../src/providers/index.ts').AnthropicTokenCountingClient;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCountingOperations` moved to @lostgradient/operative-anthropic.
export type ProvidersAnthropicTokenCountingOperations = import('../src/providers/index.ts').AnthropicTokenCountingOperations;
// prettier-ignore
// @ts-expect-error `DisabledThinkingRule` moved to @lostgradient/operative-anthropic.
export type ProvidersDisabledThinkingRule = import('../src/providers/index.ts').DisabledThinkingRule;
// prettier-ignore
// @ts-expect-error `MockAnthropicClient` moved to @lostgradient/operative-anthropic.
export type ProvidersMockAnthropicClient = import('../src/providers/index.ts').MockAnthropicClient;
// prettier-ignore
// @ts-expect-error `MockAnthropicStreamingClient` moved to @lostgradient/operative-anthropic.
export type ProvidersMockAnthropicStreamingClient = import('../src/providers/index.ts').MockAnthropicStreamingClient;

// prettier-ignore
// @ts-expect-error `AnthropicBatchClient` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicBatchClient = import('../src/providers/batches/index.ts').AnthropicBatchClient;
// prettier-ignore
// @ts-expect-error `AnthropicBatchClientOptions` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicBatchClientOptions = import('../src/providers/batches/index.ts').AnthropicBatchClientOptions;
// prettier-ignore
// @ts-expect-error `AnthropicBatchCreateRequest` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicBatchCreateRequest = import('../src/providers/batches/index.ts').AnthropicBatchCreateRequest;
// prettier-ignore
// @ts-expect-error `AnthropicBatchCreateRequestItem` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicBatchCreateRequestItem = import('../src/providers/batches/index.ts').AnthropicBatchCreateRequestItem;
// prettier-ignore
// @ts-expect-error `AnthropicBatchListQuery` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicBatchListQuery = import('../src/providers/batches/index.ts').AnthropicBatchListQuery;
// prettier-ignore
// @ts-expect-error `AnthropicBatchOperations` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicBatchOperations = import('../src/providers/batches/index.ts').AnthropicBatchOperations;
// prettier-ignore
// @ts-expect-error `AnthropicClient` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicClient = import('../src/providers/batches/index.ts').AnthropicClient;
// prettier-ignore
// @ts-expect-error `AnthropicCountTokensRequest` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicCountTokensRequest = import('../src/providers/batches/index.ts').AnthropicCountTokensRequest;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatch` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicMessageBatch = import('../src/providers/batches/index.ts').AnthropicMessageBatch;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchIndividualResponse` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicMessageBatchIndividualResponse = import('../src/providers/batches/index.ts').AnthropicMessageBatchIndividualResponse;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchRequestCounts` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicMessageBatchRequestCounts = import('../src/providers/batches/index.ts').AnthropicMessageBatchRequestCounts;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchResult` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicMessageBatchResult = import('../src/providers/batches/index.ts').AnthropicMessageBatchResult;
// prettier-ignore
// @ts-expect-error `AnthropicMessageCreateRequest` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicMessageCreateRequest = import('../src/providers/batches/index.ts').AnthropicMessageCreateRequest;
// prettier-ignore
// @ts-expect-error `AnthropicMessageResponse` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicMessageResponse = import('../src/providers/batches/index.ts').AnthropicMessageResponse;
// prettier-ignore
// @ts-expect-error `AnthropicProviderConfiguration` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicProviderConfiguration = import('../src/providers/batches/index.ts').AnthropicProviderConfiguration;
// prettier-ignore
// @ts-expect-error `AnthropicProviderOptions` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicProviderOptions = import('../src/providers/batches/index.ts').AnthropicProviderOptions;
// prettier-ignore
// @ts-expect-error `AnthropicRequestOptions` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicRequestOptions = import('../src/providers/batches/index.ts').AnthropicRequestOptions;
// prettier-ignore
// @ts-expect-error `AnthropicStreamEvent` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicStreamEvent = import('../src/providers/batches/index.ts').AnthropicStreamEvent;
// prettier-ignore
// @ts-expect-error `AnthropicStreamingClient` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicStreamingClient = import('../src/providers/batches/index.ts').AnthropicStreamingClient;
// prettier-ignore
// @ts-expect-error `AnthropicThinkingConfig` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicThinkingConfig = import('../src/providers/batches/index.ts').AnthropicThinkingConfig;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCounterOptions` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicTokenCounterOptions = import('../src/providers/batches/index.ts').AnthropicTokenCounterOptions;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCountingClient` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicTokenCountingClient = import('../src/providers/batches/index.ts').AnthropicTokenCountingClient;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCountingOperations` moved to @lostgradient/operative-anthropic.
export type BatchesAnthropicTokenCountingOperations = import('../src/providers/batches/index.ts').AnthropicTokenCountingOperations;
// prettier-ignore
// @ts-expect-error `DisabledThinkingRule` moved to @lostgradient/operative-anthropic.
export type BatchesDisabledThinkingRule = import('../src/providers/batches/index.ts').DisabledThinkingRule;
// prettier-ignore
// @ts-expect-error `MockAnthropicClient` moved to @lostgradient/operative-anthropic.
export type BatchesMockAnthropicClient = import('../src/providers/batches/index.ts').MockAnthropicClient;
// prettier-ignore
// @ts-expect-error `MockAnthropicStreamingClient` moved to @lostgradient/operative-anthropic.
export type BatchesMockAnthropicStreamingClient = import('../src/providers/batches/index.ts').MockAnthropicStreamingClient;

// prettier-ignore
// @ts-expect-error `AnthropicBatchClient` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicBatchClient = import('../src/providers/streaming/index.ts').AnthropicBatchClient;
// prettier-ignore
// @ts-expect-error `AnthropicBatchClientOptions` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicBatchClientOptions = import('../src/providers/streaming/index.ts').AnthropicBatchClientOptions;
// prettier-ignore
// @ts-expect-error `AnthropicBatchCreateRequest` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicBatchCreateRequest = import('../src/providers/streaming/index.ts').AnthropicBatchCreateRequest;
// prettier-ignore
// @ts-expect-error `AnthropicBatchCreateRequestItem` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicBatchCreateRequestItem = import('../src/providers/streaming/index.ts').AnthropicBatchCreateRequestItem;
// prettier-ignore
// @ts-expect-error `AnthropicBatchListQuery` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicBatchListQuery = import('../src/providers/streaming/index.ts').AnthropicBatchListQuery;
// prettier-ignore
// @ts-expect-error `AnthropicBatchOperations` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicBatchOperations = import('../src/providers/streaming/index.ts').AnthropicBatchOperations;
// prettier-ignore
// @ts-expect-error `AnthropicClient` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicClient = import('../src/providers/streaming/index.ts').AnthropicClient;
// prettier-ignore
// @ts-expect-error `AnthropicCountTokensRequest` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicCountTokensRequest = import('../src/providers/streaming/index.ts').AnthropicCountTokensRequest;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatch` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicMessageBatch = import('../src/providers/streaming/index.ts').AnthropicMessageBatch;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchIndividualResponse` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicMessageBatchIndividualResponse = import('../src/providers/streaming/index.ts').AnthropicMessageBatchIndividualResponse;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchRequestCounts` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicMessageBatchRequestCounts = import('../src/providers/streaming/index.ts').AnthropicMessageBatchRequestCounts;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchResult` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicMessageBatchResult = import('../src/providers/streaming/index.ts').AnthropicMessageBatchResult;
// prettier-ignore
// @ts-expect-error `AnthropicMessageCreateRequest` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicMessageCreateRequest = import('../src/providers/streaming/index.ts').AnthropicMessageCreateRequest;
// prettier-ignore
// @ts-expect-error `AnthropicMessageResponse` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicMessageResponse = import('../src/providers/streaming/index.ts').AnthropicMessageResponse;
// prettier-ignore
// @ts-expect-error `AnthropicProviderConfiguration` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicProviderConfiguration = import('../src/providers/streaming/index.ts').AnthropicProviderConfiguration;
// prettier-ignore
// @ts-expect-error `AnthropicProviderOptions` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicProviderOptions = import('../src/providers/streaming/index.ts').AnthropicProviderOptions;
// prettier-ignore
// @ts-expect-error `AnthropicRequestOptions` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicRequestOptions = import('../src/providers/streaming/index.ts').AnthropicRequestOptions;
// prettier-ignore
// @ts-expect-error `AnthropicStreamEvent` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicStreamEvent = import('../src/providers/streaming/index.ts').AnthropicStreamEvent;
// prettier-ignore
// @ts-expect-error `AnthropicStreamingClient` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicStreamingClient = import('../src/providers/streaming/index.ts').AnthropicStreamingClient;
// prettier-ignore
// @ts-expect-error `AnthropicThinkingConfig` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicThinkingConfig = import('../src/providers/streaming/index.ts').AnthropicThinkingConfig;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCounterOptions` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicTokenCounterOptions = import('../src/providers/streaming/index.ts').AnthropicTokenCounterOptions;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCountingClient` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicTokenCountingClient = import('../src/providers/streaming/index.ts').AnthropicTokenCountingClient;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCountingOperations` moved to @lostgradient/operative-anthropic.
export type StreamingAnthropicTokenCountingOperations = import('../src/providers/streaming/index.ts').AnthropicTokenCountingOperations;
// prettier-ignore
// @ts-expect-error `DisabledThinkingRule` moved to @lostgradient/operative-anthropic.
export type StreamingDisabledThinkingRule = import('../src/providers/streaming/index.ts').DisabledThinkingRule;
// prettier-ignore
// @ts-expect-error `MockAnthropicClient` moved to @lostgradient/operative-anthropic.
export type StreamingMockAnthropicClient = import('../src/providers/streaming/index.ts').MockAnthropicClient;
// prettier-ignore
// @ts-expect-error `MockAnthropicStreamingClient` moved to @lostgradient/operative-anthropic.
export type StreamingMockAnthropicStreamingClient = import('../src/providers/streaming/index.ts').MockAnthropicStreamingClient;

// prettier-ignore
// @ts-expect-error `AnthropicBatchClient` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicBatchClient = import('../src/providers/structured-output/index.ts').AnthropicBatchClient;
// prettier-ignore
// @ts-expect-error `AnthropicBatchClientOptions` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicBatchClientOptions = import('../src/providers/structured-output/index.ts').AnthropicBatchClientOptions;
// prettier-ignore
// @ts-expect-error `AnthropicBatchCreateRequest` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicBatchCreateRequest = import('../src/providers/structured-output/index.ts').AnthropicBatchCreateRequest;
// prettier-ignore
// @ts-expect-error `AnthropicBatchCreateRequestItem` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicBatchCreateRequestItem = import('../src/providers/structured-output/index.ts').AnthropicBatchCreateRequestItem;
// prettier-ignore
// @ts-expect-error `AnthropicBatchListQuery` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicBatchListQuery = import('../src/providers/structured-output/index.ts').AnthropicBatchListQuery;
// prettier-ignore
// @ts-expect-error `AnthropicBatchOperations` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicBatchOperations = import('../src/providers/structured-output/index.ts').AnthropicBatchOperations;
// prettier-ignore
// @ts-expect-error `AnthropicClient` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicClient = import('../src/providers/structured-output/index.ts').AnthropicClient;
// prettier-ignore
// @ts-expect-error `AnthropicCountTokensRequest` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicCountTokensRequest = import('../src/providers/structured-output/index.ts').AnthropicCountTokensRequest;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatch` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicMessageBatch = import('../src/providers/structured-output/index.ts').AnthropicMessageBatch;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchIndividualResponse` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicMessageBatchIndividualResponse = import('../src/providers/structured-output/index.ts').AnthropicMessageBatchIndividualResponse;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchRequestCounts` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicMessageBatchRequestCounts = import('../src/providers/structured-output/index.ts').AnthropicMessageBatchRequestCounts;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchResult` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicMessageBatchResult = import('../src/providers/structured-output/index.ts').AnthropicMessageBatchResult;
// prettier-ignore
// @ts-expect-error `AnthropicMessageCreateRequest` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicMessageCreateRequest = import('../src/providers/structured-output/index.ts').AnthropicMessageCreateRequest;
// prettier-ignore
// @ts-expect-error `AnthropicMessageResponse` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicMessageResponse = import('../src/providers/structured-output/index.ts').AnthropicMessageResponse;
// prettier-ignore
// @ts-expect-error `AnthropicProviderConfiguration` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicProviderConfiguration = import('../src/providers/structured-output/index.ts').AnthropicProviderConfiguration;
// prettier-ignore
// @ts-expect-error `AnthropicProviderOptions` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicProviderOptions = import('../src/providers/structured-output/index.ts').AnthropicProviderOptions;
// prettier-ignore
// @ts-expect-error `AnthropicRequestOptions` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicRequestOptions = import('../src/providers/structured-output/index.ts').AnthropicRequestOptions;
// prettier-ignore
// @ts-expect-error `AnthropicStreamEvent` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicStreamEvent = import('../src/providers/structured-output/index.ts').AnthropicStreamEvent;
// prettier-ignore
// @ts-expect-error `AnthropicStreamingClient` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicStreamingClient = import('../src/providers/structured-output/index.ts').AnthropicStreamingClient;
// prettier-ignore
// @ts-expect-error `AnthropicThinkingConfig` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicThinkingConfig = import('../src/providers/structured-output/index.ts').AnthropicThinkingConfig;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCounterOptions` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicTokenCounterOptions = import('../src/providers/structured-output/index.ts').AnthropicTokenCounterOptions;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCountingClient` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicTokenCountingClient = import('../src/providers/structured-output/index.ts').AnthropicTokenCountingClient;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCountingOperations` moved to @lostgradient/operative-anthropic.
export type StructuredOutputAnthropicTokenCountingOperations = import('../src/providers/structured-output/index.ts').AnthropicTokenCountingOperations;
// prettier-ignore
// @ts-expect-error `DisabledThinkingRule` moved to @lostgradient/operative-anthropic.
export type StructuredOutputDisabledThinkingRule = import('../src/providers/structured-output/index.ts').DisabledThinkingRule;
// prettier-ignore
// @ts-expect-error `MockAnthropicClient` moved to @lostgradient/operative-anthropic.
export type StructuredOutputMockAnthropicClient = import('../src/providers/structured-output/index.ts').MockAnthropicClient;
// prettier-ignore
// @ts-expect-error `MockAnthropicStreamingClient` moved to @lostgradient/operative-anthropic.
export type StructuredOutputMockAnthropicStreamingClient = import('../src/providers/structured-output/index.ts').MockAnthropicStreamingClient;

// prettier-ignore
// @ts-expect-error `AnthropicBatchClient` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicBatchClient = import('../src/providers/test/index.ts').AnthropicBatchClient;
// prettier-ignore
// @ts-expect-error `AnthropicBatchClientOptions` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicBatchClientOptions = import('../src/providers/test/index.ts').AnthropicBatchClientOptions;
// prettier-ignore
// @ts-expect-error `AnthropicBatchCreateRequest` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicBatchCreateRequest = import('../src/providers/test/index.ts').AnthropicBatchCreateRequest;
// prettier-ignore
// @ts-expect-error `AnthropicBatchCreateRequestItem` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicBatchCreateRequestItem = import('../src/providers/test/index.ts').AnthropicBatchCreateRequestItem;
// prettier-ignore
// @ts-expect-error `AnthropicBatchListQuery` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicBatchListQuery = import('../src/providers/test/index.ts').AnthropicBatchListQuery;
// prettier-ignore
// @ts-expect-error `AnthropicBatchOperations` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicBatchOperations = import('../src/providers/test/index.ts').AnthropicBatchOperations;
// prettier-ignore
// @ts-expect-error `AnthropicClient` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicClient = import('../src/providers/test/index.ts').AnthropicClient;
// prettier-ignore
// @ts-expect-error `AnthropicCountTokensRequest` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicCountTokensRequest = import('../src/providers/test/index.ts').AnthropicCountTokensRequest;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatch` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicMessageBatch = import('../src/providers/test/index.ts').AnthropicMessageBatch;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchIndividualResponse` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicMessageBatchIndividualResponse = import('../src/providers/test/index.ts').AnthropicMessageBatchIndividualResponse;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchRequestCounts` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicMessageBatchRequestCounts = import('../src/providers/test/index.ts').AnthropicMessageBatchRequestCounts;
// prettier-ignore
// @ts-expect-error `AnthropicMessageBatchResult` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicMessageBatchResult = import('../src/providers/test/index.ts').AnthropicMessageBatchResult;
// prettier-ignore
// @ts-expect-error `AnthropicMessageCreateRequest` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicMessageCreateRequest = import('../src/providers/test/index.ts').AnthropicMessageCreateRequest;
// prettier-ignore
// @ts-expect-error `AnthropicMessageResponse` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicMessageResponse = import('../src/providers/test/index.ts').AnthropicMessageResponse;
// prettier-ignore
// @ts-expect-error `AnthropicProviderConfiguration` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicProviderConfiguration = import('../src/providers/test/index.ts').AnthropicProviderConfiguration;
// prettier-ignore
// @ts-expect-error `AnthropicProviderOptions` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicProviderOptions = import('../src/providers/test/index.ts').AnthropicProviderOptions;
// prettier-ignore
// @ts-expect-error `AnthropicRequestOptions` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicRequestOptions = import('../src/providers/test/index.ts').AnthropicRequestOptions;
// prettier-ignore
// @ts-expect-error `AnthropicStreamEvent` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicStreamEvent = import('../src/providers/test/index.ts').AnthropicStreamEvent;
// prettier-ignore
// @ts-expect-error `AnthropicStreamingClient` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicStreamingClient = import('../src/providers/test/index.ts').AnthropicStreamingClient;
// prettier-ignore
// @ts-expect-error `AnthropicThinkingConfig` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicThinkingConfig = import('../src/providers/test/index.ts').AnthropicThinkingConfig;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCounterOptions` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicTokenCounterOptions = import('../src/providers/test/index.ts').AnthropicTokenCounterOptions;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCountingClient` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicTokenCountingClient = import('../src/providers/test/index.ts').AnthropicTokenCountingClient;
// prettier-ignore
// @ts-expect-error `AnthropicTokenCountingOperations` moved to @lostgradient/operative-anthropic.
export type TestDoublesAnthropicTokenCountingOperations = import('../src/providers/test/index.ts').AnthropicTokenCountingOperations;
// prettier-ignore
// @ts-expect-error `DisabledThinkingRule` moved to @lostgradient/operative-anthropic.
export type TestDoublesDisabledThinkingRule = import('../src/providers/test/index.ts').DisabledThinkingRule;
// prettier-ignore
// @ts-expect-error `MockAnthropicClient` moved to @lostgradient/operative-anthropic.
export type TestDoublesMockAnthropicClient = import('../src/providers/test/index.ts').MockAnthropicClient;
// prettier-ignore
// @ts-expect-error `MockAnthropicStreamingClient` moved to @lostgradient/operative-anthropic.
export type TestDoublesMockAnthropicStreamingClient = import('../src/providers/test/index.ts').MockAnthropicStreamingClient;
