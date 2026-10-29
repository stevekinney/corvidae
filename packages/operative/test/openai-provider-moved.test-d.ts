/**
 * Compile-time half of `openai-provider-moved.test.ts`: the OpenAI types that moved to
 * `@lostgradient/operative-openai` are exported by none of Operative's entry points or provider
 * barrels. Each alias below must fail to compile; a type that is exported again turns its
 * `@ts-expect-error` into an unused-directive error, so `tsc` fails.
 *
 * The aliases use `import()` types rather than `import type` declarations, because the formatter
 * removes an import whose binding nothing reads, and with it the assertion.
 */

// prettier-ignore
// @ts-expect-error `OpenAIBatch` moved to @lostgradient/operative-openai.
export type RootOpenAIBatch = import('@lostgradient/operative').OpenAIBatch;
// prettier-ignore
// @ts-expect-error `OpenAIBatchClient` moved to @lostgradient/operative-openai.
export type RootOpenAIBatchClient = import('@lostgradient/operative').OpenAIBatchClient;
// prettier-ignore
// @ts-expect-error `OpenAIBatchClientOptions` moved to @lostgradient/operative-openai.
export type RootOpenAIBatchClientOptions = import('@lostgradient/operative').OpenAIBatchClientOptions;
// prettier-ignore
// @ts-expect-error `OpenAIBatchCreateRequest` moved to @lostgradient/operative-openai.
export type RootOpenAIBatchCreateRequest = import('@lostgradient/operative').OpenAIBatchCreateRequest;
// prettier-ignore
// @ts-expect-error `OpenAIBatchListQuery` moved to @lostgradient/operative-openai.
export type RootOpenAIBatchListQuery = import('@lostgradient/operative').OpenAIBatchListQuery;
// prettier-ignore
// @ts-expect-error `OpenAIBatchOperations` moved to @lostgradient/operative-openai.
export type RootOpenAIBatchOperations = import('@lostgradient/operative').OpenAIBatchOperations;
// prettier-ignore
// @ts-expect-error `OpenAIBatchRequestCounts` moved to @lostgradient/operative-openai.
export type RootOpenAIBatchRequestCounts = import('@lostgradient/operative').OpenAIBatchRequestCounts;
// prettier-ignore
// @ts-expect-error `OpenAIChatCompletion` moved to @lostgradient/operative-openai.
export type RootOpenAIChatCompletion = import('@lostgradient/operative').OpenAIChatCompletion;
// prettier-ignore
// @ts-expect-error `OpenAIChatCompletionChunk` moved to @lostgradient/operative-openai.
export type RootOpenAIChatCompletionChunk = import('@lostgradient/operative').OpenAIChatCompletionChunk;
// prettier-ignore
// @ts-expect-error `OpenAIChatCompletionCreateRequest` moved to @lostgradient/operative-openai.
export type RootOpenAIChatCompletionCreateRequest = import('@lostgradient/operative').OpenAIChatCompletionCreateRequest;
// prettier-ignore
// @ts-expect-error `OpenAIClient` moved to @lostgradient/operative-openai.
export type RootOpenAIClient = import('@lostgradient/operative').OpenAIClient;
// prettier-ignore
// @ts-expect-error `OpenAIEmbedderOptions` moved to @lostgradient/operative-openai.
export type RootOpenAIEmbedderOptions = import('@lostgradient/operative').OpenAIEmbedderOptions;
// prettier-ignore
// @ts-expect-error `OpenAIEmbeddingClient` moved to @lostgradient/operative-openai.
export type RootOpenAIEmbeddingClient = import('@lostgradient/operative').OpenAIEmbeddingClient;
// prettier-ignore
// @ts-expect-error `OpenAIMessageMapping` moved to @lostgradient/operative-openai.
export type RootOpenAIMessageMapping = import('@lostgradient/operative').OpenAIMessageMapping;
// prettier-ignore
// @ts-expect-error `OpenAIProviderConfiguration` moved to @lostgradient/operative-openai.
export type RootOpenAIProviderConfiguration = import('@lostgradient/operative').OpenAIProviderConfiguration;
// prettier-ignore
// @ts-expect-error `OpenAIProviderOptions` moved to @lostgradient/operative-openai.
export type RootOpenAIProviderOptions = import('@lostgradient/operative').OpenAIProviderOptions;
// prettier-ignore
// @ts-expect-error `OpenAIRequestOptions` moved to @lostgradient/operative-openai.
export type RootOpenAIRequestOptions = import('@lostgradient/operative').OpenAIRequestOptions;
// prettier-ignore
// @ts-expect-error `OpenAIStreamingClient` moved to @lostgradient/operative-openai.
export type RootOpenAIStreamingClient = import('@lostgradient/operative').OpenAIStreamingClient;
// prettier-ignore
// @ts-expect-error `MockOpenAIClient` moved to @lostgradient/operative-openai.
export type RootMockOpenAIClient = import('@lostgradient/operative').MockOpenAIClient;
// prettier-ignore
// @ts-expect-error `MockOpenAIStreamingClient` moved to @lostgradient/operative-openai.
export type RootMockOpenAIStreamingClient = import('@lostgradient/operative').MockOpenAIStreamingClient;
// prettier-ignore
// @ts-expect-error `OpenAIBatch` moved to @lostgradient/operative-openai.
export type ProviderKitOpenAIBatch = import('@lostgradient/operative/provider-kit').OpenAIBatch;
// prettier-ignore
// @ts-expect-error `OpenAIBatchClient` moved to @lostgradient/operative-openai.
export type ProviderKitOpenAIBatchClient = import('@lostgradient/operative/provider-kit').OpenAIBatchClient;
// prettier-ignore
// @ts-expect-error `OpenAIBatchClientOptions` moved to @lostgradient/operative-openai.
export type ProviderKitOpenAIBatchClientOptions = import('@lostgradient/operative/provider-kit').OpenAIBatchClientOptions;
// prettier-ignore
// @ts-expect-error `OpenAIBatchCreateRequest` moved to @lostgradient/operative-openai.
export type ProviderKitOpenAIBatchCreateRequest = import('@lostgradient/operative/provider-kit').OpenAIBatchCreateRequest;
// prettier-ignore
// @ts-expect-error `OpenAIBatchListQuery` moved to @lostgradient/operative-openai.
export type ProviderKitOpenAIBatchListQuery = import('@lostgradient/operative/provider-kit').OpenAIBatchListQuery;
// prettier-ignore
// @ts-expect-error `OpenAIBatchOperations` moved to @lostgradient/operative-openai.
export type ProviderKitOpenAIBatchOperations = import('@lostgradient/operative/provider-kit').OpenAIBatchOperations;
// prettier-ignore
// @ts-expect-error `OpenAIBatchRequestCounts` moved to @lostgradient/operative-openai.
export type ProviderKitOpenAIBatchRequestCounts = import('@lostgradient/operative/provider-kit').OpenAIBatchRequestCounts;
// prettier-ignore
// @ts-expect-error `OpenAIChatCompletion` moved to @lostgradient/operative-openai.
export type ProviderKitOpenAIChatCompletion = import('@lostgradient/operative/provider-kit').OpenAIChatCompletion;
// prettier-ignore
// @ts-expect-error `OpenAIChatCompletionChunk` moved to @lostgradient/operative-openai.
export type ProviderKitOpenAIChatCompletionChunk = import('@lostgradient/operative/provider-kit').OpenAIChatCompletionChunk;
// prettier-ignore
// @ts-expect-error `OpenAIChatCompletionCreateRequest` moved to @lostgradient/operative-openai.
export type ProviderKitOpenAIChatCompletionCreateRequest = import('@lostgradient/operative/provider-kit').OpenAIChatCompletionCreateRequest;
// prettier-ignore
// @ts-expect-error `OpenAIClient` moved to @lostgradient/operative-openai.
export type ProviderKitOpenAIClient = import('@lostgradient/operative/provider-kit').OpenAIClient;
// prettier-ignore
// @ts-expect-error `OpenAIEmbedderOptions` moved to @lostgradient/operative-openai.
export type ProviderKitOpenAIEmbedderOptions = import('@lostgradient/operative/provider-kit').OpenAIEmbedderOptions;
// prettier-ignore
// @ts-expect-error `OpenAIEmbeddingClient` moved to @lostgradient/operative-openai.
export type ProviderKitOpenAIEmbeddingClient = import('@lostgradient/operative/provider-kit').OpenAIEmbeddingClient;
// prettier-ignore
// @ts-expect-error `OpenAIMessageMapping` moved to @lostgradient/operative-openai.
export type ProviderKitOpenAIMessageMapping = import('@lostgradient/operative/provider-kit').OpenAIMessageMapping;
// prettier-ignore
// @ts-expect-error `OpenAIProviderConfiguration` moved to @lostgradient/operative-openai.
export type ProviderKitOpenAIProviderConfiguration = import('@lostgradient/operative/provider-kit').OpenAIProviderConfiguration;
// prettier-ignore
// @ts-expect-error `OpenAIProviderOptions` moved to @lostgradient/operative-openai.
export type ProviderKitOpenAIProviderOptions = import('@lostgradient/operative/provider-kit').OpenAIProviderOptions;
// prettier-ignore
// @ts-expect-error `OpenAIRequestOptions` moved to @lostgradient/operative-openai.
export type ProviderKitOpenAIRequestOptions = import('@lostgradient/operative/provider-kit').OpenAIRequestOptions;
// prettier-ignore
// @ts-expect-error `OpenAIStreamingClient` moved to @lostgradient/operative-openai.
export type ProviderKitOpenAIStreamingClient = import('@lostgradient/operative/provider-kit').OpenAIStreamingClient;
// prettier-ignore
// @ts-expect-error `MockOpenAIClient` moved to @lostgradient/operative-openai.
export type ProviderKitMockOpenAIClient = import('@lostgradient/operative/provider-kit').MockOpenAIClient;
// prettier-ignore
// @ts-expect-error `MockOpenAIStreamingClient` moved to @lostgradient/operative-openai.
export type ProviderKitMockOpenAIStreamingClient = import('@lostgradient/operative/provider-kit').MockOpenAIStreamingClient;
// prettier-ignore
// @ts-expect-error `OpenAIBatch` moved to @lostgradient/operative-openai.
export type ProviderTestingOpenAIBatch = import('@lostgradient/operative/provider-testing').OpenAIBatch;
// prettier-ignore
// @ts-expect-error `OpenAIBatchClient` moved to @lostgradient/operative-openai.
export type ProviderTestingOpenAIBatchClient = import('@lostgradient/operative/provider-testing').OpenAIBatchClient;
// prettier-ignore
// @ts-expect-error `OpenAIBatchClientOptions` moved to @lostgradient/operative-openai.
export type ProviderTestingOpenAIBatchClientOptions = import('@lostgradient/operative/provider-testing').OpenAIBatchClientOptions;
// prettier-ignore
// @ts-expect-error `OpenAIBatchCreateRequest` moved to @lostgradient/operative-openai.
export type ProviderTestingOpenAIBatchCreateRequest = import('@lostgradient/operative/provider-testing').OpenAIBatchCreateRequest;
// prettier-ignore
// @ts-expect-error `OpenAIBatchListQuery` moved to @lostgradient/operative-openai.
export type ProviderTestingOpenAIBatchListQuery = import('@lostgradient/operative/provider-testing').OpenAIBatchListQuery;
// prettier-ignore
// @ts-expect-error `OpenAIBatchOperations` moved to @lostgradient/operative-openai.
export type ProviderTestingOpenAIBatchOperations = import('@lostgradient/operative/provider-testing').OpenAIBatchOperations;
// prettier-ignore
// @ts-expect-error `OpenAIBatchRequestCounts` moved to @lostgradient/operative-openai.
export type ProviderTestingOpenAIBatchRequestCounts = import('@lostgradient/operative/provider-testing').OpenAIBatchRequestCounts;
// prettier-ignore
// @ts-expect-error `OpenAIChatCompletion` moved to @lostgradient/operative-openai.
export type ProviderTestingOpenAIChatCompletion = import('@lostgradient/operative/provider-testing').OpenAIChatCompletion;
// prettier-ignore
// @ts-expect-error `OpenAIChatCompletionChunk` moved to @lostgradient/operative-openai.
export type ProviderTestingOpenAIChatCompletionChunk = import('@lostgradient/operative/provider-testing').OpenAIChatCompletionChunk;
// prettier-ignore
// @ts-expect-error `OpenAIChatCompletionCreateRequest` moved to @lostgradient/operative-openai.
export type ProviderTestingOpenAIChatCompletionCreateRequest = import('@lostgradient/operative/provider-testing').OpenAIChatCompletionCreateRequest;
// prettier-ignore
// @ts-expect-error `OpenAIClient` moved to @lostgradient/operative-openai.
export type ProviderTestingOpenAIClient = import('@lostgradient/operative/provider-testing').OpenAIClient;
// prettier-ignore
// @ts-expect-error `OpenAIEmbedderOptions` moved to @lostgradient/operative-openai.
export type ProviderTestingOpenAIEmbedderOptions = import('@lostgradient/operative/provider-testing').OpenAIEmbedderOptions;
// prettier-ignore
// @ts-expect-error `OpenAIEmbeddingClient` moved to @lostgradient/operative-openai.
export type ProviderTestingOpenAIEmbeddingClient = import('@lostgradient/operative/provider-testing').OpenAIEmbeddingClient;
// prettier-ignore
// @ts-expect-error `OpenAIMessageMapping` moved to @lostgradient/operative-openai.
export type ProviderTestingOpenAIMessageMapping = import('@lostgradient/operative/provider-testing').OpenAIMessageMapping;
// prettier-ignore
// @ts-expect-error `OpenAIProviderConfiguration` moved to @lostgradient/operative-openai.
export type ProviderTestingOpenAIProviderConfiguration = import('@lostgradient/operative/provider-testing').OpenAIProviderConfiguration;
// prettier-ignore
// @ts-expect-error `OpenAIProviderOptions` moved to @lostgradient/operative-openai.
export type ProviderTestingOpenAIProviderOptions = import('@lostgradient/operative/provider-testing').OpenAIProviderOptions;
// prettier-ignore
// @ts-expect-error `OpenAIRequestOptions` moved to @lostgradient/operative-openai.
export type ProviderTestingOpenAIRequestOptions = import('@lostgradient/operative/provider-testing').OpenAIRequestOptions;
// prettier-ignore
// @ts-expect-error `OpenAIStreamingClient` moved to @lostgradient/operative-openai.
export type ProviderTestingOpenAIStreamingClient = import('@lostgradient/operative/provider-testing').OpenAIStreamingClient;
// prettier-ignore
// @ts-expect-error `MockOpenAIClient` moved to @lostgradient/operative-openai.
export type ProviderTestingMockOpenAIClient = import('@lostgradient/operative/provider-testing').MockOpenAIClient;
// prettier-ignore
// @ts-expect-error `MockOpenAIStreamingClient` moved to @lostgradient/operative-openai.
export type ProviderTestingMockOpenAIStreamingClient = import('@lostgradient/operative/provider-testing').MockOpenAIStreamingClient;
// prettier-ignore
// @ts-expect-error `OpenAIBatch` moved to @lostgradient/operative-openai.
export type ProvidersOpenAIBatch = import('../src/providers/index.ts').OpenAIBatch;
// prettier-ignore
// @ts-expect-error `OpenAIBatchClient` moved to @lostgradient/operative-openai.
export type ProvidersOpenAIBatchClient = import('../src/providers/index.ts').OpenAIBatchClient;
// prettier-ignore
// @ts-expect-error `OpenAIBatchClientOptions` moved to @lostgradient/operative-openai.
export type ProvidersOpenAIBatchClientOptions = import('../src/providers/index.ts').OpenAIBatchClientOptions;
// prettier-ignore
// @ts-expect-error `OpenAIBatchCreateRequest` moved to @lostgradient/operative-openai.
export type ProvidersOpenAIBatchCreateRequest = import('../src/providers/index.ts').OpenAIBatchCreateRequest;
// prettier-ignore
// @ts-expect-error `OpenAIBatchListQuery` moved to @lostgradient/operative-openai.
export type ProvidersOpenAIBatchListQuery = import('../src/providers/index.ts').OpenAIBatchListQuery;
// prettier-ignore
// @ts-expect-error `OpenAIBatchOperations` moved to @lostgradient/operative-openai.
export type ProvidersOpenAIBatchOperations = import('../src/providers/index.ts').OpenAIBatchOperations;
// prettier-ignore
// @ts-expect-error `OpenAIBatchRequestCounts` moved to @lostgradient/operative-openai.
export type ProvidersOpenAIBatchRequestCounts = import('../src/providers/index.ts').OpenAIBatchRequestCounts;
// prettier-ignore
// @ts-expect-error `OpenAIChatCompletion` moved to @lostgradient/operative-openai.
export type ProvidersOpenAIChatCompletion = import('../src/providers/index.ts').OpenAIChatCompletion;
// prettier-ignore
// @ts-expect-error `OpenAIChatCompletionChunk` moved to @lostgradient/operative-openai.
export type ProvidersOpenAIChatCompletionChunk = import('../src/providers/index.ts').OpenAIChatCompletionChunk;
// prettier-ignore
// @ts-expect-error `OpenAIChatCompletionCreateRequest` moved to @lostgradient/operative-openai.
export type ProvidersOpenAIChatCompletionCreateRequest = import('../src/providers/index.ts').OpenAIChatCompletionCreateRequest;
// prettier-ignore
// @ts-expect-error `OpenAIClient` moved to @lostgradient/operative-openai.
export type ProvidersOpenAIClient = import('../src/providers/index.ts').OpenAIClient;
// prettier-ignore
// @ts-expect-error `OpenAIEmbedderOptions` moved to @lostgradient/operative-openai.
export type ProvidersOpenAIEmbedderOptions = import('../src/providers/index.ts').OpenAIEmbedderOptions;
// prettier-ignore
// @ts-expect-error `OpenAIEmbeddingClient` moved to @lostgradient/operative-openai.
export type ProvidersOpenAIEmbeddingClient = import('../src/providers/index.ts').OpenAIEmbeddingClient;
// prettier-ignore
// @ts-expect-error `OpenAIMessageMapping` moved to @lostgradient/operative-openai.
export type ProvidersOpenAIMessageMapping = import('../src/providers/index.ts').OpenAIMessageMapping;
// prettier-ignore
// @ts-expect-error `OpenAIProviderConfiguration` moved to @lostgradient/operative-openai.
export type ProvidersOpenAIProviderConfiguration = import('../src/providers/index.ts').OpenAIProviderConfiguration;
// prettier-ignore
// @ts-expect-error `OpenAIProviderOptions` moved to @lostgradient/operative-openai.
export type ProvidersOpenAIProviderOptions = import('../src/providers/index.ts').OpenAIProviderOptions;
// prettier-ignore
// @ts-expect-error `OpenAIRequestOptions` moved to @lostgradient/operative-openai.
export type ProvidersOpenAIRequestOptions = import('../src/providers/index.ts').OpenAIRequestOptions;
// prettier-ignore
// @ts-expect-error `OpenAIStreamingClient` moved to @lostgradient/operative-openai.
export type ProvidersOpenAIStreamingClient = import('../src/providers/index.ts').OpenAIStreamingClient;
// prettier-ignore
// @ts-expect-error `MockOpenAIClient` moved to @lostgradient/operative-openai.
export type ProvidersMockOpenAIClient = import('../src/providers/index.ts').MockOpenAIClient;
// prettier-ignore
// @ts-expect-error `MockOpenAIStreamingClient` moved to @lostgradient/operative-openai.
export type ProvidersMockOpenAIStreamingClient = import('../src/providers/index.ts').MockOpenAIStreamingClient;
// prettier-ignore
// @ts-expect-error `OpenAIBatch` moved to @lostgradient/operative-openai.
export type EmbeddingsOpenAIBatch = import('../src/providers/embeddings/index.ts').OpenAIBatch;
// prettier-ignore
// @ts-expect-error `OpenAIBatchClient` moved to @lostgradient/operative-openai.
export type EmbeddingsOpenAIBatchClient = import('../src/providers/embeddings/index.ts').OpenAIBatchClient;
// prettier-ignore
// @ts-expect-error `OpenAIBatchClientOptions` moved to @lostgradient/operative-openai.
export type EmbeddingsOpenAIBatchClientOptions = import('../src/providers/embeddings/index.ts').OpenAIBatchClientOptions;
// prettier-ignore
// @ts-expect-error `OpenAIBatchCreateRequest` moved to @lostgradient/operative-openai.
export type EmbeddingsOpenAIBatchCreateRequest = import('../src/providers/embeddings/index.ts').OpenAIBatchCreateRequest;
// prettier-ignore
// @ts-expect-error `OpenAIBatchListQuery` moved to @lostgradient/operative-openai.
export type EmbeddingsOpenAIBatchListQuery = import('../src/providers/embeddings/index.ts').OpenAIBatchListQuery;
// prettier-ignore
// @ts-expect-error `OpenAIBatchOperations` moved to @lostgradient/operative-openai.
export type EmbeddingsOpenAIBatchOperations = import('../src/providers/embeddings/index.ts').OpenAIBatchOperations;
// prettier-ignore
// @ts-expect-error `OpenAIBatchRequestCounts` moved to @lostgradient/operative-openai.
export type EmbeddingsOpenAIBatchRequestCounts = import('../src/providers/embeddings/index.ts').OpenAIBatchRequestCounts;
// prettier-ignore
// @ts-expect-error `OpenAIChatCompletion` moved to @lostgradient/operative-openai.
export type EmbeddingsOpenAIChatCompletion = import('../src/providers/embeddings/index.ts').OpenAIChatCompletion;
// prettier-ignore
// @ts-expect-error `OpenAIChatCompletionChunk` moved to @lostgradient/operative-openai.
export type EmbeddingsOpenAIChatCompletionChunk = import('../src/providers/embeddings/index.ts').OpenAIChatCompletionChunk;
// prettier-ignore
// @ts-expect-error `OpenAIChatCompletionCreateRequest` moved to @lostgradient/operative-openai.
export type EmbeddingsOpenAIChatCompletionCreateRequest = import('../src/providers/embeddings/index.ts').OpenAIChatCompletionCreateRequest;
// prettier-ignore
// @ts-expect-error `OpenAIClient` moved to @lostgradient/operative-openai.
export type EmbeddingsOpenAIClient = import('../src/providers/embeddings/index.ts').OpenAIClient;
// prettier-ignore
// @ts-expect-error `OpenAIEmbedderOptions` moved to @lostgradient/operative-openai.
export type EmbeddingsOpenAIEmbedderOptions = import('../src/providers/embeddings/index.ts').OpenAIEmbedderOptions;
// prettier-ignore
// @ts-expect-error `OpenAIEmbeddingClient` moved to @lostgradient/operative-openai.
export type EmbeddingsOpenAIEmbeddingClient = import('../src/providers/embeddings/index.ts').OpenAIEmbeddingClient;
// prettier-ignore
// @ts-expect-error `OpenAIMessageMapping` moved to @lostgradient/operative-openai.
export type EmbeddingsOpenAIMessageMapping = import('../src/providers/embeddings/index.ts').OpenAIMessageMapping;
// prettier-ignore
// @ts-expect-error `OpenAIProviderConfiguration` moved to @lostgradient/operative-openai.
export type EmbeddingsOpenAIProviderConfiguration = import('../src/providers/embeddings/index.ts').OpenAIProviderConfiguration;
// prettier-ignore
// @ts-expect-error `OpenAIProviderOptions` moved to @lostgradient/operative-openai.
export type EmbeddingsOpenAIProviderOptions = import('../src/providers/embeddings/index.ts').OpenAIProviderOptions;
// prettier-ignore
// @ts-expect-error `OpenAIRequestOptions` moved to @lostgradient/operative-openai.
export type EmbeddingsOpenAIRequestOptions = import('../src/providers/embeddings/index.ts').OpenAIRequestOptions;
// prettier-ignore
// @ts-expect-error `OpenAIStreamingClient` moved to @lostgradient/operative-openai.
export type EmbeddingsOpenAIStreamingClient = import('../src/providers/embeddings/index.ts').OpenAIStreamingClient;
// prettier-ignore
// @ts-expect-error `MockOpenAIClient` moved to @lostgradient/operative-openai.
export type EmbeddingsMockOpenAIClient = import('../src/providers/embeddings/index.ts').MockOpenAIClient;
// prettier-ignore
// @ts-expect-error `MockOpenAIStreamingClient` moved to @lostgradient/operative-openai.
export type EmbeddingsMockOpenAIStreamingClient = import('../src/providers/embeddings/index.ts').MockOpenAIStreamingClient;
// prettier-ignore
// @ts-expect-error `OpenAIBatch` moved to @lostgradient/operative-openai.
export type StructuredOutputOpenAIBatch = import('../src/providers/structured-output/index.ts').OpenAIBatch;
// prettier-ignore
// @ts-expect-error `OpenAIBatchClient` moved to @lostgradient/operative-openai.
export type StructuredOutputOpenAIBatchClient = import('../src/providers/structured-output/index.ts').OpenAIBatchClient;
// prettier-ignore
// @ts-expect-error `OpenAIBatchClientOptions` moved to @lostgradient/operative-openai.
export type StructuredOutputOpenAIBatchClientOptions = import('../src/providers/structured-output/index.ts').OpenAIBatchClientOptions;
// prettier-ignore
// @ts-expect-error `OpenAIBatchCreateRequest` moved to @lostgradient/operative-openai.
export type StructuredOutputOpenAIBatchCreateRequest = import('../src/providers/structured-output/index.ts').OpenAIBatchCreateRequest;
// prettier-ignore
// @ts-expect-error `OpenAIBatchListQuery` moved to @lostgradient/operative-openai.
export type StructuredOutputOpenAIBatchListQuery = import('../src/providers/structured-output/index.ts').OpenAIBatchListQuery;
// prettier-ignore
// @ts-expect-error `OpenAIBatchOperations` moved to @lostgradient/operative-openai.
export type StructuredOutputOpenAIBatchOperations = import('../src/providers/structured-output/index.ts').OpenAIBatchOperations;
// prettier-ignore
// @ts-expect-error `OpenAIBatchRequestCounts` moved to @lostgradient/operative-openai.
export type StructuredOutputOpenAIBatchRequestCounts = import('../src/providers/structured-output/index.ts').OpenAIBatchRequestCounts;
// prettier-ignore
// @ts-expect-error `OpenAIChatCompletion` moved to @lostgradient/operative-openai.
export type StructuredOutputOpenAIChatCompletion = import('../src/providers/structured-output/index.ts').OpenAIChatCompletion;
// prettier-ignore
// @ts-expect-error `OpenAIChatCompletionChunk` moved to @lostgradient/operative-openai.
export type StructuredOutputOpenAIChatCompletionChunk = import('../src/providers/structured-output/index.ts').OpenAIChatCompletionChunk;
// prettier-ignore
// @ts-expect-error `OpenAIChatCompletionCreateRequest` moved to @lostgradient/operative-openai.
export type StructuredOutputOpenAIChatCompletionCreateRequest = import('../src/providers/structured-output/index.ts').OpenAIChatCompletionCreateRequest;
// prettier-ignore
// @ts-expect-error `OpenAIClient` moved to @lostgradient/operative-openai.
export type StructuredOutputOpenAIClient = import('../src/providers/structured-output/index.ts').OpenAIClient;
// prettier-ignore
// @ts-expect-error `OpenAIEmbedderOptions` moved to @lostgradient/operative-openai.
export type StructuredOutputOpenAIEmbedderOptions = import('../src/providers/structured-output/index.ts').OpenAIEmbedderOptions;
// prettier-ignore
// @ts-expect-error `OpenAIEmbeddingClient` moved to @lostgradient/operative-openai.
export type StructuredOutputOpenAIEmbeddingClient = import('../src/providers/structured-output/index.ts').OpenAIEmbeddingClient;
// prettier-ignore
// @ts-expect-error `OpenAIMessageMapping` moved to @lostgradient/operative-openai.
export type StructuredOutputOpenAIMessageMapping = import('../src/providers/structured-output/index.ts').OpenAIMessageMapping;
// prettier-ignore
// @ts-expect-error `OpenAIProviderConfiguration` moved to @lostgradient/operative-openai.
export type StructuredOutputOpenAIProviderConfiguration = import('../src/providers/structured-output/index.ts').OpenAIProviderConfiguration;
// prettier-ignore
// @ts-expect-error `OpenAIProviderOptions` moved to @lostgradient/operative-openai.
export type StructuredOutputOpenAIProviderOptions = import('../src/providers/structured-output/index.ts').OpenAIProviderOptions;
// prettier-ignore
// @ts-expect-error `OpenAIRequestOptions` moved to @lostgradient/operative-openai.
export type StructuredOutputOpenAIRequestOptions = import('../src/providers/structured-output/index.ts').OpenAIRequestOptions;
// prettier-ignore
// @ts-expect-error `OpenAIStreamingClient` moved to @lostgradient/operative-openai.
export type StructuredOutputOpenAIStreamingClient = import('../src/providers/structured-output/index.ts').OpenAIStreamingClient;
// prettier-ignore
// @ts-expect-error `MockOpenAIClient` moved to @lostgradient/operative-openai.
export type StructuredOutputMockOpenAIClient = import('../src/providers/structured-output/index.ts').MockOpenAIClient;
// prettier-ignore
// @ts-expect-error `MockOpenAIStreamingClient` moved to @lostgradient/operative-openai.
export type StructuredOutputMockOpenAIStreamingClient = import('../src/providers/structured-output/index.ts').MockOpenAIStreamingClient;
