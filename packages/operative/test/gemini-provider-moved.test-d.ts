/**
 * Compile-time half of `gemini-provider-moved.test.ts`: the Gemini types that moved to
 * `@lostgradient/operative-gemini` are exported by none of Operative's entry points or provider
 * barrels. Each alias below must fail to compile; a type that is exported again turns its
 * `@ts-expect-error` into an unused-directive error, so `tsc` fails.
 *
 * The aliases use `import()` types rather than `import type` declarations, because the formatter
 * removes an import whose binding nothing reads, and with it the assertion.
 */
// prettier-ignore
// @ts-expect-error `GeminiBatchClient` moved to @lostgradient/operative-gemini.
export type RootGeminiBatchClient = import('@lostgradient/operative').GeminiBatchClient;
// prettier-ignore
// @ts-expect-error `GeminiBatchClientOptions` moved to @lostgradient/operative-gemini.
export type RootGeminiBatchClientOptions = import('@lostgradient/operative').GeminiBatchClientOptions;
// prettier-ignore
// @ts-expect-error `GeminiBatchJob` moved to @lostgradient/operative-gemini.
export type RootGeminiBatchJob = import('@lostgradient/operative').GeminiBatchJob;
// prettier-ignore
// @ts-expect-error `GeminiBatchJobReference` moved to @lostgradient/operative-gemini.
export type RootGeminiBatchJobReference = import('@lostgradient/operative').GeminiBatchJobReference;
// prettier-ignore
// @ts-expect-error `GeminiBatchOperations` moved to @lostgradient/operative-gemini.
export type RootGeminiBatchOperations = import('@lostgradient/operative').GeminiBatchOperations;
// prettier-ignore
// @ts-expect-error `GeminiCacheCreatingClient` moved to @lostgradient/operative-gemini.
export type RootGeminiCacheCreatingClient = import('@lostgradient/operative').GeminiCacheCreatingClient;
// prettier-ignore
// @ts-expect-error `GeminiCachedContent` moved to @lostgradient/operative-gemini.
export type RootGeminiCachedContent = import('@lostgradient/operative').GeminiCachedContent;
// prettier-ignore
// @ts-expect-error `GeminiCountTokensRequest` moved to @lostgradient/operative-gemini.
export type RootGeminiCountTokensRequest = import('@lostgradient/operative').GeminiCountTokensRequest;
// prettier-ignore
// @ts-expect-error `GeminiCreateBatchJobRequest` moved to @lostgradient/operative-gemini.
export type RootGeminiCreateBatchJobRequest = import('@lostgradient/operative').GeminiCreateBatchJobRequest;
// prettier-ignore
// @ts-expect-error `GeminiCreateCachedContentRequest` moved to @lostgradient/operative-gemini.
export type RootGeminiCreateCachedContentRequest = import('@lostgradient/operative').GeminiCreateCachedContentRequest;
// prettier-ignore
// @ts-expect-error `GeminiDeleteResourceJob` moved to @lostgradient/operative-gemini.
export type RootGeminiDeleteResourceJob = import('@lostgradient/operative').GeminiDeleteResourceJob;
// prettier-ignore
// @ts-expect-error `GeminiEmbedderOptions` moved to @lostgradient/operative-gemini.
export type RootGeminiEmbedderOptions = import('@lostgradient/operative').GeminiEmbedderOptions;
// prettier-ignore
// @ts-expect-error `GeminiEmbeddingClient` moved to @lostgradient/operative-gemini.
export type RootGeminiEmbeddingClient = import('@lostgradient/operative').GeminiEmbeddingClient;
// prettier-ignore
// @ts-expect-error `GeminiEmbeddingModel` moved to @lostgradient/operative-gemini.
export type RootGeminiEmbeddingModel = import('@lostgradient/operative').GeminiEmbeddingModel;
// prettier-ignore
// @ts-expect-error `GeminiGenerateContentRequest` moved to @lostgradient/operative-gemini.
export type RootGeminiGenerateContentRequest = import('@lostgradient/operative').GeminiGenerateContentRequest;
// prettier-ignore
// @ts-expect-error `GeminiGenerateContentResult` moved to @lostgradient/operative-gemini.
export type RootGeminiGenerateContentResult = import('@lostgradient/operative').GeminiGenerateContentResult;
// prettier-ignore
// @ts-expect-error `GeminiGenerativeModel` moved to @lostgradient/operative-gemini.
export type RootGeminiGenerativeModel = import('@lostgradient/operative').GeminiGenerativeModel;
// prettier-ignore
// @ts-expect-error `GeminiListBatchJobsRequest` moved to @lostgradient/operative-gemini.
export type RootGeminiListBatchJobsRequest = import('@lostgradient/operative').GeminiListBatchJobsRequest;
// prettier-ignore
// @ts-expect-error `GeminiMapping` moved to @lostgradient/operative-gemini.
export type RootGeminiMapping = import('@lostgradient/operative').GeminiMapping;
// prettier-ignore
// @ts-expect-error `GeminiMappingViolation` moved to @lostgradient/operative-gemini.
export type RootGeminiMappingViolation = import('@lostgradient/operative').GeminiMappingViolation;
// prettier-ignore
// @ts-expect-error `GeminiProviderConfiguration` moved to @lostgradient/operative-gemini.
export type RootGeminiProviderConfiguration = import('@lostgradient/operative').GeminiProviderConfiguration;
// prettier-ignore
// @ts-expect-error `GeminiProviderOptions` moved to @lostgradient/operative-gemini.
export type RootGeminiProviderOptions = import('@lostgradient/operative').GeminiProviderOptions;
// prettier-ignore
// @ts-expect-error `GeminiStreamingModel` moved to @lostgradient/operative-gemini.
export type RootGeminiStreamingModel = import('@lostgradient/operative').GeminiStreamingModel;
// prettier-ignore
// @ts-expect-error `GeminiTokenCounterOptions` moved to @lostgradient/operative-gemini.
export type RootGeminiTokenCounterOptions = import('@lostgradient/operative').GeminiTokenCounterOptions;
// prettier-ignore
// @ts-expect-error `GeminiTokenCountingClient` moved to @lostgradient/operative-gemini.
export type RootGeminiTokenCountingClient = import('@lostgradient/operative').GeminiTokenCountingClient;
// prettier-ignore
// @ts-expect-error `GeminiTokenCountingOperations` moved to @lostgradient/operative-gemini.
export type RootGeminiTokenCountingOperations = import('@lostgradient/operative').GeminiTokenCountingOperations;
// prettier-ignore
// @ts-expect-error `GeminiUsageMetadata` moved to @lostgradient/operative-gemini.
export type RootGeminiUsageMetadata = import('@lostgradient/operative').GeminiUsageMetadata;
// prettier-ignore
// @ts-expect-error `MockGeminiModel` moved to @lostgradient/operative-gemini.
export type RootMockGeminiModel = import('@lostgradient/operative').MockGeminiModel;
// prettier-ignore
// @ts-expect-error `MockGeminiStreamingModel` moved to @lostgradient/operative-gemini.
export type RootMockGeminiStreamingModel = import('@lostgradient/operative').MockGeminiStreamingModel;
// prettier-ignore
// @ts-expect-error `GeminiBatchClient` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiBatchClient = import('@lostgradient/operative/provider-kit').GeminiBatchClient;
// prettier-ignore
// @ts-expect-error `GeminiBatchClientOptions` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiBatchClientOptions = import('@lostgradient/operative/provider-kit').GeminiBatchClientOptions;
// prettier-ignore
// @ts-expect-error `GeminiBatchJob` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiBatchJob = import('@lostgradient/operative/provider-kit').GeminiBatchJob;
// prettier-ignore
// @ts-expect-error `GeminiBatchJobReference` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiBatchJobReference = import('@lostgradient/operative/provider-kit').GeminiBatchJobReference;
// prettier-ignore
// @ts-expect-error `GeminiBatchOperations` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiBatchOperations = import('@lostgradient/operative/provider-kit').GeminiBatchOperations;
// prettier-ignore
// @ts-expect-error `GeminiCacheCreatingClient` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiCacheCreatingClient = import('@lostgradient/operative/provider-kit').GeminiCacheCreatingClient;
// prettier-ignore
// @ts-expect-error `GeminiCachedContent` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiCachedContent = import('@lostgradient/operative/provider-kit').GeminiCachedContent;
// prettier-ignore
// @ts-expect-error `GeminiCountTokensRequest` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiCountTokensRequest = import('@lostgradient/operative/provider-kit').GeminiCountTokensRequest;
// prettier-ignore
// @ts-expect-error `GeminiCreateBatchJobRequest` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiCreateBatchJobRequest = import('@lostgradient/operative/provider-kit').GeminiCreateBatchJobRequest;
// prettier-ignore
// @ts-expect-error `GeminiCreateCachedContentRequest` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiCreateCachedContentRequest = import('@lostgradient/operative/provider-kit').GeminiCreateCachedContentRequest;
// prettier-ignore
// @ts-expect-error `GeminiDeleteResourceJob` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiDeleteResourceJob = import('@lostgradient/operative/provider-kit').GeminiDeleteResourceJob;
// prettier-ignore
// @ts-expect-error `GeminiEmbedderOptions` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiEmbedderOptions = import('@lostgradient/operative/provider-kit').GeminiEmbedderOptions;
// prettier-ignore
// @ts-expect-error `GeminiEmbeddingClient` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiEmbeddingClient = import('@lostgradient/operative/provider-kit').GeminiEmbeddingClient;
// prettier-ignore
// @ts-expect-error `GeminiEmbeddingModel` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiEmbeddingModel = import('@lostgradient/operative/provider-kit').GeminiEmbeddingModel;
// prettier-ignore
// @ts-expect-error `GeminiGenerateContentRequest` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiGenerateContentRequest = import('@lostgradient/operative/provider-kit').GeminiGenerateContentRequest;
// prettier-ignore
// @ts-expect-error `GeminiGenerateContentResult` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiGenerateContentResult = import('@lostgradient/operative/provider-kit').GeminiGenerateContentResult;
// prettier-ignore
// @ts-expect-error `GeminiGenerativeModel` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiGenerativeModel = import('@lostgradient/operative/provider-kit').GeminiGenerativeModel;
// prettier-ignore
// @ts-expect-error `GeminiListBatchJobsRequest` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiListBatchJobsRequest = import('@lostgradient/operative/provider-kit').GeminiListBatchJobsRequest;
// prettier-ignore
// @ts-expect-error `GeminiMapping` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiMapping = import('@lostgradient/operative/provider-kit').GeminiMapping;
// prettier-ignore
// @ts-expect-error `GeminiMappingViolation` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiMappingViolation = import('@lostgradient/operative/provider-kit').GeminiMappingViolation;
// prettier-ignore
// @ts-expect-error `GeminiProviderConfiguration` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiProviderConfiguration = import('@lostgradient/operative/provider-kit').GeminiProviderConfiguration;
// prettier-ignore
// @ts-expect-error `GeminiProviderOptions` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiProviderOptions = import('@lostgradient/operative/provider-kit').GeminiProviderOptions;
// prettier-ignore
// @ts-expect-error `GeminiStreamingModel` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiStreamingModel = import('@lostgradient/operative/provider-kit').GeminiStreamingModel;
// prettier-ignore
// @ts-expect-error `GeminiTokenCounterOptions` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiTokenCounterOptions = import('@lostgradient/operative/provider-kit').GeminiTokenCounterOptions;
// prettier-ignore
// @ts-expect-error `GeminiTokenCountingClient` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiTokenCountingClient = import('@lostgradient/operative/provider-kit').GeminiTokenCountingClient;
// prettier-ignore
// @ts-expect-error `GeminiTokenCountingOperations` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiTokenCountingOperations = import('@lostgradient/operative/provider-kit').GeminiTokenCountingOperations;
// prettier-ignore
// @ts-expect-error `GeminiUsageMetadata` moved to @lostgradient/operative-gemini.
export type ProviderKitGeminiUsageMetadata = import('@lostgradient/operative/provider-kit').GeminiUsageMetadata;
// prettier-ignore
// @ts-expect-error `MockGeminiModel` moved to @lostgradient/operative-gemini.
export type ProviderKitMockGeminiModel = import('@lostgradient/operative/provider-kit').MockGeminiModel;
// prettier-ignore
// @ts-expect-error `MockGeminiStreamingModel` moved to @lostgradient/operative-gemini.
export type ProviderKitMockGeminiStreamingModel = import('@lostgradient/operative/provider-kit').MockGeminiStreamingModel;
// prettier-ignore
// @ts-expect-error `GeminiBatchClient` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiBatchClient = import('@lostgradient/operative/provider-testing').GeminiBatchClient;
// prettier-ignore
// @ts-expect-error `GeminiBatchClientOptions` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiBatchClientOptions = import('@lostgradient/operative/provider-testing').GeminiBatchClientOptions;
// prettier-ignore
// @ts-expect-error `GeminiBatchJob` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiBatchJob = import('@lostgradient/operative/provider-testing').GeminiBatchJob;
// prettier-ignore
// @ts-expect-error `GeminiBatchJobReference` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiBatchJobReference = import('@lostgradient/operative/provider-testing').GeminiBatchJobReference;
// prettier-ignore
// @ts-expect-error `GeminiBatchOperations` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiBatchOperations = import('@lostgradient/operative/provider-testing').GeminiBatchOperations;
// prettier-ignore
// @ts-expect-error `GeminiCacheCreatingClient` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiCacheCreatingClient = import('@lostgradient/operative/provider-testing').GeminiCacheCreatingClient;
// prettier-ignore
// @ts-expect-error `GeminiCachedContent` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiCachedContent = import('@lostgradient/operative/provider-testing').GeminiCachedContent;
// prettier-ignore
// @ts-expect-error `GeminiCountTokensRequest` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiCountTokensRequest = import('@lostgradient/operative/provider-testing').GeminiCountTokensRequest;
// prettier-ignore
// @ts-expect-error `GeminiCreateBatchJobRequest` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiCreateBatchJobRequest = import('@lostgradient/operative/provider-testing').GeminiCreateBatchJobRequest;
// prettier-ignore
// @ts-expect-error `GeminiCreateCachedContentRequest` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiCreateCachedContentRequest = import('@lostgradient/operative/provider-testing').GeminiCreateCachedContentRequest;
// prettier-ignore
// @ts-expect-error `GeminiDeleteResourceJob` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiDeleteResourceJob = import('@lostgradient/operative/provider-testing').GeminiDeleteResourceJob;
// prettier-ignore
// @ts-expect-error `GeminiEmbedderOptions` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiEmbedderOptions = import('@lostgradient/operative/provider-testing').GeminiEmbedderOptions;
// prettier-ignore
// @ts-expect-error `GeminiEmbeddingClient` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiEmbeddingClient = import('@lostgradient/operative/provider-testing').GeminiEmbeddingClient;
// prettier-ignore
// @ts-expect-error `GeminiEmbeddingModel` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiEmbeddingModel = import('@lostgradient/operative/provider-testing').GeminiEmbeddingModel;
// prettier-ignore
// @ts-expect-error `GeminiGenerateContentRequest` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiGenerateContentRequest = import('@lostgradient/operative/provider-testing').GeminiGenerateContentRequest;
// prettier-ignore
// @ts-expect-error `GeminiGenerateContentResult` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiGenerateContentResult = import('@lostgradient/operative/provider-testing').GeminiGenerateContentResult;
// prettier-ignore
// @ts-expect-error `GeminiGenerativeModel` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiGenerativeModel = import('@lostgradient/operative/provider-testing').GeminiGenerativeModel;
// prettier-ignore
// @ts-expect-error `GeminiListBatchJobsRequest` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiListBatchJobsRequest = import('@lostgradient/operative/provider-testing').GeminiListBatchJobsRequest;
// prettier-ignore
// @ts-expect-error `GeminiMapping` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiMapping = import('@lostgradient/operative/provider-testing').GeminiMapping;
// prettier-ignore
// @ts-expect-error `GeminiMappingViolation` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiMappingViolation = import('@lostgradient/operative/provider-testing').GeminiMappingViolation;
// prettier-ignore
// @ts-expect-error `GeminiProviderConfiguration` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiProviderConfiguration = import('@lostgradient/operative/provider-testing').GeminiProviderConfiguration;
// prettier-ignore
// @ts-expect-error `GeminiProviderOptions` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiProviderOptions = import('@lostgradient/operative/provider-testing').GeminiProviderOptions;
// prettier-ignore
// @ts-expect-error `GeminiStreamingModel` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiStreamingModel = import('@lostgradient/operative/provider-testing').GeminiStreamingModel;
// prettier-ignore
// @ts-expect-error `GeminiTokenCounterOptions` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiTokenCounterOptions = import('@lostgradient/operative/provider-testing').GeminiTokenCounterOptions;
// prettier-ignore
// @ts-expect-error `GeminiTokenCountingClient` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiTokenCountingClient = import('@lostgradient/operative/provider-testing').GeminiTokenCountingClient;
// prettier-ignore
// @ts-expect-error `GeminiTokenCountingOperations` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiTokenCountingOperations = import('@lostgradient/operative/provider-testing').GeminiTokenCountingOperations;
// prettier-ignore
// @ts-expect-error `GeminiUsageMetadata` moved to @lostgradient/operative-gemini.
export type ProviderTestingGeminiUsageMetadata = import('@lostgradient/operative/provider-testing').GeminiUsageMetadata;
// prettier-ignore
// @ts-expect-error `MockGeminiModel` moved to @lostgradient/operative-gemini.
export type ProviderTestingMockGeminiModel = import('@lostgradient/operative/provider-testing').MockGeminiModel;
// prettier-ignore
// @ts-expect-error `MockGeminiStreamingModel` moved to @lostgradient/operative-gemini.
export type ProviderTestingMockGeminiStreamingModel = import('@lostgradient/operative/provider-testing').MockGeminiStreamingModel;
// prettier-ignore
// @ts-expect-error `GeminiBatchClient` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiBatchClient = import('../src/providers/index.ts').GeminiBatchClient;
// prettier-ignore
// @ts-expect-error `GeminiBatchClientOptions` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiBatchClientOptions = import('../src/providers/index.ts').GeminiBatchClientOptions;
// prettier-ignore
// @ts-expect-error `GeminiBatchJob` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiBatchJob = import('../src/providers/index.ts').GeminiBatchJob;
// prettier-ignore
// @ts-expect-error `GeminiBatchJobReference` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiBatchJobReference = import('../src/providers/index.ts').GeminiBatchJobReference;
// prettier-ignore
// @ts-expect-error `GeminiBatchOperations` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiBatchOperations = import('../src/providers/index.ts').GeminiBatchOperations;
// prettier-ignore
// @ts-expect-error `GeminiCacheCreatingClient` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiCacheCreatingClient = import('../src/providers/index.ts').GeminiCacheCreatingClient;
// prettier-ignore
// @ts-expect-error `GeminiCachedContent` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiCachedContent = import('../src/providers/index.ts').GeminiCachedContent;
// prettier-ignore
// @ts-expect-error `GeminiCountTokensRequest` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiCountTokensRequest = import('../src/providers/index.ts').GeminiCountTokensRequest;
// prettier-ignore
// @ts-expect-error `GeminiCreateBatchJobRequest` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiCreateBatchJobRequest = import('../src/providers/index.ts').GeminiCreateBatchJobRequest;
// prettier-ignore
// @ts-expect-error `GeminiCreateCachedContentRequest` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiCreateCachedContentRequest = import('../src/providers/index.ts').GeminiCreateCachedContentRequest;
// prettier-ignore
// @ts-expect-error `GeminiDeleteResourceJob` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiDeleteResourceJob = import('../src/providers/index.ts').GeminiDeleteResourceJob;
// prettier-ignore
// @ts-expect-error `GeminiEmbedderOptions` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiEmbedderOptions = import('../src/providers/index.ts').GeminiEmbedderOptions;
// prettier-ignore
// @ts-expect-error `GeminiEmbeddingClient` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiEmbeddingClient = import('../src/providers/index.ts').GeminiEmbeddingClient;
// prettier-ignore
// @ts-expect-error `GeminiEmbeddingModel` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiEmbeddingModel = import('../src/providers/index.ts').GeminiEmbeddingModel;
// prettier-ignore
// @ts-expect-error `GeminiGenerateContentRequest` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiGenerateContentRequest = import('../src/providers/index.ts').GeminiGenerateContentRequest;
// prettier-ignore
// @ts-expect-error `GeminiGenerateContentResult` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiGenerateContentResult = import('../src/providers/index.ts').GeminiGenerateContentResult;
// prettier-ignore
// @ts-expect-error `GeminiGenerativeModel` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiGenerativeModel = import('../src/providers/index.ts').GeminiGenerativeModel;
// prettier-ignore
// @ts-expect-error `GeminiListBatchJobsRequest` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiListBatchJobsRequest = import('../src/providers/index.ts').GeminiListBatchJobsRequest;
// prettier-ignore
// @ts-expect-error `GeminiMapping` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiMapping = import('../src/providers/index.ts').GeminiMapping;
// prettier-ignore
// @ts-expect-error `GeminiMappingViolation` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiMappingViolation = import('../src/providers/index.ts').GeminiMappingViolation;
// prettier-ignore
// @ts-expect-error `GeminiProviderConfiguration` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiProviderConfiguration = import('../src/providers/index.ts').GeminiProviderConfiguration;
// prettier-ignore
// @ts-expect-error `GeminiProviderOptions` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiProviderOptions = import('../src/providers/index.ts').GeminiProviderOptions;
// prettier-ignore
// @ts-expect-error `GeminiStreamingModel` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiStreamingModel = import('../src/providers/index.ts').GeminiStreamingModel;
// prettier-ignore
// @ts-expect-error `GeminiTokenCounterOptions` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiTokenCounterOptions = import('../src/providers/index.ts').GeminiTokenCounterOptions;
// prettier-ignore
// @ts-expect-error `GeminiTokenCountingClient` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiTokenCountingClient = import('../src/providers/index.ts').GeminiTokenCountingClient;
// prettier-ignore
// @ts-expect-error `GeminiTokenCountingOperations` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiTokenCountingOperations = import('../src/providers/index.ts').GeminiTokenCountingOperations;
// prettier-ignore
// @ts-expect-error `GeminiUsageMetadata` moved to @lostgradient/operative-gemini.
export type ProvidersGeminiUsageMetadata = import('../src/providers/index.ts').GeminiUsageMetadata;
// prettier-ignore
// @ts-expect-error `MockGeminiModel` moved to @lostgradient/operative-gemini.
export type ProvidersMockGeminiModel = import('../src/providers/index.ts').MockGeminiModel;
// prettier-ignore
// @ts-expect-error `MockGeminiStreamingModel` moved to @lostgradient/operative-gemini.
export type ProvidersMockGeminiStreamingModel = import('../src/providers/index.ts').MockGeminiStreamingModel;
// prettier-ignore
// @ts-expect-error `GeminiBatchClient` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiBatchClient = import('../src/providers/index.ts').GeminiBatchClient;
// prettier-ignore
// @ts-expect-error `GeminiBatchClientOptions` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiBatchClientOptions = import('../src/providers/index.ts').GeminiBatchClientOptions;
// prettier-ignore
// @ts-expect-error `GeminiBatchJob` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiBatchJob = import('../src/providers/index.ts').GeminiBatchJob;
// prettier-ignore
// @ts-expect-error `GeminiBatchJobReference` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiBatchJobReference = import('../src/providers/index.ts').GeminiBatchJobReference;
// prettier-ignore
// @ts-expect-error `GeminiBatchOperations` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiBatchOperations = import('../src/providers/index.ts').GeminiBatchOperations;
// prettier-ignore
// @ts-expect-error `GeminiCacheCreatingClient` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiCacheCreatingClient = import('../src/providers/index.ts').GeminiCacheCreatingClient;
// prettier-ignore
// @ts-expect-error `GeminiCachedContent` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiCachedContent = import('../src/providers/index.ts').GeminiCachedContent;
// prettier-ignore
// @ts-expect-error `GeminiCountTokensRequest` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiCountTokensRequest = import('../src/providers/index.ts').GeminiCountTokensRequest;
// prettier-ignore
// @ts-expect-error `GeminiCreateBatchJobRequest` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiCreateBatchJobRequest = import('../src/providers/index.ts').GeminiCreateBatchJobRequest;
// prettier-ignore
// @ts-expect-error `GeminiCreateCachedContentRequest` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiCreateCachedContentRequest = import('../src/providers/index.ts').GeminiCreateCachedContentRequest;
// prettier-ignore
// @ts-expect-error `GeminiDeleteResourceJob` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiDeleteResourceJob = import('../src/providers/index.ts').GeminiDeleteResourceJob;
// prettier-ignore
// @ts-expect-error `GeminiEmbedderOptions` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiEmbedderOptions = import('../src/providers/index.ts').GeminiEmbedderOptions;
// prettier-ignore
// @ts-expect-error `GeminiEmbeddingClient` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiEmbeddingClient = import('../src/providers/index.ts').GeminiEmbeddingClient;
// prettier-ignore
// @ts-expect-error `GeminiEmbeddingModel` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiEmbeddingModel = import('../src/providers/index.ts').GeminiEmbeddingModel;
// prettier-ignore
// @ts-expect-error `GeminiGenerateContentRequest` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiGenerateContentRequest = import('../src/providers/index.ts').GeminiGenerateContentRequest;
// prettier-ignore
// @ts-expect-error `GeminiGenerateContentResult` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiGenerateContentResult = import('../src/providers/index.ts').GeminiGenerateContentResult;
// prettier-ignore
// @ts-expect-error `GeminiGenerativeModel` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiGenerativeModel = import('../src/providers/index.ts').GeminiGenerativeModel;
// prettier-ignore
// @ts-expect-error `GeminiListBatchJobsRequest` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiListBatchJobsRequest = import('../src/providers/index.ts').GeminiListBatchJobsRequest;
// prettier-ignore
// @ts-expect-error `GeminiMapping` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiMapping = import('../src/providers/index.ts').GeminiMapping;
// prettier-ignore
// @ts-expect-error `GeminiMappingViolation` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiMappingViolation = import('../src/providers/index.ts').GeminiMappingViolation;
// prettier-ignore
// @ts-expect-error `GeminiProviderConfiguration` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiProviderConfiguration = import('../src/providers/index.ts').GeminiProviderConfiguration;
// prettier-ignore
// @ts-expect-error `GeminiProviderOptions` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiProviderOptions = import('../src/providers/index.ts').GeminiProviderOptions;
// prettier-ignore
// @ts-expect-error `GeminiStreamingModel` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiStreamingModel = import('../src/providers/index.ts').GeminiStreamingModel;
// prettier-ignore
// @ts-expect-error `GeminiTokenCounterOptions` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiTokenCounterOptions = import('../src/providers/index.ts').GeminiTokenCounterOptions;
// prettier-ignore
// @ts-expect-error `GeminiTokenCountingClient` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiTokenCountingClient = import('../src/providers/index.ts').GeminiTokenCountingClient;
// prettier-ignore
// @ts-expect-error `GeminiTokenCountingOperations` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiTokenCountingOperations = import('../src/providers/index.ts').GeminiTokenCountingOperations;
// prettier-ignore
// @ts-expect-error `GeminiUsageMetadata` moved to @lostgradient/operative-gemini.
export type EmbeddingsGeminiUsageMetadata = import('../src/providers/index.ts').GeminiUsageMetadata;
// prettier-ignore
// @ts-expect-error `MockGeminiModel` moved to @lostgradient/operative-gemini.
export type EmbeddingsMockGeminiModel = import('../src/providers/index.ts').MockGeminiModel;
// prettier-ignore
// @ts-expect-error `MockGeminiStreamingModel` moved to @lostgradient/operative-gemini.
export type EmbeddingsMockGeminiStreamingModel = import('../src/providers/index.ts').MockGeminiStreamingModel;
// prettier-ignore
// @ts-expect-error `GeminiBatchClient` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiBatchClient = import('../src/providers/structured-output/index.ts').GeminiBatchClient;
// prettier-ignore
// @ts-expect-error `GeminiBatchClientOptions` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiBatchClientOptions = import('../src/providers/structured-output/index.ts').GeminiBatchClientOptions;
// prettier-ignore
// @ts-expect-error `GeminiBatchJob` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiBatchJob = import('../src/providers/structured-output/index.ts').GeminiBatchJob;
// prettier-ignore
// @ts-expect-error `GeminiBatchJobReference` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiBatchJobReference = import('../src/providers/structured-output/index.ts').GeminiBatchJobReference;
// prettier-ignore
// @ts-expect-error `GeminiBatchOperations` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiBatchOperations = import('../src/providers/structured-output/index.ts').GeminiBatchOperations;
// prettier-ignore
// @ts-expect-error `GeminiCacheCreatingClient` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiCacheCreatingClient = import('../src/providers/structured-output/index.ts').GeminiCacheCreatingClient;
// prettier-ignore
// @ts-expect-error `GeminiCachedContent` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiCachedContent = import('../src/providers/structured-output/index.ts').GeminiCachedContent;
// prettier-ignore
// @ts-expect-error `GeminiCountTokensRequest` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiCountTokensRequest = import('../src/providers/structured-output/index.ts').GeminiCountTokensRequest;
// prettier-ignore
// @ts-expect-error `GeminiCreateBatchJobRequest` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiCreateBatchJobRequest = import('../src/providers/structured-output/index.ts').GeminiCreateBatchJobRequest;
// prettier-ignore
// @ts-expect-error `GeminiCreateCachedContentRequest` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiCreateCachedContentRequest = import('../src/providers/structured-output/index.ts').GeminiCreateCachedContentRequest;
// prettier-ignore
// @ts-expect-error `GeminiDeleteResourceJob` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiDeleteResourceJob = import('../src/providers/structured-output/index.ts').GeminiDeleteResourceJob;
// prettier-ignore
// @ts-expect-error `GeminiEmbedderOptions` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiEmbedderOptions = import('../src/providers/structured-output/index.ts').GeminiEmbedderOptions;
// prettier-ignore
// @ts-expect-error `GeminiEmbeddingClient` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiEmbeddingClient = import('../src/providers/structured-output/index.ts').GeminiEmbeddingClient;
// prettier-ignore
// @ts-expect-error `GeminiEmbeddingModel` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiEmbeddingModel = import('../src/providers/structured-output/index.ts').GeminiEmbeddingModel;
// prettier-ignore
// @ts-expect-error `GeminiGenerateContentRequest` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiGenerateContentRequest = import('../src/providers/structured-output/index.ts').GeminiGenerateContentRequest;
// prettier-ignore
// @ts-expect-error `GeminiGenerateContentResult` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiGenerateContentResult = import('../src/providers/structured-output/index.ts').GeminiGenerateContentResult;
// prettier-ignore
// @ts-expect-error `GeminiGenerativeModel` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiGenerativeModel = import('../src/providers/structured-output/index.ts').GeminiGenerativeModel;
// prettier-ignore
// @ts-expect-error `GeminiListBatchJobsRequest` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiListBatchJobsRequest = import('../src/providers/structured-output/index.ts').GeminiListBatchJobsRequest;
// prettier-ignore
// @ts-expect-error `GeminiMapping` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiMapping = import('../src/providers/structured-output/index.ts').GeminiMapping;
// prettier-ignore
// @ts-expect-error `GeminiMappingViolation` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiMappingViolation = import('../src/providers/structured-output/index.ts').GeminiMappingViolation;
// prettier-ignore
// @ts-expect-error `GeminiProviderConfiguration` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiProviderConfiguration = import('../src/providers/structured-output/index.ts').GeminiProviderConfiguration;
// prettier-ignore
// @ts-expect-error `GeminiProviderOptions` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiProviderOptions = import('../src/providers/structured-output/index.ts').GeminiProviderOptions;
// prettier-ignore
// @ts-expect-error `GeminiStreamingModel` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiStreamingModel = import('../src/providers/structured-output/index.ts').GeminiStreamingModel;
// prettier-ignore
// @ts-expect-error `GeminiTokenCounterOptions` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiTokenCounterOptions = import('../src/providers/structured-output/index.ts').GeminiTokenCounterOptions;
// prettier-ignore
// @ts-expect-error `GeminiTokenCountingClient` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiTokenCountingClient = import('../src/providers/structured-output/index.ts').GeminiTokenCountingClient;
// prettier-ignore
// @ts-expect-error `GeminiTokenCountingOperations` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiTokenCountingOperations = import('../src/providers/structured-output/index.ts').GeminiTokenCountingOperations;
// prettier-ignore
// @ts-expect-error `GeminiUsageMetadata` moved to @lostgradient/operative-gemini.
export type StructuredOutputGeminiUsageMetadata = import('../src/providers/structured-output/index.ts').GeminiUsageMetadata;
// prettier-ignore
// @ts-expect-error `MockGeminiModel` moved to @lostgradient/operative-gemini.
export type StructuredOutputMockGeminiModel = import('../src/providers/structured-output/index.ts').MockGeminiModel;
// prettier-ignore
// @ts-expect-error `MockGeminiStreamingModel` moved to @lostgradient/operative-gemini.
export type StructuredOutputMockGeminiStreamingModel = import('../src/providers/structured-output/index.ts').MockGeminiStreamingModel;
