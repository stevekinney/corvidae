// Public type surface.
export type { ChunkingOptions, ContentChunk, ExtractedDocument, StructureHint } from './chunking';
export type { ConsolidateProjectionsOptions } from './consolidate-projections';
export type {
  ConsolidationChunkedTaskOptions,
  ConsolidationState,
  CreateConsolidationOptions,
} from './consolidation';
export type { CreateInMemoryEvidenceProjectionStorageOptions } from './create-in-memory-evidence-projection-storage';
export type { CreateWeftEvidenceProjectionStorageOptions } from './create-weft-evidence-projection-storage';
export type { CreateWeftMemoryRecordStorageOptions } from './create-weft-memory-record-storage';
export type {
  BuildDerivedIndexesInput,
  DerivedIndexes,
  EntityIndex,
  GraphEdge,
  GraphEdgeKind,
  GraphIndex,
  IndexSummary,
  LexicalIndex,
  ProjectionHit,
  TemporalIndex,
  VectorIndex,
} from './derived-indexes';
export type { DualNamespaceMemoryOptions } from './dual-namespace-memory';
export type { CachedEmbedder, EmbeddingCacheOptions } from './embedding-cache';
export type {
  EmbeddingProfile,
  EvidenceProjectionRecord,
  ProjectionKind,
  ProjectionReference,
  ProjectionSource,
  ProjectionStatus,
  TransformationStep,
} from './evidence-projection-schema';
export type {
  EvidenceProjectionCommit,
  EvidenceProjectionCommitErrorCode,
  EvidenceProjectionCommitResult,
  EvidenceProjectionStorage,
} from './evidence-projection-storage';
export type {
  EvidenceRecord,
  EvidenceSupersession,
  MemoryEvidenceRejectionCode,
} from './evidence-schema';
export type { RunCaptureHookOptions, StepResultLike } from './experiential';
export type {
  FileSynchronizer,
  FileSynchronizerOptions,
  SynchronizeResult,
} from './file-synchronizer';
export type {
  AttenuateMemoryAuthorityRequest,
  CreateMemoryAuthorityInput,
  MemoryAuthority,
  MemoryAuthorityErrorCode,
  MemoryAuthorityFromToolContextOptions,
  MemoryCapability,
  MemoryDelegationLink,
  MemoryOperation,
  MemoryPrincipal,
  MemoryPrincipalKind,
  MemoryProjection,
} from './governance/authority';
export type { MemoryEvidence, MemoryEvidenceKind } from './governance/evidence';
export type {
  CreateGovernedMemoryOptions,
  GovernedListOptions,
  GovernedMemory,
  GovernedSearchHit,
  GovernedSearchOptions,
  GovernedWriteOptions,
  MemoryDeletionPropagation,
  MemoryDeletionPropagationRequest,
  MemoryDeletionPropagationResult,
  MemoryDeletionPropagator,
  MemoryDeletionResult,
  MemoryEvidenceBundle,
  MemoryExportResult,
  MemoryForgetMode,
  MemoryForgetRequest,
  MemoryForgetResult,
  MemoryGovernanceNotification,
  MemoryLegalHoldResult,
  MemoryOperationResult,
  MemoryOperationStatus,
  MemoryRecallCandidate,
  MemoryRecallContradiction,
  MemoryRecallExclusion,
  MemoryRecallExclusionReason,
  MemoryRecallFilterReport,
  MemoryRecallFreshness,
  MemoryRecallSpend,
  MemoryRecallStageReport,
  MemoryRecallStageScores,
  MemoryRecordLocator,
  MemoryRetentionCandidate,
  MemoryRetentionSweep,
  MemoryWriteReceipt,
  MemoryWriteRejection,
  RecallForModelOptions,
} from './governance/governed-memory-types';
export type {
  CreateGovernedMemoryToolsOptions,
  GovernedMemoryToolAuthorityInput,
  MemoryForgetToolOutput,
  MemoryForgetToolReason,
} from './governance/governed-tools';
export type {
  CreateMemoryGovernanceLedgerOptions,
  MemoryGovernanceLedger,
} from './governance/ledger';
export type {
  AsynchronousDeletionTarget,
  MemoryDeletionPlan,
  MemoryDeletionReceipt,
  MemoryDeletionTarget,
  MemoryDeletionTargetReceipt,
  MemoryDeletionTargetStatus,
  MemoryExportManifest,
  MemoryGovernanceEvent,
  MemoryLineageLink,
  MemoryPendingDerivation,
  MemoryProtectedDiagnostic,
  SynchronousDeletionTarget,
} from './governance/ledger-types';
export type {
  CreateMemoryGovernancePolicyInput,
  MemoryAdmissionPolicy,
  MemoryClass,
  MemoryGovernancePolicy,
  MemoryRecallPolicy,
  MemoryRetentionPolicy,
  MemoryRetentionRule,
  MemorySourceKind,
  MemoryTenantPolicyOverride,
  MemoryTrust,
  ResolvedTenantPolicy,
} from './governance/policy';
export type {
  MemoryAccessDecision,
  MemoryDenialReason,
  MemoryRecordState,
  MemoryRedaction,
  MemoryResourceDescriptor,
  MemoryVisibility,
} from './governance/predicate';
export type { MemoryEvidenceManifest, MemoryRecallDifference } from './governance/recall-replay';
export type {
  DerivedRecordKind,
  GovernedMemoryRecord,
  LegalHoldState,
  MemoryAttribution,
  MemoryRecordLineage,
  MemoryRecordSourceReference,
  RecordGovernance,
} from './governance/record-governance';
export type {
  MemoryPolicyFilter,
  MemoryRecallStopReason,
  MemoryRetrievalBudgets,
  MemoryRetrievalConstraints,
  MemoryRetrievalPlan,
  MemoryRetrievalPlanInput,
  MemoryRetrievalStage,
} from './governance/retrieval-plan';
export type { MemoryGuardrailOptions, ScannedMemoryContent } from './guardrail';
export type { MemoryHookOptions } from './hooks';
export type {
  HybridSearchCandidate,
  HybridSearchOptions,
  HybridSearchResult,
  VectorSearchResult,
} from './hybrid-search';
export type { CreateHyDEGeneratorOptions, HyDEOptions, HypotheticalAnswerGenerator } from './hyde';
export type {
  AgentIdentity,
  CreateSoulDistillationOptions,
  CreateSoulSeedOptions,
  IdentityProvider,
  PersonaDescriptor,
  SoulBudget,
  SoulDiff,
  SoulDiffEntry,
  SoulDistillationChunkedTaskOptions,
  SoulDistillationState,
  SoulHistoryEntry,
  SoulItem,
} from './identity';
export type { ChunkerFunction, IngestOptions, IngestResult } from './ingest';
export type { MaximalMarginalRelevanceOptions } from './maximal-marginal-relevance';
export type { ProjectAssetChunksOptions, ProjectAssetChunksResult } from './project-asset-chunks';
export type { CreateReflectionHookOptions } from './reflection';
export type { GetMemoryStatusOptions, MemoryStatus } from './status';
export type { TemporalDecayOptions } from './temporal-decay';
export type { TemporalValidityMetadata } from './temporal-validity';
export type { InMemoryMemoryRecordStorageOptions } from './test/index';
export type { BM25Options } from './text-search';
export type { TextSearchProvider } from './text-search-provider';
export type { CreateMemoryRecallToolOptions } from './tools';
export type {
  CreateMemoryOptions,
  Embedder,
  EmbeddingVector,
  Memory,
  MemoryEntry,
  MemoryListOptions,
  MemoryMetadata,
  MemoryRecord,
  MemoryRecordPutOnceResult,
  MemoryRecordReference,
  MemoryRecordScope,
  MemoryRecordStorage,
  MemoryRecordUpdateOptions,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryVectorSearchResult,
  NamespaceIsolationOptions,
  OnConflictHandler,
} from './types';

// Public runtime surface.
export { chunkMarkdown, chunkText } from './chunking';
export { createConsolidationTask } from './consolidation';
export { createMemory } from './create-memory';
export { createWeftMemoryRecordStorage } from './create-weft-memory-record-storage';
// The default key prefix is public for custom record storage.
export { DEFAULT_MEMORY_KEY_PREFIX } from './create-weft-memory-record-storage';
export { createDualNamespaceMemory } from './dual-namespace-memory';
export { withEmbeddingCache } from './embedding-cache';
export { createRunCaptureHook, summarizeRun } from './experiential';
export { createFileSynchronizer } from './file-synchronizer';
export {
  assertMemoryAuthority,
  attenuateMemoryAuthority,
  createMemoryAuthority,
  delegationChainIncludes,
  hasMemoryCapability,
  holdsGovernanceAuthority,
  holdsServiceAuthority,
  memoryAuthorityFromToolRequestContext,
  requestPrincipal,
} from './governance/authority';
// The deterministic embedder that needs no model, and the dimension it produces.
export { HASHING_EMBEDDER_DIMENSION, createHashingEmbedder } from './hashing-embedder';
// Capability, operation, principal-kind, and projection vocabularies are public constants.
export {
  MEMORY_ADMINISTRATIVE_CAPABILITIES,
  MEMORY_CAPABILITIES,
  MEMORY_OPERATIONS,
  MEMORY_PRINCIPAL_KINDS,
  MEMORY_PROJECTIONS,
} from './governance/authority';
// Authority errors are public constructors.
export { MemoryAuthorityError } from './governance/authority';
export {
  MEMORY_EVIDENCE_KINDS,
  MEMORY_EVIDENCE_PREAMBLE,
  renderMemoryEvidence,
} from './governance/evidence';
export { createGovernedMemory } from './governance/governed-memory';
export { createGovernedMemoryTools } from './governance/governed-tools';
export { createMemoryGovernanceLedger } from './governance/ledger';
export {
  DEFAULT_MEMORY_RETRIEVAL_BUDGETS,
  DEFAULT_MEMORY_RETRIEVAL_PLAN,
  MEMORY_POLICY_FILTERS,
  MEMORY_RECALL_STOP_REASONS,
  MEMORY_RETRIEVAL_STAGES,
  MemoryRetrievalPlanError,
  createMemoryRetrievalPlan,
} from './governance/retrieval-plan';
// The default governance key prefix is public for custom ledger storage.
export { DEFAULT_MEMORY_GOVERNANCE_KEY_PREFIX } from './governance/ledger';
export {
  ASYNCHRONOUS_DELETION_TARGETS,
  MEMORY_DELETION_TARGETS,
  SYNCHRONOUS_DELETION_TARGETS,
} from './governance/ledger-types';
export { createMemoryPoisoningDetector } from './governance/poisoning-detector';
export { createMemoryGovernancePolicy, resolveTenantPolicy } from './governance/policy';
// Policy vocabularies and retention defaults are public constants.
export {
  DEFAULT_DELETION_BOUND_MILLISECONDS,
  DEFAULT_EPISODIC_RETENTION_MILLISECONDS,
  DEFAULT_SUPERSEDED_RETENTION_MILLISECONDS,
  MEMORY_CLASSES,
  MEMORY_SOURCE_KINDS,
  MEMORY_TRUST_LEVELS,
  MINIMUM_AUDIT_RECEIPT_RETENTION_MILLISECONDS,
} from './governance/policy';
// Policy errors are public constructors.
export { MemoryGovernancePolicyError } from './governance/policy';
export { decideMemoryAccess } from './governance/predicate';
export { collectionNamespace } from './governance/record-governance';
// Derived record kinds and the governance metadata key are public constants.
export {
  DERIVED_RECORD_KINDS,
  MEMORY_GOVERNANCE_METADATA_KEY,
} from './governance/record-governance';
export { provenanceForMemoryEntry, scanMemoryContent } from './guardrail';
export { createMemoryHooks } from './hooks';
export { chunkHtml } from './html-chunking';
export { mergeHybridResults } from './hybrid-search';
export { createHyDEGenerator, withHyDE } from './hyde';
export {
  acceptSoulUpdate,
  createIdentityToolbox,
  createPersonaCreateTool,
  createPersonaDeleteTool,
  createPersonaListTool,
  createPersonaUpdateTool,
  createPersonaViewTool,
  createSoulAcceptTool,
  createSoulDiffTool,
  createSoulDistillationTask,
  createSoulPinTool,
  createSoulRejectTool,
  createSoulSeed,
  createSoulViewTool,
  createStaticIdentityProvider,
  createStorageIdentityProvider,
  getSoulDiff,
  pinSoulItem,
  rejectSoulUpdate,
  resolveIdentity,
  unpinSoulItem,
} from './identity';
export { CHUNK_INDEX_KEY, ingest } from './ingest';
// The source-document key is public for ingestion metadata.
export { SOURCE_DOCUMENT_KEY } from './ingest';
export { applyMaximalMarginalRelevance } from './maximal-marginal-relevance';
export { MemoryRecordVersionConflictError } from './memory-record-storage';
export { withNamespaceIsolation } from './namespace-isolation';
export { extractKeywords, isStopWord } from './query-expansion';
export { createReflectionHook } from './reflection';
export { getMemoryStatus } from './status';
export { applyTemporalDecay, computeTemporalDecay } from './temporal-decay';
export { filterByValidity, isValidAtTimestamp, stampSupersession } from './temporal-validity';
export { createInMemoryMemoryRecordStorage, createMockEmbedder } from './test/index';
export { computeBM25Scores, tokenize } from './text-search';
export { createMemoryForgetTool, createMemoryRecallTool, createMemoryStoreTool } from './tools';

// Immutable evidence, versioned projections, and the indexes derived from them.
export { consolidateProjections } from './consolidate-projections';
// COR-770 — validated procedural memory over evidence and projections.
export { createInMemoryEvidenceProjectionStorage } from './create-in-memory-evidence-projection-storage';
export { createWeftEvidenceProjectionStorage } from './create-weft-evidence-projection-storage';
export {
  DEMOTED_SCORE_WEIGHT,
  DerivedIndexConsistencyError,
  EmbeddingMismatchError,
  buildDerivedIndexes,
  rebuildDerivedIndexes,
} from './derived-indexes';
export {
  EMBEDDING_PROFILE_SCHEMA_VERSION,
  MAX_PROJECTION_REVISION,
  PROJECTION_KINDS,
  PROJECTION_SCHEMA_VERSION,
  PROJECTION_STATUSES,
  PROJECTION_TRANSITION_KINDS,
  TRANSFORMATION_STEPS,
  decodeEvidenceProjectionRecord,
  embeddingProfileSchema,
  encodeEvidenceProjectionRecord,
  evidenceProjectionRecordSchema,
  projectionText,
} from './evidence-projection-schema';
export {
  EvidenceImmutableError,
  EvidenceProjectionBatchLimitError,
  EvidenceProjectionCapacityError,
  EvidenceProjectionCommitError,
  ProjectionRevisionConflictError,
} from './evidence-projection-storage';
export type { WrapApply } from './evidence-projection-store-core';
export {
  EVIDENCE_KINDS,
  EVIDENCE_SCHEMA_VERSION,
  MEMORY_CLASSIFICATIONS,
  MemoryEvidenceValidationError,
  decodeEvidenceRecord,
  digestOfText,
  encodeEvidenceRecord,
  evidenceRecordSchema,
} from './evidence-schema';
export { ProcedureCandidateError, extractProcedureCandidate } from './procedure-candidate';
export type {
  ExtractProcedureCandidateOptions,
  ProcedureCandidate,
  ProcedureCandidateErrorCode,
  ProcedureDraft,
} from './procedure-candidate';
export {
  ProcedureLifecycleError,
  recordProcedureOutcome,
  retireProcedure,
} from './procedure-lifecycle';
export type {
  ProcedureOutcome,
  ProcedureOutcomeRecord,
  RecordProcedureOutcomeBase,
  RecordProcedureOutcomeOptions,
  RetireProcedureOptions,
} from './procedure-lifecycle';
export { promoteProcedure } from './procedure-promotion';
export type {
  ProcedurePromotion,
  ProcedureReviewDecision,
  ProcedureReviewRequest,
  ProcedureValidationRun,
  ProcedureValidator,
  PromoteProcedureOptions,
} from './procedure-promotion';
export { retrieveProcedures } from './procedure-retrieval';
export type {
  ProcedureEnvironmentEntry,
  ProcedureExclusionReason,
  ProcedureMatch,
  ProcedureRetrieval,
  RetrieveProceduresOptions,
} from './procedure-retrieval';
export { projectAssetChunks } from './project-asset-chunks';

// Atomic, verified, observable memory transitions over evidence and projections.
export { TransitionIdentifierConflictError, createTransitionEngine } from './transition-engine';
export type {
  CreateTransitionEngineOptions,
  SubmitTransitionOptions,
  TransitionEngine,
  TransitionEngineHook,
  TransitionEngineHookContext,
} from './transition-engine';
export {
  TRANSITION_EVENT_KINDS,
  memoryCorrelationSchema,
  transitionEventSchema,
} from './transition-events';
export type {
  MemoryCorrelation,
  TransitionEvent,
  TransitionEventSink,
  TransitionSourceReference,
} from './transition-events';
export { TRANSITION_VALIDATION_REASONS } from './transition-outcome';
export type {
  TransitionConflictReason,
  TransitionRejectionReason,
  TransitionResult,
  TransitionValidationReason,
} from './transition-outcome';
export {
  MemoryTransitionProposalError,
  TRANSITION_PROPOSAL_KINDS,
  transitionDigest,
  transitionProposalSchema,
} from './transition-proposal';
export type {
  AppendEvidenceProposal,
  ConsolidateProposal,
  CorrectEvidenceProposal,
  CreateProjectionProposal,
  ReviseProjectionProposal,
  TransitionProposal,
  TransitionProposalKind,
} from './transition-proposal';
export {
  DEFAULT_TRANSITION_KEY_PREFIX,
  TRANSITION_RECEIPT_SCHEMA_VERSION,
  TRANSITION_VALIDATION_CHECKS,
  decodeTransitionReceipt,
  encodeTransitionReceipt,
  transitionReceiptSchema,
} from './transition-receipt';
export type { TransitionReceipt, TransitionValidationCheck } from './transition-receipt';
