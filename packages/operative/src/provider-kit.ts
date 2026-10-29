/**
 * Operative's provider-authoring surface — `@lostgradient/operative/provider-kit`.
 *
 * A model provider package builds a generate function for one vendor. Everything it needs from
 * Operative that is not vendor-specific is exported from here: the request and response types,
 * the error classes, the parameter and model resolvers every provider shares, the stream
 * normalizer helpers, and the {@link ProviderDefinition} shape a host registers. A provider
 * package imports Operative only through `@lostgradient/operative`, this entry point, and, in its
 * tests, the testing entry points; it never reaches into Operative's source files.
 */

export type { TokenBudget } from './context/token-budget.ts';
export type { ContextAssembler } from './context/types.ts';
export { defineOwn } from './define-own.ts';
export {
  readBackendDescriptors,
  withBackendDescriptors,
} from './providers/backend-descriptor-attachment.ts';
export {
  ProviderContractError,
  ProviderError,
  ToolCallParseError,
  isProviderContractError,
  isToolCallParseError,
  shouldRetryProviderError,
} from './providers/errors.ts';
export type { ProviderContractReason } from './providers/errors.ts';
export {
  classifyProviderError,
  extractSamplingParameterFields,
} from './providers/fallover/classify-error.ts';
export type { SamplingParameterField } from './providers/fallover/classify-error.ts';
export { createModelCatalog } from './providers/model-catalog.ts';
export type {
  BackendDescriptor,
  BackendLifecycleState,
  CatalogProjection,
  CreateModelCatalogOptions,
  EffortSupport,
  GeneratedAssetBehavior,
  MediaCount,
  ModelAlias,
  ModelCatalog,
} from './providers/model-catalog.ts';
export type {
  ProviderConfigurationBase,
  ProviderDefinition,
} from './providers/provider-definition.ts';
export { assertBatchSurface } from './providers/shared/batch-support.ts';
export type { BatchSurfaceRequirement } from './providers/shared/batch-support.ts';
export { createCacheAwareAssembly } from './providers/shared/cache-aware-assembly.ts';
export {
  resolveAnthropicEffort,
  resolveGeminiEffort,
  resolveOpenAIEffort,
} from './providers/shared/effort.ts';
export { withInputLineage } from './providers/shared/input-lineage.ts';
export {
  resolveAnthropicModel,
  resolveGeminiModel,
  resolveOpenAIModel,
} from './providers/shared/model-registry.ts';
export { REPLAY_DATA_DROPPED_METADATA_KEY } from './providers/shared/replay-data.ts';
export type { DroppedReplayData } from './providers/shared/replay-data.ts';
export { resolveCommonParameters } from './providers/shared/resolve-common-parameters.ts';
export type { ResolvedCommonParameters } from './providers/shared/resolve-common-parameters.ts';
export { anthropicSamplingSupport } from './providers/shared/sampling.ts';
export type { SamplingSupport } from './providers/shared/sampling.ts';
export { buildState, findBlock } from './providers/streaming/stream-helpers.ts';
export type { NormalizerState } from './providers/streaming/stream-helpers.ts';
export type {
  BaseProviderOptions,
  Effort,
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  ProviderName,
  StreamingGenerateFunction,
  StreamingHandle,
  TokenCountResult,
  TokenUsage,
} from './providers/types.ts';
export { concatenateTextParts } from './response-parts.ts';
export type {
  LivePartEvent,
  PartDelta,
  StreamBlock,
  StreamEvent,
  StreamState,
} from './streaming/types.ts';
export { isStrictCompatible } from './structured-output/response-schema.ts';
export type { ResponseFormat, ToolChoice } from './structured-output/types.ts';
export type { JSONValue } from './types.ts';
