/**
 * Operative providers — LLM provider factories folded from the former herald package.
 *
 * These are re-exported from the `@lostgradient/operative` root entry point. Each
 * provider loads its SDK dynamically when called, so unused SDKs stay unused.
 */

export { readBackendDescriptors, withBackendDescriptors } from './backend-descriptor-attachment.ts';
export { getProviderCapabilities } from './capabilities.ts';
export type { ProviderCapabilities } from './capabilities.ts';
export { createOllamaEmbedder, createVoyageEmbedder } from './embeddings/index.ts';
export type { OllamaEmbedderOptions, VoyageEmbedderOptions } from './embeddings/index.ts';
export {
  ProviderContractError,
  ProviderError,
  ToolCallParseError,
  isProviderContractError,
  isToolCallParseError,
  shouldRetryProviderError,
} from './errors.ts';
export {
  FalloverExhaustedError,
  classifyProviderError,
  createFalloverGenerate,
  createProviderHealthTracker,
} from './fallover/index.ts';
export type {
  ErrorClassification,
  FalloverEvent,
  FalloverOptions,
  FalloverProvider,
  ProviderHealth,
} from './fallover/index.ts';
export {
  GENERAL_PROJECTION_REDACTED_KEYS,
  projectCatalog,
  projectDescriptor,
} from './model-catalog-projection.ts';
export { createModelCatalog } from './model-catalog.ts';
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
} from './model-catalog.ts';
export { composePolicy } from './policy.ts';
export type {
  BureauInvariants,
  ComposePolicyInput,
  DelegatedAuthority,
  DeploymentInvariants,
  PolicyCandidate,
  SelectionExclusionCode,
  UserModelConfiguration,
} from './policy.ts';
export type { ProviderConfigurationBase, ProviderDefinition } from './provider-definition.ts';
export { PROVIDER_NAME_PATTERN, isProviderName } from './provider-name.ts';
export {
  composeStrategies,
  createComplexityStrategy,
  createCostAwareStrategy,
  createRoutingGenerate,
  createStepBasedStrategy,
  extractComplexitySignals,
  withRoutingMetrics,
} from './routing/index.ts';
export type {
  ComplexitySignals,
  ComplexityStrategyOptions,
  CostAwareStrategyOptions,
  ModelRoute,
  RoutingDecision,
  RoutingEvent,
  RoutingMetrics,
  RoutingMetricsResult,
  RoutingOptions,
  RoutingStrategy,
  StepBasedStrategyOptions,
} from './routing/index.ts';
export {
  describeInputMedia,
  evaluateInputMedia,
  recordEffectiveGeneration,
  select,
} from './selection.ts';
export type {
  EffectiveGenerationResult,
  InputMediaRequirement,
  RevalidationInput,
  SelectOptions,
  SelectionCandidate,
  SelectionOutcomeFailure,
  SelectionOutcomeKind,
  SelectionPlan,
  SelectionRequest,
  TaskClassification,
} from './selection.ts';
export {
  ANTHROPIC_EFFORT_SUPPORT,
  GEMINI_THINKING_MODELS,
  OPENAI_REASONING_MODELS,
  resolveAnthropicEffort,
  resolveGeminiEffort,
  resolveOpenAIEffort,
} from './shared/effort.ts';
export type { GeminiResolvedEffort } from './shared/effort.ts';
export {
  ANTHROPIC_MODEL_ALIASES,
  GEMINI_MODEL_ALIASES,
  OPENAI_MODEL_ALIASES,
  resolveAnthropicModel,
  resolveGeminiModel,
  resolveOpenAIModel,
} from './shared/model-registry.ts';
export { REPLAY_DATA_DROPPED_METADATA_KEY, readDroppedReplayData } from './shared/replay-data.ts';
export type { DroppedReplayData } from './shared/replay-data.ts';
export type { ResponseFormat, ToolChoice } from './structured-output/index.ts';
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
} from './types.ts';
