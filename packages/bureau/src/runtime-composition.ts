import { storedScheduleInput, workflowScheduleBinding } from './workflow-schedule.ts';
import { normalizeRunRequestContext } from './session-request-context.ts';
import {
  createRunAuthorityValidator,
  guardWorkspaceRunOptions,
  mayUseAutomationInput,
  recoverRunWorkspaceAuthority,
} from './run-authority.ts';
import type { RuntimeServices } from '@lostgradient/lifecycle';
import { createSecretAnswerStore, secretResolverOf } from './secret-answers';
import {
  createDefaultRuntimeServices,
  HOOK_TIER_PRIORITY_BANDS,
  HookRegistry,
  TypedEventTarget,
} from '@lostgradient/lifecycle';
import { composeRunHooks, pluginHookTier, type RunHookTiers } from './run-hook-tiers';
import type { GovernedMemory } from '@lostgradient/memory';
import type {
  AgentSession,
  DurableRunDeps,
  GenerateFunction,
  DecisionModel,
  GenerationMode,
  BureauChildInvariants,
  GuardrailHooks,
  GuardrailsOptions,
  JSONValue,
  OnStepHook,
  OperativeHookMap,
  ProviderDefinition,
  RunOptions,
  ScheduledAgentRunInput,
  SessionStore,
  SessionSummary,
  StepRecord,
  StreamEventMap,
  PersistedSessionTaint,
} from '@lostgradient/operative';
import {
  appendAgentInput,
  readBackendDescriptors,
  withBackendDescriptors,
  createAgentSession,
  createCheckpointStore,
  createDefaultGuardrailsPreset,
  createGuardrails,
  createSessionTaintTracker,
  DEFAULT_TAINT_THRESHOLD,
  withSessionTaint,
  createIdentityHook,
  createRunEngine,
  createRunWorkflow,
  createSessionStore,
  DEFAULT_MAXIMUM_STEPS,
  isAgentRunWorkflowInput,
  isFailureFinishReason,
  isScheduledAgentRunInput,
  payloadText,
  reservedIdentifierReason,
  ScheduleAttemptedEvent,
  ScheduleCompletedEvent,
  ScheduleFailedEvent,
  SCHEDULER_ORIGIN_TAG,
  SCHEDULER_RUN_ID_PREFIX,
  ScheduleSkippedEvent,
  withActiveSkillToolPolicy,
  bureauInvariantsField,
  withCache,
  withEnhancedStreaming,
  WorkflowVersionMismatchEvent,
  SESSION_ORIGIN_METADATA_KEY,
  SESSION_TAINT_METADATA_KEY,
  readSessionTaint,
  sessionOriginOf,
  SESSION_OWNER_METADATA_KEY,
} from '@lostgradient/operative';
import {
  createSkillArtifactLoader,
  createSkillClient,
  createSkillClientToolbox,
  DEFAULT_SOURCE_PRECEDENCE,
  discoverSkills,
  renderActiveSkillInstructions,
  renderClientCatalog,
  type SkillActivationRecord,
  type SkillCatalogRevision,
  type SkillEventMap,
  type ToolPolicy,
} from './skills';
import { fenceStorage } from './storage-fence';
import { withChatPermission } from './tool-approval';
import { withAddedTools, withToolboxLayer } from './toolbox-additions';
import {
  createWorkflowLogStore,
  decode,
  deserializeCheckpoint,
  encode,
  KEYS,
  type WorkflowLogRecord,
  WorkflowCancelledEvent,
  WorkflowTimedOutEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  type WorkflowServicesResolution,
  type WorkflowServicesResolverInfo,
} from '@lostgradient/weft';
import {
  type ConditionalTextValueStore,
  type Storage,
  storageConditionalBatch,
  type TextValueStore,
  textValueStore,
} from '@lostgradient/storage';
import {
  type AnyToolbox,
  createToolbox,
  type ToolCallInput,
  type ToolRequestContext,
} from 'armorer';
import {
  Conversation,
  type ConversationHistory,
  createConversationHistory,
  getFirstSystemMessage,
  getOwn,
} from 'conversationalist';
import { activeSkillToolPolicy, agentSkillsRun, createSkillGuardrailOptions } from './agent-skills';
import { isTryAgentName } from './agent-try';
import { type GoalAttemptTarget, registerGoalAttemptFence } from './goal-attempt-fence';
import { bufferMissedFires } from './bureau-event-forwarders';
import { ownerOrLocal } from './owner-of-record';
import { resolveDiagnosticSink, serializeUnknownError } from './serialization';
import {
  isPlainAuthorityRecord,
  isSessionAuthorityAuthorized,
  resolveRunMemoryOwner,
  resolveSessionOwner,
  SessionOwnerConflictError,
} from './session-authority';
import { committedFireApprovalIds } from './scheduled-fire-review-state';
import {
  createSessionTaintSeam,
  type SessionTaintSeam,
  type SessionTaintSource,
} from './session-taint-seam';
import {
  copyAgentOwnedRunOptions,
  scheduledAgentRunOptions,
  sessionExecuteOptions,
} from './session-agent-options';
import type { CacheConfiguration, ProviderConfiguration, StreamingConfiguration } from './types';
import { ownEntry } from './own-entry';
import { DEFAULT_MAX_CONCURRENT_RUNS } from './settings/settings-options';
import { holdGenerateToModelPolicy } from './code-agent-model-policy';
import { type RecoveredScheduleMarker, isRecord } from './schedule-run-marker';
import type {
  BureauInvariantOptions,
  BureauToolbox,
  CatalogAgentRunOptionsResolver,
  CatalogRunRecordedDefinition,
  DurableComposition,
  MediaRowHolder,
  MediaRunOptions,
  RecoveredSkillPolicy,
  RunRuntimeRequest,
  RuntimeComposition,
  RuntimeCompositionDependencies,
  RuntimeCompositionOptions,
  ScheduleFireEventMap,
  ScheduledFireServicesNotice,
  ScheduledFireSettlement,
  ScheduledSessionNotice,
  SessionAgentRun,
  SessionAgentRunResolution,
  SkillRecoveryOutcome,
  SkillSnapshot,
} from './runtime-composition-types';
import {
  type CatalogRunRecoveryLoad,
  type CatalogRunRecoveryRecord,
  type GoalAttemptClaimFence,
  type GoalAttemptClaimOwner,
  catalogRunRecoveryKey,
  isCatalogRunRecoveryRecord,
} from './catalog-run-recovery-record';
import {
  type RunMemoryTarget,
  createMemoryPersistHook,
  createMemoryRecallHook,
  createRunMemoryAuthority,
} from './run-memory';
import {
  createSchedulerServiceRequestContext,
  defaultBureauAgentName,
  grantedTools,
  hasDispatchEvent,
  recoveredOwnerOf,
  recoveredRequestContext,
  wireDurableOptInTools,
  withDefaultToolboxRequestContext,
} from './run-request-context';

function persistedScheduleMarker(input: ScheduledAgentRunInput): string | undefined {
  if (typeof input.scheduleId !== 'string') return undefined;
  const scheduleId = input.scheduleId.trim();
  return scheduleId.length > 0 ? scheduleId : undefined;
}

function hasPersistedScheduleMarker(input: ScheduledAgentRunInput): boolean {
  return persistedScheduleMarker(input) !== undefined;
}

/**
 * Weft 0.10+ native `KEYS.scheduleRun(...)` marker: an object of shape
 * `{ id, occurrence? }` written by `encodeScheduleRunMetadata` (see weft's
 * `src/core/engine/schedule-run-metadata.ts`). Pre-0.10 stores may still hold
 * the legacy plain-string marker, handled separately in
 * {@link decodeScheduleRunMarker}.
 */
function isScheduleRunMarkerObject(value: unknown): value is { id: string; occurrence?: number } {
  if (!isRecord(value)) return false;
  const { id, occurrence } = value;
  return typeof id === 'string' && (occurrence === undefined || typeof occurrence === 'number');
}

/**
 * Decode a `KEYS.scheduleRun(...)` storage value (already `decode()`d from
 * bytes) into its schedule id, accepting both the legacy plain-string marker
 * and Weft 0.10+'s `{ id, occurrence? }` metadata object. Returns `undefined`
 * when the value is neither shape, or the id is blank. The returned id is
 * always trimmed, so accidental whitespace never propagates into downstream
 * equality checks or embedded session ids.
 */
export function decodeScheduleRunMarker(decoded: unknown): string | undefined {
  if (typeof decoded === 'string') {
    const trimmed = decoded.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (isScheduleRunMarkerObject(decoded)) {
    const trimmed = decoded.id.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

/** The text of the first system message `options.conversation` carries, or `undefined`. */
function agentInstructionsFromRunOptions(options: RunOptions): string | undefined {
  const history =
    options.conversation instanceof Conversation
      ? options.conversation.current
      : options.conversation;
  const content = getFirstSystemMessage(history)?.content;
  if (typeof content === 'string') return content;
  if (content === undefined) return undefined;
  const text = content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
  return text.length === 0 ? undefined : text;
}

/** The input a session run resolves its agent with; the run's own conversation replaces it. */
const SESSION_AGENT_PLACEHOLDER_INPUT = 'session run';

/** The default agent a run with no `agentName` belongs to; it has no catalog entry. */
const BUREAU_AGENT_NAME = 'bureau';

/** Session metadata: the definition revision of the named agent the latest run started under. */
export const SESSION_AGENT_REVISION_METADATA_KEY = 'lastAgentRevision';

/**
 * COR-1524 — where a session run records the SHA-256 of the agent file it started with (`null`
 * for a code-defined agent), so a recovered run builds from its snapshot.
 */
export const SESSION_AGENT_DEFINITION_HASH_METADATA_KEY = 'lastAgentDefinitionHash';

/**
 * COR-1584 — the definition revision a session's metadata recorded for the definition at `hash`.
 * A session's metadata names its latest run's definition only, so the revision is the run's own
 * only when the hash is the one the metadata names; any other run's revision is not recorded
 * there, and the caller gets `undefined`.
 */
export function sessionRecordedRevision(
  metadata: Readonly<Record<string, unknown>>,
  hash: unknown,
): number | undefined {
  const revision = metadata[SESSION_AGENT_REVISION_METADATA_KEY];
  return typeof hash === 'string' &&
    metadata[SESSION_AGENT_DEFINITION_HASH_METADATA_KEY] === hash &&
    typeof revision === 'number'
    ? revision
    : undefined;
}

function recoveredMarkerSessionId(marker: RecoveredScheduleMarker | undefined): string | undefined {
  return marker?.status === 'found' ? undefined : marker?.sessionId;
}

function lastScheduledFirePromptIndex(history: ConversationHistory, runId: string): number {
  for (let index = history.ids.length - 1; index >= 0; index -= 1) {
    const message = getOwn(history.messages, history.ids[index]!);
    if (message?.role === 'user' && message.metadata['scheduledFireRunId'] === runId) {
      return index;
    }
  }
  return -1;
}

function removeConversationIndexRange(
  history: ConversationHistory,
  startIndex: number,
  endIndex: number,
): ConversationHistory {
  const ids = history.ids.filter((_, index) => index < startIndex || index > endIndex);
  const messages: Record<string, ConversationHistory['messages'][string]> = {};
  for (const [position, id] of ids.entries()) {
    const message = getOwn(history.messages, id);
    if (message) messages[id] = { ...message, position };
  }
  return { ...history, ids, messages };
}

export function removeLastScheduledFireTranscript(
  history: ConversationHistory,
  runId: string,
): ConversationHistory {
  const promptIndex = lastScheduledFirePromptIndex(history, runId);
  if (promptIndex === -1) return history;
  const nextUserIndex = history.ids.findIndex((id, index) => {
    if (index <= promptIndex) return false;
    return getOwn(history.messages, id)?.role === 'user';
  });
  const endIndex = nextUserIndex === -1 ? history.ids.length - 1 : nextUserIndex - 1;
  return removeConversationIndexRange(history, promptIndex, endIndex);
}

/**
 * Builds the generate function for a configured provider from the definitions a host registered.
 *
 * The definition whose `name` equals `configuration.provider` serves it: its `stream` method,
 * wrapped in enhanced streaming over `streamEventTarget`, when one is given, and its `generate`
 * method otherwise. The configuration reaches the definition whole, so a field the shared
 * configuration type does not name (an injected `client`, say) arrives unchanged.
 *
 * @throws {Error} When two definitions carry one name, whether or not the configuration selects
 * it, or when no definition carries `configuration.provider`.
 */
export function resolveProviderGenerate(
  definitions: readonly ProviderDefinition[],
  configuration: ProviderConfiguration,
  streamEventTarget: TypedEventTarget<StreamEventMap> | undefined,
  streamingConfiguration: StreamingConfiguration | undefined,
  pluginConfiguration?: unknown,
): GenerateFunction {
  const seen = new Set<string>();
  for (const { name } of definitions) {
    if (seen.has(name)) throw new Error(`Duplicate provider definition "${name}".`);
    seen.add(name);
  }
  const definition = definitions.find(({ name }) => name === configuration.provider);
  if (definition === undefined) {
    const registered = definitions.map(({ name }) => name).join(', ');
    throw new Error(
      `Unknown provider "${configuration.provider}". Registered providers: ${registered === '' ? 'none' : registered}.`,
    );
  }
  if (streamEventTarget === undefined) {
    if (definition.generate === undefined) {
      throw new TypeError(`Provider "${definition.name}" does not provide generate capability.`);
    }
    return definition.generate(configuration, pluginConfiguration);
  }
  if (definition.stream === undefined) {
    throw new TypeError(`Provider "${definition.name}" does not provide stream capability.`);
  }
  return withEnhancedStreaming(definition.stream(configuration, pluginConfiguration), {
    eventTarget: streamEventTarget,
    onTextDelta: streamingConfiguration?.onTextDelta,
  });
}

/** Builds the native decision model for a configured provider. */
export function resolveProviderDecide(
  definitions: readonly ProviderDefinition[],
  configuration: ProviderConfiguration,
  pluginConfiguration?: unknown,
): DecisionModel {
  const seen = new Set<string>();
  for (const { name } of definitions) {
    if (seen.has(name)) throw new Error(`Duplicate provider definition "${name}".`);
    seen.add(name);
  }
  const definition = definitions.find(({ name }) => name === configuration.provider);
  if (definition === undefined) {
    const registered = definitions.map(({ name }) => name).join(', ');
    throw new Error(
      `Unknown provider "${configuration.provider}". Registered providers: ${registered === '' ? 'none' : registered}.`,
    );
  }
  if (definition.decide === undefined) {
    throw new TypeError(`Provider "${definition.name}" does not provide decide capability.`);
  }
  return definition.decide(configuration, pluginConfiguration);
}

export function applyCache(
  generate: GenerateFunction,
  configuration: CacheConfiguration | undefined,
  store: TextValueStore | undefined,
): GenerateFunction {
  if (!configuration) {
    return generate;
  }

  const cacheStore = configuration.store ?? store;
  if (configuration.enabled === false || !cacheStore) {
    return generate;
  }

  return withCache(generate, {
    ...configuration,
    store: cacheStore,
  });
}

const defaultRuntimeCompositionDependencies: RuntimeCompositionDependencies = {
  createSessionStore,
};

/**
 * The media options Bureau contributes to a run that already has its own: whichever of
 * the two the run left unset. An agent that supplied its own resolver or its own
 * unverified-asset policy keeps it.
 */
export function unsetMediaOptions(run: MediaRunOptions, bureau: MediaRunOptions): MediaRunOptions {
  return {
    ...(run.contentSourceResolver === undefined && bureau.contentSourceResolver !== undefined
      ? { contentSourceResolver: bureau.contentSourceResolver }
      : {}),
    ...(run.assetSafety === undefined && bureau.assetSafety !== undefined
      ? { assetSafety: bureau.assetSafety }
      : {}),
    ...(run.generatedMediaAdmitter === undefined && bureau.generatedMediaAdmitter !== undefined
      ? { generatedMediaAdmitter: bureau.generatedMediaAdmitter }
      : {}),
  };
}

/**
 * COR-1577 — the media options of a session run: Bureau's for the run's owner, except where the
 * named agent supplied its own resolver or unverified-asset policy, as on a catalog dispatch.
 */
export function sessionRunMediaOptions(
  sessionAgent: SessionAgentRun | undefined,
  bureau: MediaRunOptions,
): MediaRunOptions {
  if (sessionAgent === undefined) return bureau;
  const { contentSourceResolver, assetSafety, generatedMediaAdmitter } = sessionAgent.options;
  return {
    ...(contentSourceResolver === undefined ? {} : { contentSourceResolver }),
    ...(assetSafety === undefined ? {} : { assetSafety }),
    ...(generatedMediaAdmitter === undefined ? {} : { generatedMediaAdmitter }),
    ...unsetMediaOptions(sessionAgent.options, bureau),
  };
}

function messagesAreEqual(
  left: ConversationHistory['messages'][string],
  right: ConversationHistory['messages'][string],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appendConversationMessages(
  current: ConversationHistory,
  candidate: ConversationHistory,
  base: ConversationHistory,
): ConversationHistory {
  const baseIds = new Set(base.ids);
  const candidateIds = new Set(candidate.ids);
  const currentIds = new Set(current.ids);
  const currentPreservedIds = current.ids.filter((id) => candidateIds.has(id) || !baseIds.has(id));
  const candidateOnlyIds = candidate.ids.filter((id) => !currentIds.has(id));
  const ids = [...currentPreservedIds, ...candidateOnlyIds];
  const messages: Record<string, ConversationHistory['messages'][string]> = {};

  for (const id of ids) {
    const candidateMessage = getOwn(candidate.messages, id);
    const baseMessage = getOwn(base.messages, id);
    const message =
      candidateMessage &&
      (!baseMessage ||
        !messagesAreEqual(candidateMessage, baseMessage) ||
        !getOwn(current.messages, id))
        ? candidateMessage
        : (getOwn(current.messages, id) ?? candidateMessage);
    if (message) messages[id] = message;
  }

  for (const [position, id] of ids.entries()) {
    const message = getOwn(messages, id);
    if (message) messages[id] = { ...message, position };
  }

  return {
    ...current,
    metadata: {
      ...current.metadata,
      ...candidate.metadata,
    },
    ids,
    messages,
    updatedAt: candidate.updatedAt,
  };
}

const activeSkillsStepMetadataKey = '__bureauActiveSkills';
const activeSkillsStepMetadataVersion = 2;

function activeSkillsStepMetadata(records: readonly SkillActivationRecord[]): JSONValue {
  return {
    version: activeSkillsStepMetadataVersion,
    entries: records as unknown as JSONValue,
  };
}

export function activeSkillsFromStepMetadata(
  metadata: StepRecord['metadata'],
): SkillActivationRecord[] | undefined {
  const raw = metadata?.[activeSkillsStepMetadataKey];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const snapshot = raw as Record<string, unknown>;
  if (snapshot['version'] !== activeSkillsStepMetadataVersion) return undefined;
  const entries = snapshot['entries'];
  return isSkillActivationRecordArray(entries) ? entries : undefined;
}

/**
 * Validates a value read back out of session or step metadata as activation records.
 *
 * Every digest field is required, not optional. A record missing one would recover a skill by name
 * with nothing to check the content against, which is the failure the records exist to prevent —
 * so a malformed snapshot recovers nothing rather than recovering unverifiably.
 */
export function isSkillActivationRecordArray(value: unknown): value is SkillActivationRecord[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return false;
    const candidate = item as Record<string, unknown>;
    for (const field of [
      'name',
      'sourceId',
      'sourceKind',
      'trust',
      'artifactDigest',
      'instructionsDigest',
      'activatedAt',
    ]) {
      if (typeof candidate[field] !== 'string') return false;
    }
    if (typeof candidate['catalogRevision'] !== 'number') return false;
    if (!Array.isArray(candidate['requestedTools'])) return false;
    if (candidate['requestedTools'].some((tool) => typeof tool !== 'string')) return false;
  }
  return true;
}

/**
 * The session-metadata keys a step boundary writes.
 *
 * The same keys {@link createSkillRecordSnapshotHook} writes, deliberately: one snapshot
 * mechanism, one set of keys, one thing for recovery to read. Two parallel snapshots is how a
 * recovered run ends up restoring whichever of them the reader happened to know about.
 */
function activeSkillSessionMetadataForStep(
  records: readonly SkillActivationRecord[],
  step: number,
  runId?: string,
): Record<string, JSONValue> {
  return {
    activeSkillRecords: records as unknown as JSONValue,
    ...(runId !== undefined
      ? {
          activeSkillRecordsRunId: runId,
          activeSkillRecordsStep: step,
        }
      : {}),
  };
}

/** A snapshot field named in a reason: its string, or what the field holds instead. */
function describe(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : value === null ? 'null' : 'nothing';
}

const recoveredSkillPolicies = new WeakMap<object, RecoveredSkillPolicy>();

/** Records what recovery built `toolbox` with. */
export function recordRecoveredSkillPolicy(toolbox: object, policy: RecoveredSkillPolicy): void {
  recoveredSkillPolicies.set(toolbox, policy);
}

/** What recovery built `toolbox` with, or `undefined` for a toolbox it did not build. */
export function recoveredSkillPolicyOf(toolbox: object): RecoveredSkillPolicy | undefined {
  return recoveredSkillPolicies.get(toolbox);
}

export function recordedAgentStep(value: unknown): StepRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate['conversationSnapshot'] !== 'object' ||
    candidate['conversationSnapshot'] === null
  ) {
    return undefined;
  }
  if (typeof candidate['nextAccumulators'] !== 'object' || candidate['nextAccumulators'] === null) {
    return undefined;
  }
  const record = candidate['record'];
  if (typeof record !== 'object' || record === null) return undefined;
  const stepRecord = record as Record<string, unknown>;
  const step = stepRecord['step'];
  if (!Number.isInteger(step) || (step as number) < 0) return undefined;
  if (typeof stepRecord['content'] !== 'string') return undefined;
  // COR-713: only a current-version step record counts; an older one carries no parts.
  if (stepRecord['schemaVersion'] !== 2 || !Array.isArray(stepRecord['parts'])) return undefined;
  if (!Array.isArray(stepRecord['toolCalls'])) return undefined;
  if (!Array.isArray(stepRecord['results'])) return undefined;
  if (typeof stepRecord['final'] !== 'boolean') return undefined;
  if (
    stepRecord['metadata'] !== undefined &&
    (typeof stepRecord['metadata'] !== 'object' ||
      stepRecord['metadata'] === null ||
      Array.isArray(stepRecord['metadata']))
  ) {
    return undefined;
  }
  return record as StepRecord;
}

/**
 * Snapshot the active skill set to session metadata after each completed step.
 *
 * EFFECTFUL hook (seam #11): on a durable recovery the crashed in-flight step
 * re-runs from its boundary, so this hook can fire AGAIN for the same step. The
 * write is IDEMPOTENT — a re-fire for step N overwrites `activeSkillRecords` with the
 * same value (completed steps do not re-run their tool executions, so the active-skill
 * set is unchanged on replay). This is a state snapshot, NOT an append — the last
 * writer wins (matching the single-source-of-truth model for `activeSkillRecords`).
 *
 * Replay classification: `effectful` (writes to external storage) but SAFE across
 * recovery re-fires because the payload is deterministic for a given step boundary
 * (completed steps replay identically, producing the same active-skill set).
 */
/**
 * Snapshots the catalog revision and every activation record after each step.
 *
 * The provider-backed snapshot carries a name and a tool policy. That is enough to re-activate
 * something with the same name and nothing at all to prove it is the same skill — COR-752 named
 * exactly this gap ("neither carries source, trust decision, digest, or admitted instructions").
 * These records carry the source, the trust decision, the artifact digest and the instructions
 * digest, which is what lets recovery refuse a skill whose content drifted rather than silently
 * resurrecting different text under a reviewed name.
 */
function createSkillRecordSnapshotHook(
  client: { activationRecords(): readonly SkillActivationRecord[] },
  catalog: { revision: number; digest: string },
  sessionId: string,
  store: SessionStore,
  runId?: string,
): OnStepHook {
  return async (context) => {
    try {
      await store.updateMetadata(sessionId, {
        activeSkillRecords: client.activationRecords() as unknown as JSONValue,
        skillCatalogRevision: catalog.revision,
        skillCatalogDigest: catalog.digest,
        ...(runId === undefined
          ? {}
          : { activeSkillRecordsRunId: runId, activeSkillRecordsStep: context.step }),
      });
    } catch {
      // Non-fatal, same as the entry-based hook: a failed snapshot must not abort the step. The
      // cost is that recovery starts from an empty active set, which is the safe direction.
    }
  };
}

function createUnavailableToolbox(): BureauToolbox {
  const emptyToolbox = createToolbox([], { context: {} });
  const execute = ((
    toolCalls: ToolCallInput | ToolCallInput[],
    executionOptions?: Parameters<BureauToolbox['execute']>[1],
  ) => {
    const normalizedToolCalls = Array.isArray(toolCalls) ? toolCalls : [toolCalls];
    if (normalizedToolCalls.length > 0) {
      throw new Error('No toolbox configured but tool calls were received');
    }

    return emptyToolbox.execute([], executionOptions);
  }) as unknown as BureauToolbox['execute'];

  return {
    ...emptyToolbox,
    execute,
  };
}

/**
 * `createRuntimeComposition` builds bureau-level generate/toolbox/
 * persistence/durability composition — entirely orthogonal to the typed
 * `agents` catalog (AB-22), which `createBureau` wires separately. Omitting
 * `agents` here means every existing caller (including the 100+ direct
 * `createRuntimeComposition({...})` calls in this package's own test suite)
 * keeps working unchanged; it is not part of this function's contract.
 */
/**
 * Priority pinning a Bureau registration behind every other tier's entries on
 * the same hook point (COR-1265, criteria 9 and 10), before the `bureau` band
 * is added.
 *
 * Two dispatch shapes let a later handler decide the outcome: `runLast`
 * returns the last defined result, and the waterfall feeds each handler the
 * previous one's return value. On both, "runs last" means "wins", so a Bureau
 * registration that narrows — today `bureau:guardrails-validate-response` — has
 * to sort behind whatever an agent or a direct caller registered. The trailing
 * `onStep` hooks take the same value for the ordering reason rather than the
 * authority one: they persist the session once the step's mutations settle, and
 * an agent-tier `onStep` handler is one of those mutations.
 *
 * The tier band works against Bureau here. `mergeHookRegistries` adds each
 * tier's fixed band (`HOOK_TIER_PRIORITY_BANDS`, COR-2127), and Bureau's is the
 * LARGEST — `+3000`, above the plugin, agent and direct tiers. The constant
 * sits that band above `Number.MIN_SAFE_INTEGER`, so a merged Bureau entry
 * stays inside the safe-integer range and still lands below anything
 * registered at a priority a caller would plausibly write, whichever tiers a
 * run has.
 *
 * The residual, stated rather than implied: a lower tier whose entry, band
 * included, sits at or below this one's merged priority sorts after it
 * anyway. No finite constant closes that, because a priority is a plain number
 * with no floor, and `-Infinity` closes it only until a second entry carries it
 * — the registry's `b.priority - a.priority` comparator would then return
 * `NaN`. A tier deliberately reaching for the bottom of the number line is not
 * the threat this is defending against; an ordinary registration that happens
 * to outrank Bureau is.
 */
export const BUREAU_PINNED_LAST_PRIORITY =
  Number.MIN_SAFE_INTEGER + HOOK_TIER_PRIORITY_BANDS.bureau;

/**
 * The ownership tier every registration Bureau makes belongs to (COR-1265) —
 * set once on a registry, stamped by `on()` onto each entry so it survives
 * `mergeHookRegistries`.
 */
export const BUREAU_HOOK_TIER = 'bureau';

/**
 * Registers the identity invariant. Shared by the per-run composition and by
 * {@link RuntimeComposition.createBureauInvariantHooks}, which is the whole
 * reason it is a function: the two register at different points in their own
 * registries and must not drift into two different registrations.
 */
function registerIdentityInvariant(
  registry: HookRegistry<OperativeHookMap>,
  identity: NonNullable<RuntimeCompositionOptions['identity']>,
): void {
  registry.on('prepareStep', createIdentityHook(identity), {
    id: 'bureau:identity',
    // Appends a system message to the step's conversation and touches nothing
    // outside it; a replayed step rebuilds that conversation from persisted
    // history, so re-running this reproduces state rather than repeating an
    // external effect.
    replay: 'safe',
  });
}

/**
 * Registers the guardrail invariants: the input scan, the tool-result scan (COR-2103), the output
 * check, and the tool-call validators (COR-2104), in the order the legacy arrays ran the first and
 * last.
 *
 * The caller decides WHEN — the per-run composition registers `prepareStep`
 * last of all its `prepareStep` hooks on purpose, so the input guardrail scans a
 * step context every earlier hook has already contributed to.
 */
function registerGuardrailInvariants(
  registry: HookRegistry<OperativeHookMap>,
  guardrails: GuardrailHooks,
): void {
  registry.on('prepareStep', guardrails.prepareStep, {
    id: 'bureau:guardrails-prepare-step',
    // Scans and may taint the session. The taint is stored by a compare-and-swap that keeps the first
    // one, so a replayed step stores nothing twice (COR-2105).
    replay: 'safe',
  });
  registry.on('validateResponse', guardrails.validateResponse, {
    id: 'bureau:guardrails-validate-response',
    // COR-1265 criterion 10. `validateResponse` is dispatched as a waterfall,
    // so the LAST handler to answer hands its response to the run — an agent-
    // or direct-tier handler running after this one would decide what the
    // guardrail's narrowing was worth. Pinned last so it does not.
    priority: BUREAU_PINNED_LAST_PRIORITY,
    replay: 'safe',
  });
  // COR-2103 — the input detectors over each tool result. `validateToolResult` is a waterfall too,
  // so it is pinned last for the same reason as `validateResponse`.
  registry.on('validateToolResult', guardrails.validateToolResult, {
    id: 'bureau:guardrails-validate-tool-result',
    priority: BUREAU_PINNED_LAST_PRIORITY,
    replay: 'safe',
  });
  // COR-2104 — the tool-call validators. `beforeToolExecution` waterfalls the call list, so they
  // are pinned last too: they judge the calls every other tier's hook settled on.
  registry.on('beforeToolExecution', guardrails.beforeToolExecution, {
    id: 'bureau:guardrails-before-tool-execution',
    priority: BUREAU_PINNED_LAST_PRIORITY,
    replay: 'safe',
  });
}

/**
 * Priority placing a hook after every hook bureau's own composition registered.
 *
 * The same value as {@link BUREAU_PINNED_LAST_PRIORITY}, and deliberately not a
 * separate band: COR-1265's criterion 9 makes the two trailing hooks outrank
 * every tier's `onStep` handlers, not merely Bureau's own, and a value chosen
 * relative to Bureau's default `0` could not do that once a second tier exists.
 */
const TRAILING_HOOK_PRIORITY = BUREAU_PINNED_LAST_PRIORITY;

/**
 * Registers a per-call `onStep` hook that must run AFTER the run runtime's own
 * — the session write-back on a scheduled fire, the pending-approval persist on
 * an interactive run. Both were array spreads (`[...runRuntime.onStep, extra]`)
 * whose ordering came from their position in the literal; the priority states
 * it instead, so it survives the hook moving.
 *
 * This mutates the run's registry and returns it, rather than merging into a
 * fresh one, because the registry is created per run inside `createRunRuntime`
 * and the caller here owns that run outright.
 *
 * COR-1265: every caller now merges the result before handing it to a run, so
 * the completed Bureau tier is what `composeRunHooks` takes as its `bureau`
 * tier. That ordering is the point — registering here AFTER the merge would
 * put the trailing hook in the merged registry at its raw priority while every
 * other Bureau entry had already been given the `bureau` band, which is
 * precisely the renumbering this function used to avoid by refusing to merge at
 * all.
 */
export function registerTrailingOnStep(
  hooks: HookRegistry<OperativeHookMap>,
  id: string,
  handler: OnStepHook,
): HookRegistry<OperativeHookMap> {
  hooks.on('onStep', handler, {
    id,
    priority: TRAILING_HOOK_PRIORITY,
    // Writes a session record.
    replay: 'effectful',
  });
  return hooks;
}

/**
 * COR-1596 — the field of a persisted request authority that says it is a schedule fire's.
 */
export const SCHEDULED_FIRE_AUTHORITY_MARKER = 'scheduledFire';

/**
 * COR-1596 — whether the authority a session recorded for `runId` is a schedule fire's. A fire
 * runs on the Bureau-wide runtime and its agent name is a label, not a catalog entry, so what
 * resumes its approval after a restart must not look the name up in the catalog the way a session
 * run's does.
 */
export function isScheduledFireAuthority(
  metadata: Record<string, JSONValue>,
  runId: string,
): boolean {
  const authorities = metadata['lastRequestAuthorities'];
  if (!isPlainAuthorityRecord(authorities)) return false;
  const authority = ownEntry(authorities, runId);
  return isPlainAuthorityRecord(authority) && authority[SCHEDULED_FIRE_AUTHORITY_MARKER] === true;
}

/**
 * COR-1596 — what a schedule fire's session records for a tool call its step left awaiting
 * approval: the pending approval under its review id, its supersession round (0, or the round
 * already recorded), and the request authority the fire ran under. These are the keys a session
 * run's approvals are recorded under, so the boot restore of a terminal run's approvals finds a
 * fire's too. Idempotent by key: a replayed step writes the same entries.
 *
 * `committed`, given for a fire that is replaying after a crash, names the review ids of the
 * approvals the run's checkpoint holds. A fire writes its session as each step completes and
 * commits the step after, so a crash between the two leaves an approval in the session that the
 * run never committed; the replay may not make that call again. Every approval of this run that
 * is neither committed nor this step's is dropped from the write, and the authority with the last
 * of them.
 */
export function scheduledFireApprovalMetadata(
  metadata: Record<string, JSONValue>,
  runId: string,
  results: readonly { readonly outcome: string; readonly pendingApproval?: unknown }[],
  requestContext: ToolRequestContext,
  committed?: ReadonlySet<string>,
): Record<string, JSONValue> {
  const prefix = `approval:${runId}:`;
  // A review the session records as decided is not recorded as pending again: a replay that
  // makes the same call under the same id would list it for ever, with nothing to decide.
  const decided = new Set(
    Array.isArray(metadata['resolvedReviewIds']) ? metadata['resolvedReviewIds'] : [],
  );
  const approvals: Array<[string, JSONValue]> = [];
  for (const result of results) {
    if (result.outcome !== 'action_required' || result.pendingApproval === undefined) continue;
    const approval = JSON.parse(JSON.stringify(result.pendingApproval)) as JSONValue;
    const callId = isPlainAuthorityRecord(approval) ? approval['callId'] : undefined;
    if (typeof callId !== 'string' || decided.has(`${prefix}${callId}`)) continue;
    approvals.push([`${prefix}${callId}`, approval]);
  }
  const recordOf = (value: JSONValue | undefined): Record<string, JSONValue> =>
    isPlainAuthorityRecord(value) ? value : {};
  const stepIds = new Set(approvals.map(([id]) => id));
  const existingOverrides = recordOf(metadata['pendingApprovalOverrides']);
  const abandoned = new Set(
    committed === undefined
      ? []
      : Object.keys(existingOverrides).filter(
          (id) => id.startsWith(prefix) && !committed.has(id) && !stepIds.has(id),
        ),
  );
  if (approvals.length === 0 && abandoned.size === 0) return {};
  const without = (record: Record<string, JSONValue>): Record<string, JSONValue> =>
    Object.fromEntries(Object.entries(record).filter(([id]) => !abandoned.has(id)));
  const overrides = { ...without(existingOverrides), ...Object.fromEntries(approvals) };
  const rounds = recordOf(metadata['pendingApprovalRounds']);
  const authorities = recordOf(metadata['lastRequestAuthorities']);
  const authority = JSON.parse(
    JSON.stringify({
      ...requestContext.authority,
      ...(requestContext.audience === undefined ? {} : { audience: requestContext.audience }),
      ...(requestContext.agentId === undefined ? {} : { agentId: requestContext.agentId }),
      [SCHEDULED_FIRE_AUTHORITY_MARKER]: true,
    }),
  ) as JSONValue;
  const { [runId]: _ended, ...otherAuthorities } = authorities;
  const holdsApproval = Object.keys(overrides).some((id) => id.startsWith(prefix));
  return {
    pendingApprovalOverrides: overrides,
    pendingApprovalRounds: {
      ...without(rounds),
      ...Object.fromEntries(approvals.map(([id]) => [id, ownEntry(rounds, id) ?? 0])),
    },
    lastRequestAuthorities: holdsApproval
      ? { ...authorities, [runId]: authority }
      : otherAuthorities,
  };
}

export async function createRuntimeComposition(
  options: RuntimeCompositionOptions,
  suppliedDependencies: Partial<RuntimeCompositionDependencies> = {},
): Promise<RuntimeComposition> {
  // COR-1509: the durable engine starts reclaiming and resuming runs with a lapsed claim as soon
  // as it exists, on its own interval and independent of `recover`, which is before this
  // composition finishes. `resolveRunServices` therefore waits on this gate rather than answering
  // "not ready": a run that reaches the resolver early must be held, not durably failed.
  const readiness = Promise.withResolvers<void>();
  // A failed composition rejects the gate; the resolver handles that, and nothing else needs to.
  readiness.promise.catch(() => {});
  try {
    return await buildRuntimeComposition(options, suppliedDependencies, readiness);
  } catch (error) {
    readiness.reject(error);
    throw error;
  }
}

async function buildRuntimeComposition(
  options: RuntimeCompositionOptions,
  suppliedDependencies: Partial<RuntimeCompositionDependencies>,
  readiness: PromiseWithResolvers<void>,
): Promise<RuntimeComposition> {
  const dependencies: RuntimeCompositionDependencies = {
    ...defaultRuntimeCompositionDependencies,
    ...suppliedDependencies,
  };
  const maximumSteps = options.maximumSteps ?? DEFAULT_MAXIMUM_STEPS;
  const systemPrompt = options.systemPrompt;
  const diagnose = resolveDiagnosticSink(options.onDiagnostic);
  // AB-260: `createBureau` resolves and forwards its own single
  // `RuntimeServices` instance through `options.runtime` before calling this
  // function, so this resolution just picks that SAME instance back up. A
  // direct caller of this exported function (bypassing `createBureau`
  // entirely — this package's own extensive test suite does exactly that)
  // gets the real-globals default, identical to this composition's behavior
  // before `RuntimeServices` existed.
  const runtimeServices: RuntimeServices = options.runtime ?? createDefaultRuntimeServices();

  // The resolver waits on `readiness` until the whole composition is assembled. In automatic mode
  // `createRunEngine` starts its scheduler and claim-reclaim interval before later consts
  // (`sessionStore`, the `createRunRuntime` closure deps) are initialized, so a persisted schedule
  // or a lapsed claim can reach `resolveRunServices` mid-build and would hit a not-yet-initialized
  // binding. Manual mode has no background poller, but shares the same gate for consistency.
  // Only so the resolver can say, once, that it had to wait; the gate itself is `readiness`.
  let compositionOpen = false;
  let requestAuthorityValidator = createRunAuthorityValidator(
    options.workspace,
    options.requestAuthorityValidator,
  );
  // AB-240: wired by `createBureau` once its agent catalog exists (this
  // function's own contract deliberately excludes `agents` — see
  // `RuntimeCompositionOptions`'s doc comment) — `undefined` until then, and
  // for any direct `createRuntimeComposition` caller that never wires one.
  let catalogAgentRunOptionsResolver: CatalogAgentRunOptionsResolver | undefined;
  // COR-1586: with `awaitsCatalogAgentRunOptionsResolver`, a reader of the resolver that finds it
  // unset waits on this gate. It opens when the resolver is wired or abandoned, and stays open.
  const catalogResolverGate = Promise.withResolvers<void>();
  let catalogResolverGateOpen = false;
  let catalogResolverAbandonedReason: string | undefined;
  const openCatalogResolverGate = (): void => {
    catalogResolverGateOpen = true;
    catalogResolverGate.resolve();
  };

  // AB-10: run ids the durable engine flags as version-mismatched during boot
  // recovery — see RuntimeComposition.workflowVersionMismatches.
  const workflowVersionMismatches = new Map<
    string,
    { storedVersion: string; registeredVersion: string }
  >();

  // COR-1916: see RuntimeComposition.unrebuildableRecoveredRuns.
  const unrebuildableRecoveredRuns = new Set<string>();

  // AB-223: runId → scheduleId for a scheduled fire whose deps this composition
  // has built (live tick or recovered), so the `workflow:completed`/
  // `workflow:failed` engine listener wired below `createRunEngine` can
  // correlate a terminal event back to its owning schedule. Populated in
  // `buildScheduledRunServices`; each entry is deleted the instant its
  // terminal event dispatches, so it never grows past the count of in-flight
  // scheduled fires.
  const scheduledFireScheduleIds = new Map<string, string>();

  /**
   * COR-1482: tells the host which session incarnation a fire runs in. Binding a task to it is a
   * record about the fire, so a host that cannot write it is diagnosed and the fire still runs.
   */
  async function reportScheduledSession(notice: ScheduledSessionNotice): Promise<void> {
    try {
      await dependencies.onScheduledSessionKnown?.(notice);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'task-registry',
        message: `[bureau] Could not bind the task of schedule fire "${notice.runId}" to its session: ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
  }

  /**
   * COR-1596: hands the host a fire's services so it can register the fire's reviews. Registering
   * them is a record about the fire, so a host that cannot is diagnosed and the fire still runs.
   */
  async function reportScheduledServices(
    notice: ScheduledFireServicesNotice,
    services: DurableRunDeps,
  ): Promise<void> {
    try {
      await dependencies.onScheduledFireServices?.(notice, services);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'task-registry',
        message: `[bureau] Could not register the reviews of schedule fire "${notice.runId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
  }

  // Declared before any await in composition: a schedule fire can settle while it is running.
  const pendingScheduledTaints = new Map<string, PersistedSessionTaint>();
  const pendingTaintKey = (sessionId: string, runId: string): string =>
    `${sessionId}\u0000${runId}`;

  /**
   * COR-1482: tells the host a schedule fire's run has ended. The settlement is a record about a
   * run that already ended, so a host that cannot write it is diagnosed, never thrown into the
   * engine's event dispatch.
   */
  function settleScheduledFire(settlement: ScheduledFireSettlement): void {
    // COR-2381 — a fire whose first step tripped never ran its write-back hook, which is what
    // deletes a held taint; every exit path of a fire settles here.
    for (const key of pendingScheduledTaints.keys()) {
      if (key.endsWith(`\u0000${settlement.runId}`)) pendingScheduledTaints.delete(key);
    }
    const hook = dependencies.onScheduledFireSettled;
    if (hook === undefined) return;
    void (async () => hook(settlement))().catch((error: unknown) => {
      diagnose({
        level: 'error',
        scope: 'task-registry',
        message: `[bureau] Could not settle the task of schedule fire "${settlement.runId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    });
  }

  // AB-241 review finding: runId → the decoded `CatalogRunRecoveryRecord`
  // `resolveRunServices`'s catalog branch already successfully read during
  // boot recovery, cached here so BOTH `classifyCatalogRecoveredRun` (called
  // from the awaited `onRecoveredWorkflow` hook, during `recoverAll()`) and
  // `isCatalogRecoveredRun` (called again, LATER, from
  // `recoverDurableRuns`'s own post-recovery loop over `recoverAll()`'s
  // returned handles) can reuse that SAME decode instead of each issuing
  // its own independent storage read — a transient failure on either read
  // could disagree with the first, either losing an already-attributed
  // run's attribution or, worse, misclassifying an already-resolved
  // catalog run as an orphan and cancelling it. Entries are intentionally
  // NOT evicted per-read (a second fresh review finding after an earlier,
  // wrong per-entry-eviction attempt starved the later of these two
  // consumers) — the whole cache is cleared in one call, once, at the end
  // of the boot recovery pass (`clearCatalogRunRecoveryCache`, called from
  // `recoverDurableRuns` in create-bureau.ts), so it never persists past
  // that one pass — unlike `runAttribution`, this is not live-dispatch
  // state.
  const catalogRunRecoveryCache = new Map<string, CatalogRunRecoveryRecord>();
  const scheduleFireEvents = new TypedEventTarget<ScheduleFireEventMap>();
  const skillEvents = new TypedEventTarget<SkillEventMap>();

  // The caller's storage adapter. Bureau never disposes it: the caller constructed it and closes
  // it after the Bureau has shut down. Everything here uses it through a fence, which the Bureau
  // closes when it shuts down or fails to start, so no work left over from it writes afterwards.
  const effectiveStorage = options.storage;
  const storageFence = effectiveStorage === undefined ? undefined : fenceStorage(effectiveStorage);

  let kv: ConditionalTextValueStore | undefined;
  // Keep the raw Storage so the durable engine can share the exact backend with
  // the text-value KV view (Weft requires one engine per durable store).
  const durableStorage: Storage | undefined = storageFence?.storage;
  if (durableStorage) {
    kv = textValueStore(durableStorage, { disposeUnderlyingStorage: false });
  }

  const effectiveObservability = options.observability;
  const effectiveOnLog = options.onLog;
  // COR-1811: persisted `ctx.log` lines. The store shares the engine's own storage, because the
  // engine reads, flushes, and purges through it; it exists only for a durable composition.
  const logStore =
    suppliedDependencies.workflowLogs === undefined || durableStorage === undefined
      ? undefined
      : createWorkflowLogStore(durableStorage, {
          maximumLinesPerRun: () => suppliedDependencies.workflowLogs?.maximumLinesPerRun(),
          // The retention window is measured on the Bureau's clock, as every other one is.
          getNow: () => runtimeServices.clock.now(),
          onError: (error) => suppliedDependencies.workflowLogs?.onError(error),
        });

  // Durable execution is ON BY DEFAULT whenever a PERSISTENT storage backend is
  // configured. The default follows persistence because that is the only place resume is real:
  // `memory` storage loses its checkpoints with the process, so default-on there
  // would be pure overhead with zero recovery. The explicit `durable`
  // flag overrides the default either way.
  let effectiveStorageIsPersistent = false;
  if (effectiveStorage) {
    const persistence = effectiveStorage.capabilities().persistence;
    effectiveStorageIsPersistent = persistence === 'local' || persistence === 'remote';
  }
  const wantsDurable = options.durable ?? effectiveStorageIsPersistent;

  let durable: DurableComposition | undefined;
  if (wantsDurable && durableStorage) {
    // Build the checkpoint store over the SAME backend the engine persists to.
    const checkpointStore = createCheckpointStore(
      textValueStore(durableStorage, { disposeUnderlyingStorage: false }),
    );
    const runWorkflow = createRunWorkflow(checkpointStore, { version: options.workflowVersion });
    // recover: false is REQUIRED. Weft's `Engine.create` default is recover:true,
    // which runs recoverAll() *during construction* — but the bureau needs the
    // recovered handles itself (to attach the `settleRecoveredRun` monitors that
    // persist each resumed run's terminal session status), and a handle started
    // inside Engine.create is not surfaced to the caller. So the bureau owns
    // recovery: it calls engine.recoverAll() at boot and keeps the handles. The
    // per-run deps a recovered run needs are re-provided lazily by
    // `resolveRunServices` (passed as resolveWorkflowServices), which Weft fires
    // per recovered run before its generator advances — no pre-injection, no
    // module-global registry.
    //
    // In the default automatic profile, `startScheduler: true` is REQUIRED too:
    // recover:false decouples *who drives recovery* from *whether timers fire*,
    // and the poller otherwise follows recover. In manual mode the serverless
    // host drives timers through `Bureau.maintain()`, so Weft
    // requires the in-process scheduler to remain stopped.
    const createdEngine = await createRunEngine({
      storage: durableStorage,
      runWorkflow,
      checkpointStore,
      recover: false,
      // COR-2009: the engine reads the Bureau's clock, so what it stores (events, checkpoints,
      // schedule fires and misses, indexes) is stamped on the same clock as the Bureau's own records.
      getNow: () => runtimeServices.clock.now(),
      backgroundTasks: options.maintenance ?? 'automatic',
      // COR-1527: with workflow files the scheduler waits until their documents are registered,
      // so a schedule that is due the moment the engine exists cannot fire a type Weft does not
      // have yet. `createBureau` starts it, before the engine recovers, once they are.
      startScheduler: options.maintenance !== 'manual' && options.workflowSource === undefined,
      resolveWorkflowServices: resolveRunServices,
      ...(dependencies.onRecoveredWorkflow === undefined
        ? {}
        : { onRecoveredWorkflow: dependencies.onRecoveredWorkflow }),
      ...(dependencies.goalWorkflow === undefined
        ? {}
        : { goalWorkflow: dependencies.goalWorkflow }),
      ...(effectiveObservability !== undefined ? { observability: effectiveObservability } : {}),
      ...(options.alerts === undefined ? {} : { alerts: options.alerts }),
      ...(options.storageSizeReportIntervalMs === undefined
        ? {}
        : { storageSizeReportIntervalMs: options.storageSizeReportIntervalMs }),
      ...(logStore === undefined
        ? effectiveOnLog
          ? { onLog: effectiveOnLog }
          : {}
        : {
            // The store keeps the lines; the host's own sink, or the console without one, still
            // receives each, as it did before lines were kept.
            onLog: (record: WorkflowLogRecord) => {
              logStore.sink(record);
              if (effectiveOnLog) effectiveOnLog(record);
              else console[record.level](record);
            },
            workflowLogs: logStore,
          }),
      // durableGuardrails is a Pick of these exact CreateRunEngineOptions fields, so
      // it spreads straight through; createRunEngine guards each one internally, so
      // passing `undefined` members is harmless.
      ...options.durableGuardrails,
      // The one guardrail Bureau defaults itself: Weft caps nothing unless asked.
      maxConcurrentRuns:
        options.durableGuardrails?.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS,
      // durableOwnership (AB-178) is the same Pick pattern — createRunEngine
      // defaults `ownership` to 'workflow-lease' when this is omitted entirely.
      ...options.durableOwnership,
      runWorkflowVersion: options.workflowVersion,
      // AB-10: record the mismatch so the boot recovery loop below can pass it
      // to `classifyRecoveredRun` (distinct 'reattach-version-mismatch' verdict)
      // before it inspects `workflowVersionMismatches`.
      onWorkflowVersionMismatch: (event: WorkflowVersionMismatchEvent) => {
        workflowVersionMismatches.set(event.runId, {
          storedVersion: event.storedVersion,
          registeredVersion: event.registeredVersion,
        });
        diagnose({
          level: 'warn',
          scope: 'recovery',
          message:
            `[bureau] Recovered run "${event.runId}" was checkpointed under workflow version ` +
            `"${event.storedVersion}" but is resuming under "${event.registeredVersion}". ` +
            `Recovery proceeds against the currently-deployed code (pin-and-warn) — see ` +
            `documentation/workflow-versioning.md.`,
        });
      },
    });
    // The poller started inside `Engine.create`, so listen for a missed fire now, with nothing
    // awaited in between, and let `createBureau` take what was held once it can forward it.
    durable = {
      ...createdEngine,
      missedFires: bufferMissedFires(createdEngine.engine),
      workflowLogs: logStore,
    };

    // AB-223: schedule-fire terminal events. `workflow:completed`/
    // `workflow:failed` fire on the engine for EVERY workflow (scheduled or
    // not) — a live tick and a recovered fire both settle through this same
    // pair, so listening here (rather than duplicating from
    // `monitorRecoveredScheduledFire`'s recovery-only await) gives exactly one
    // dispatch per fire regardless of how it settled. A run with no entry in
    // `scheduledFireScheduleIds` (every ordinary, non-scheduled run) is
    // silently ignored — `return` before either handler does anything else.
    durable.engine.addEventListener(WorkflowCompletedEvent.type, (event) => {
      const scheduleId = scheduledFireScheduleIds.get(event.workflowId);
      if (scheduleId === undefined) return;
      scheduledFireScheduleIds.delete(event.workflowId);
      const result = event.result;
      const finishReason =
        typeof result === 'object' && result !== null && 'finishReason' in result
          ? result.finishReason
          : undefined;
      // Two branches, each dispatching its own concrete event type, rather
      // than one `dispatch(cond ? new A() : new B())` call: TypedEventTarget's
      // `dispatch<K>` infers `K` from its argument's `type` literal, and a
      // ternary's union argument defeats that inference (the argument's
      // static `type` widens to `string`) — using the typed `dispatch` wrapper
      // (not the untyped inherited `dispatchEvent`) needs single-type call
      // sites.
      const failed = isFailureFinishReason(finishReason);
      const content =
        typeof result === 'object' && result !== null && 'content' in result
          ? result.content
          : undefined;
      settleScheduledFire({
        runId: event.workflowId,
        status: failed ? 'failed' : finishReason === 'aborted' ? 'canceled' : 'completed',
        finishReason: typeof finishReason === 'string' ? finishReason : undefined,
        error: undefined,
        content: typeof content === 'string' ? content : undefined,
      });
      if (failed) {
        scheduleFireEvents.dispatch(new ScheduleFailedEvent(scheduleId, event.workflowId));
      } else {
        scheduleFireEvents.dispatch(new ScheduleCompletedEvent(scheduleId, event.workflowId));
      }
    });
    durable.engine.addEventListener(WorkflowFailedEvent.type, (event) => {
      const scheduleId = scheduledFireScheduleIds.get(event.workflowId);
      if (scheduleId === undefined) return;
      scheduledFireScheduleIds.delete(event.workflowId);
      settleScheduledFire({
        runId: event.workflowId,
        status: 'failed',
        finishReason: undefined,
        error: event.error instanceof Error ? event.error.message : String(event.error),
        content: undefined,
      });
      scheduleFireEvents.dispatch(new ScheduleFailedEvent(scheduleId, event.workflowId));
    });
    // COR-1482: a fire that timed out is a fire that failed, and its task says so. Without this
    // its task reads `working` until the next boot, and its attribution is never released.
    durable.engine.addEventListener(WorkflowTimedOutEvent.type, (event) => {
      const scheduleId = scheduledFireScheduleIds.get(event.workflowId);
      if (scheduleId === undefined) return;
      scheduledFireScheduleIds.delete(event.workflowId);
      settleScheduledFire({
        runId: event.workflowId,
        status: 'failed',
        finishReason: 'timed-out',
        error: `The fire timed out (${event.timeoutType})`,
        content: undefined,
      });
      scheduleFireEvents.dispatch(new ScheduleFailedEvent(scheduleId, event.workflowId));
    });
    // Not a fire-terminal dispatch (cancellation is out of this issue's scope),
    // but the correlation entry must still be dropped on a cancelled fire, or
    // it leaks for the lifetime of the engine.
    durable.engine.addEventListener(WorkflowCancelledEvent.type, (event) => {
      if (scheduledFireScheduleIds.delete(event.workflowId)) {
        settleScheduledFire({
          runId: event.workflowId,
          status: 'canceled',
          finishReason: 'aborted',
          error: undefined,
          content: undefined,
        });
      }
    });

    // COR-660: the tick observation point Weft's COR-105 exposes. Unlike the
    // terminal pair above, these arrive already keyed by scheduleId, so there
    // is no `scheduledFireScheduleIds` correlation to do and nothing to
    // filter: every schedule on this engine is one the bureau created
    // (`createSchedule`, `createAgentScheduler`, or a durable heartbeat), the
    // engine being bureau-owned. A tick that collides emits `attempted` then
    // `skipped`; a tick that launches emits `attempted` and later one of the
    // terminal pair.
    durable.engine.addEventListener('schedule:attempted', (event) => {
      scheduleFireEvents.dispatch(new ScheduleAttemptedEvent(event.scheduleId, event.occurrence));
    });
    durable.engine.addEventListener('schedule:skipped', (event) => {
      scheduleFireEvents.dispatch(
        new ScheduleSkippedEvent(
          event.scheduleId,
          event.policy,
          event.occurrence,
          // A scheduled fire's Weft workflow id IS its AgentRun id — the same
          // identity `ScheduleFailedEvent`/`ScheduleCompletedEvent` carry as
          // `runId` from `event.workflowId`.
          event.blockingWorkflowId,
        ),
      );
    });
  }

  // COR-1879: plugin composition calls a `memory` factory before construction reaches here.
  if (typeof options.memory === 'function') {
    throw new TypeError('A memory factory reached composition without being called.');
  }
  const memory: GovernedMemory | undefined = options.memory;
  await memory?.init();
  // COR-1546 — the tenant a run's memory is partitioned under. `createBureau` passes its resolved
  // identifier, so `bureau.memory.*`, which builds its authority from `Bureau.id`, reads what the
  // runs wrote. A composition built on its own with no identifier gets one of its own.
  let generatedMemoryTenantId: string | undefined;
  const memoryTenantId = (): string =>
    options.id ?? (generatedMemoryTenantId ??= runtimeServices.identifiers.next('bureau'));

  // A run's skills come from a catalog revision, and only from one. COR-892 removed Bureau's
  // second path — a provider it read skills out of directly — because a skill admitted that way
  // had no trust decision, no artifact digest and no compatibility verdict, so a run holding one
  // could not say where it came from.
  //
  // A caller that has already discovered a revision hands it in, which is the host's job under
  // COR-752's Decision 1: discovery reads approved filesystem roots and remote URLs, and deciding
  // which of those to trust is not Bureau's call to make. A caller that has only configured
  // persistence gets the skills its own store holds, discovered here through the `storage` source.
  // That is the one source Bureau can compose without deciding anything on the host's behalf: the
  // store is already the bureau's, and what is in it is what this runtime itself put there.
  const skillCatalog: SkillCatalogRevision | undefined =
    options.skills === undefined
      ? undefined
      : (options.skills.catalog ??
        (kv === undefined
          ? undefined
          : await discoverSkills({
              sources: [
                {
                  id: 'storage',
                  kind: 'storage',
                  // Not a filesystem path and deliberately not credential-bearing: a catalog entry
                  // exposes this verbatim.
                  location: 'kv://skills',
                  precedence: DEFAULT_SOURCE_PRECEDENCE.storage,
                },
              ],
              storage: kv,
            })));
  /** Whether this Bureau has a skill client: the skills it was given, and a catalog to admit them. */
  const skillsConfigured = options.skills !== undefined && skillCatalog !== undefined;

  // AB-384 (Codex P2 review finding, PR #592, "Mint incarnations from the
  // Bureau's injected runtime"): `runtimeServices` (resolved above from
  // `options.runtime`, defaulting to the real globals) must be threaded
  // through here — omitting it would let `createSessionStore` silently
  // construct its OWN second default `RuntimeServices`, so every
  // `AgentSession.incarnation` it mints would come from real
  // `crypto.randomUUID()`/wall-clock time instead of the same injected
  // runtime every other subsystem this composition builds already uses,
  // breaking determinism for manual-runtime tests and fault-replay runs.
  const sessionStore = kv
    ? (dependencies.createSessionStore ?? createSessionStore)(kv, {
        runtime: runtimeServices,
        beforeCleanup: dependencies.beforeSessionCleanup,
      })
    : undefined;
  // COR-1920: secret answers need somewhere durable to keep their ciphertext and a key to seal it
  // with. The toolbox the Bureau builds itself reads them back for the run that asked; an author's
  // toolbox keeps its own options, and takes `createSecretAnswerResolver` to do the same.
  const secretAnswers =
    kv !== undefined && options.answerEncryption !== undefined
      ? createSecretAnswerStore({
          kv,
          keys: options.answerEncryption,
          now: () => runtimeServices.clock.now(),
        })
      : undefined;
  /**
   * COR-2105 — the seed and the write-back of one run of `sessionId`: the taint the session holds
   * in `metadata`, and an `onTainted` that stores a new one and publishes `session.tainted` once.
   */
  function sessionTaintSeamFor(
    sessionId: string,
    runId: string,
    metadata: Readonly<Record<string, JSONValue>> | undefined,
  ): SessionTaintSeam {
    return createSessionTaintSeam(
      {
        store: sessionStore,
        now: () => runtimeServices.clock.now(),
        publish: dependencies.onSessionTainted,
        // A scheduled fire's first step runs before its session exists: hold the taint for the
        // write-back hook that creates the session.
        holdForAbsentSession: (heldSessionId, heldRunId, value) => {
          const key = pendingTaintKey(heldSessionId, heldRunId);
          if (!pendingScheduledTaints.has(key)) pendingScheduledTaints.set(key, value);
        },
        diagnose: (cause) =>
          diagnose({
            level: 'warn',
            scope: 'guardrails',
            message: `[bureau] The taint of session "${sessionId}" could not be stored: ${serializeUnknownError(cause)}`,
            cause,
          }),
      },
      { sessionId, runId, metadata },
    );
  }
  const baseToolbox: BureauToolbox =
    options.toolbox ??
    createToolbox([], {
      context: {},
      ...(secretAnswers === undefined ? {} : { secretResolver: secretResolverOf(secretAnswers) }),
    });
  const hasSkillTools = options.skills !== undefined && options.skills.includeTools !== false;
  const fallbackToolbox: BureauToolbox =
    options.toolbox !== undefined || hasSkillTools ? baseToolbox : createUnavailableToolbox();

  const configuredGenerate: GenerateFunction | undefined =
    options.generate === undefined ? undefined : applyCache(options.generate, options.cache, kv);

  /** {@link RuntimeComposition.holdToModelPolicy}. */
  function holdToModelPolicy<Options extends Pick<RunOptions, 'generate'>>(
    resolved: Options,
    generationMode: GenerationMode,
  ): Options {
    const generate = holdGenerateOfAgent(resolved.generate, generationMode);
    return generate === resolved.generate ? resolved : { ...resolved, generate };
  }

  /** A catalog agent's `generate`, held to the model policy when this composition reads one. */
  function holdGenerateOfAgent(
    generate: GenerateFunction,
    generationMode: GenerationMode,
  ): GenerateFunction {
    const policy = dependencies.modelPolicy;
    return policy === undefined
      ? generate
      : holdGenerateToModelPolicy(generate, policy, generationMode);
  }

  /** {@link RuntimeComposition.withChatPermission}. */
  function governedByChat(toolbox: BureauToolbox, runId: string): BureauToolbox {
    const read = dependencies.permissionModeOfRun;
    return read === undefined
      ? toolbox
      : withChatPermission(
          toolbox,
          () => read(runId),
          // A chat whose mode cannot be read holds its runs to `read-only`: say so, once per call.
          (error) =>
            diagnose({
              level: 'error',
              scope: 'permission-mode',
              message: `[bureau] The permission mode of the chat of run "${runId}" could not be read, so its tool calls are held to read-only: ${serializeUnknownError(error)}`,
              cause: error,
            }),
        );
  }

  /**
   * The guardrail configuration in force for this composition, with `false`
   * narrowed away so a caller sees a real configuration or nothing.
   *
   * AB-40 — `undefined` (not configured) wires the enabled-by-default preset;
   * `false` opts out entirely; anything else replaces the preset. A pure
   * function of `options`, hoisted to composition scope because
   * {@link createBureauInvariantHooks} needs the same answer for a run that
   * never goes through `createRunRuntime` at all.
   */
  function resolveGuardrailsConfiguration(): GuardrailsOptions | undefined {
    const resolved =
      options.guardrails === undefined ? createDefaultGuardrailsPreset() : options.guardrails;
    return resolved === false ? undefined : resolved;
  }

  /** {@link RuntimeComposition.mediaOptionsFor}. */
  function mediaOptionsFor(
    principalId: string | undefined,
    rowHolder: MediaRowHolder,
  ): MediaRunOptions {
    const resolver = dependencies.contentSourceResolverFor?.(principalId);
    const admitter = dependencies.generatedMediaAdmitterFor?.(principalId, rowHolder);
    const assetSafety = resolveGuardrailsConfiguration()?.input?.assetSafety;
    return {
      ...(resolver === undefined ? {} : { contentSourceResolver: resolver }),
      ...(admitter === undefined ? {} : { generatedMediaAdmitter: admitter }),
      ...(assetSafety === undefined ? {} : { assetSafety }),
    };
  }

  /**
   * The Bureau invariants that do not close over a run (COR-1265 criterion 3b,
   * owner ruling 2026-09-20).
   *
   * A catalog-dispatched run resolves its provider, toolbox, memory and skills
   * through the catalog agent's OWN `OPERATIVE_RESOLVE_RUN_OPTIONS`, never
   * through `createRunRuntime` — that separation is AB-240's point and its
   * rollback trigger. Bureau's hooks were absent from those runs entirely, which
   * was survivable only while no tier reached them at all; once the agent tier
   * became real, a catalog run would carry its agent's hooks and none of
   * Bureau's policy, which contradicts COR-567's non-bypassable invariants.
   *
   * The whole Bureau tier cannot travel there. `bureau:memory-recall`,
   * `bureau:memory-persist`, the skill hooks and `bureau:skill-record-snapshot`
   * close over this run's session, memory and skill session, and a catalog run
   * has none of them. The three that close over composition-level configuration
   * only — the identity prompt and both guardrails — do, and they are exactly
   * the registrations COR-567's "non-bypassable Bureau invariant hooks" section
   * names.
   *
   * A fresh registry, and a fresh `createGuardrails`, per call: the guardrail
   * carries per-run taint state, so sharing one across catalog runs would leak
   * one run's detections into another.
   *
   * Every catalog path carries these, and so does a child a Bureau-owned run dispatches
   * (`bureauChildInvariants`): an agent exposing no `OPERATIVE_RESOLVE_RUN_OPTIONS` has no
   * `RunOptions` for anyone to augment, so it is refused rather than run without them (COR-2106).
   * See `documentation/hierarchical-hook-composition.md`.
   */
  function createBureauInvariantHooks(
    goalAttempt?: GoalAttemptTarget,
    invariantOptions?: BureauInvariantOptions,
  ): HookRegistry<OperativeHookMap> {
    const invariants = new HookRegistry<OperativeHookMap>({ source: BUREAU_HOOK_TIER });
    // First, so no other `prepareStep` handler (the guardrail scan included)
    // runs for a step the goal no longer allows. This is the one invariant that
    // closes over a run, and only a goal attempt's run is given it.
    if (goalAttempt !== undefined && dependencies.goalAttemptFence !== undefined) {
      registerGoalAttemptFence(invariants, dependencies.goalAttemptFence, goalAttempt, {
        runtime: runtimeServices,
      });
    }
    if (options.identity) {
      registerIdentityInvariant(invariants, options.identity);
    }
    // COR-1367 — an agent that resolves its own guardrails was handed this
    // bureau's policy through `inheritedGuardrails` (see
    // `catalogRunGuardrailsContext`) and applies it in its own tier, so
    // registering it here as well would run the same policy twice.
    const guardrailsConfig =
      invariantOptions?.agentResolvesGuardrails === true
        ? undefined
        : resolveGuardrailsConfiguration();
    if (guardrailsConfig) {
      const seam = invariantOptions?.sessionTaint;
      registerGuardrailInvariants(
        invariants,
        createGuardrails(withSessionTaint(guardrailsConfig, seam, seam?.runId)),
      );
    }
    return invariants;
  }

  /**
   * COR-2106 — what a Bureau-owned run hands the children it dispatches
   * (`bureauInvariantsField`): Bureau's identity and guardrail tier, and (COR-2127) the plugin tier,
   * fresh registries per child. The single seam through which both reach a child.
   */
  const bureauChildInvariants: BureauChildInvariants = (request) => ({
    bureau: createBureauInvariantHooks(undefined, request),
    plugin: pluginHookTier(options.agentContributions, request.agentTier),
  });

  /** {@link RuntimeComposition.composeRunHooks}. */
  const composeHooks = (tiers: RunHookTiers): HookRegistry<OperativeHookMap> =>
    composeRunHooks(options.agentContributions, tiers);

  function createRunRuntime(
    request: RunRuntimeRequest,
    runtimeOptions?: {
      /**
       * Active-skill entries to seed the run's {@link SkillSession} with on
       * construction. Used by the durable recovery path: when
       * `buildRunDepsFromSession` rebuilds deps for a recovered run, it reads the
       * `activeSkillRecords` snapshot from session metadata and passes it here so the
       * recovered toolbox is aware of skills activated in completed pre-crash steps
       * (those steps are memoized and do not re-run their `activate_skill` calls).
       */

      /**
       * Provenance-carrying records for the catalog-backed path.
       *
       * Recovery
       * re-validates these against the live catalog and re-checks each digest, so a skill whose
       * source was revoked or whose content drifted does not come back.
       */
      initialActiveSkillRecords?: ReadonlyArray<SkillActivationRecord> | undefined;

      /**
       * COR-1577 — the named catalog agent this session run executes. Its `generate` and toolbox
       * replace the Bureau-wide ones; everything else the Bureau composes around a run still
       * applies.
       */
      sessionAgent?: SessionAgentRun | undefined;

      /**
       * COR-1546 — the run's owner of record, which its memory is partitioned under: the session's
       * owner for a chat run, the schedule's for a fire, `anonymous:local` for a run no principal started
       * (the owner of anything created with none stated). A caller that omits it
       * gets the request authority's `ownerId`; `createBureau` always states it.
       */
      memoryOwner?: string | undefined;
      /**
       * COR-2105 — the metadata of the session the run belongs to. The run's Bureau guardrails
       * start tainted when it holds `guardrailTaint`, and write a taint they raise back to the
       * session. Absent, the run starts untainted and still writes back.
       */
      sessionMetadata?: Readonly<Record<string, JSONValue>> | undefined;
      skillPolicyUnverifiable?: boolean | undefined;
      /**
       * COR-1911 — the run neither recalls memory nor remembers its answers: no memory hook is
       * registered. A run of an agent that is being tried is one; it is a throwaway, and leaves
       * nothing in the memory its owner keeps.
       */
      withoutMemory?: boolean | undefined;
      admitDispatch?: (() => Promise<boolean>) | undefined;
    },
  ) {
    const sessionAgent = runtimeOptions?.sessionAgent;
    const requestContext = request.requestContext;
    // COR-1996: a catalog agent's generate is held to the model policy; the Bureau-wide one is the
    // deployment's own and no agent's choice.
    const underlyingGenerate =
      sessionAgent !== undefined
        ? holdGenerateOfAgent(sessionAgent.options.generate, sessionAgent.generationMode)
        : configuredGenerate;

    if (!underlyingGenerate) {
      throw new Error('No generate function configured');
    }
    const validateDispatch = async (candidate: ToolRequestContext): Promise<boolean> => {
      if (runtimeOptions?.admitDispatch !== undefined && !(await runtimeOptions.admitDispatch()))
        return false;
      return (
        requestAuthorityValidator === undefined || (await requestAuthorityValidator(candidate))
      );
    };
    const generate: GenerateFunction = withBackendDescriptors(async (context) => {
      const revision = requestContext?.authority.authorizationRevision;
      const required =
        options.workspace !== undefined ||
        (revision !== undefined && revision !== 'bureau:1' && revision !== 'bureau:scheduler:1');
      if (
        required &&
        (!requestContext || !requestAuthorityValidator || !(await validateDispatch(requestContext)))
      ) {
        throw new Error('Request authority is no longer current.');
      }
      return underlyingGenerate(context);
    }, readBackendDescriptors(underlyingGenerate));

    // Clone the toolbox for this run so concurrent runs do not share a single
    // CompletableEventTarget emitter. A shared emitter would route every tool.*
    // event (execute-start, settled, …) to ALL runs that have subscribed, causing
    // cross-run event pollution and shared budget/loop-detector state.
    // `extend()` (no args) creates a fresh toolbox with a new emitter while
    // preserving all tool configurations, context, and policy from the original.
    // The unavailable-toolbox sentinel (no user toolbox, no skill tools) is
    // structurally distinct (custom throwing execute) and must be freshly
    // instantiated per-call via createUnavailableToolbox() instead.
    //
    // The skills path below adds the skill tools with withAddedTools, which
    // keeps this clone's own wrappers — so the result is still based on a
    // per-run clone, which is correct.
    //
    // COR-1577 — a named agent's resolved toolbox is its own: `createAgent` builds a fresh one
    // per resolution unless the agent was handed a shared toolbox, which `extend()` clones for
    // the same cross-run isolation the Bureau-wide toolbox gets.
    let toolbox: AnyToolbox =
      sessionAgent !== undefined
        ? sessionAgent.options.toolbox.extend()
        : options.toolbox !== undefined
          ? baseToolbox.extend()
          : hasSkillTools
            ? fallbackToolbox.extend()
            : createUnavailableToolbox();
    // COR-567 — one registry per run. Per-run rather than per-composition
    // because these hooks close over this run's session, memory and skill
    // session; a registry shared across runs would leak one run's state into
    // another exactly the way the per-run toolbox clone above exists to
    // prevent.
    //
    // Registration order is the order the legacy arrays ran in, and every id
    // below is explicit: a generated `<hookName>#<n>` would renumber whenever
    // an earlier conditional block stops registering, so an observer
    // correlating across runs would see the same hook under different names
    // depending on whether memory or skills happened to be configured.
    // COR-1265 — `source` names the owning tier once, and `on()` stamps it onto
    // every entry. On the entry rather than only here because a merged plan has
    // one registry and many tiers: afterwards this object can no longer say
    // where an entry came from, but the entry still can.
    const hooks = new HookRegistry<OperativeHookMap>({ source: BUREAU_HOOK_TIER });
    let getActiveSkillRecords = (): readonly SkillActivationRecord[] => [];
    let getActiveSkillToolPolicy: (() => ToolPolicy | undefined) | undefined;
    // COR-1620: set when the policy that governs the run cannot be verified, from the start or
    // once a stored skill is refused on recovery. The run then offers no tool and writes no
    // skill snapshot, so what it persisted before is kept, and an approval it raises is refused
    // at approve.
    let skillPolicyUnverified = runtimeOptions?.skillPolicyUnverifiable === true;

    if (options.identity) {
      registerIdentityInvariant(hooks, options.identity);
    }

    // COR-41 — memory hooks run only under a persisted request authority. A
    // recovered run whose authority could not be restored gets none: no
    // conversation can reach memory outside the authority it was granted.
    const memoryAuthority =
      memory && requestContext && runtimeOptions?.withoutMemory !== true
        ? createRunMemoryAuthority(
            requestContext,
            {
              runId: request.runId ?? request.sessionId,
              tenantId: memoryTenantId(),
              // A caller that states no owner (a composition used directly) is partitioned by the request
              // authority's own owner, so two requests never share one partition.
              ownerId: ownerOrLocal(
                runtimeOptions?.memoryOwner ?? requestContext.authority.ownerId,
              ),
            },
            options.memoryAuthority,
          )
        : undefined;
    // COR-1546 — an agent remembers across every chat its owner has with it, so the collection is
    // the agent's identifier and never the session's.
    const memoryTarget: RunMemoryTarget = {
      collection: request.agentName ?? requestContext?.agentId ?? defaultBureauAgentName,
      sessionId: request.sessionId,
    };
    // COR-1226 — resolved here rather than at the hook-registration site below,
    // because the skill toolbox needs the same detectors and the same session
    // taint tracker, and it is constructed before that point. `createGuardrails`
    // is a pure function of its options, so calling it earlier changes nothing
    // about what it returns.
    const guardrailsConfig = resolveGuardrailsConfiguration();
    // COR-2105 — a run of a session starts from the session's taint and writes a new one back,
    // from this tracker as from the agent's own (`AgentRunContext.sessionTaint`).
    const runIdOfTaint = request.runId ?? request.sessionId;
    const taintSeam = sessionTaintSeamFor(
      request.sessionId,
      runIdOfTaint,
      runtimeOptions?.sessionMetadata,
    );
    const guardrails = guardrailsConfig
      ? createGuardrails(withSessionTaint(guardrailsConfig, taintSeam, runIdOfTaint))
      : undefined;
    // COR-2107 — the tracker a flagged recall taints. It is the Bureau's own tracker, seeded from
    // the session and writing back through the same seam every other tracker of the run uses
    // (COR-2105), so the taint it raises is stored whichever tier resolved the run's guardrails.
    // Taint is a session fact (COR-2385): when the Bureau runs no guardrails, a tracker over the
    // same seam stands in, for every kind of agent and for a run with none, so an opt-out of
    // guardrails never decides whether a flagged recall taints the session.
    const recallTaint =
      guardrails?.taint ??
      createSessionTaintTracker({
        ...(taintSeam.initial === undefined ? {} : { initial: taintSeam.initial }),
        onTainted: taintSeam.onTainted,
        runId: runIdOfTaint,
      });

    if (memory && memoryAuthority) {
      // COR-2107 — a recall a detector flagged at or above the run's taint threshold taints the
      // session, as any other scan path does (COR-2102).
      // The agent's own declared threshold judges its recall first (COR-2385), then the Bureau's.
      const recallTaintThreshold =
        sessionAgent?.agentTaintThreshold ??
        guardrailsConfig?.taint?.taintThreshold ??
        DEFAULT_TAINT_THRESHOLD;
      hooks.on(
        'prepareStep',
        createMemoryRecallHook(memory, memoryAuthority, memoryTarget, (detection, step) => {
          if (detection.confidence < recallTaintThreshold) return;
          recallTaint.taint({
            reason: `Recalled memory flagged by ${detection.detector} (${detection.category})`,
            detector: detection.detector,
            category: detection.category,
            confidence: detection.confidence,
            step,
            provenance: 'recalled-memory',
          });
          // The write that stores the taint completes before the recall hook returns, as
          // the guardrail hooks' own does (COR-2105).
          return recallTaint.settled();
        }),
        {
          id: 'bureau:memory-recall',
          // Recall admission records the read and can quarantine a poisoned
          // record; both are idempotent on a replayed step.
          replay: 'effectful',
        },
      );
      hooks.on(
        'onStep',
        createMemoryPersistHook(memory, memoryAuthority, memoryTarget, request.runId, (receipt) =>
          diagnose({
            level: 'warn',
            scope: 'memory',
            message:
              `[bureau] Governed memory rejected the answer of run "${request.runId ?? request.sessionId}" ` +
              `for agent "${memoryTarget.collection}" (${receipt.reason ?? 'no reason given'}), so it was not remembered.`,
          }),
        ),
        {
          id: 'bureau:memory-persist',
          // Writes to the memory store, so a replayed step writes again. The
          // classification records that at-least-once contract; it does not
          // suppress the second write, which would drop the persistence for a
          // step whose generation genuinely re-ran.
          replay: 'effectful',
        },
      );
    }

    // COR-1226 — skill bodies and skill resources are untrusted instruction
    // input and must pass the same detector pipeline as anything else entering
    // context. `GuardrailHooks.taint`'s own doc comment names skill resources
    // as one of the retrieval surfaces that cannot reach the model through
    // `prepareStep`/`validateResponse` and so must scan directly and fold its
    // detections back into the session-wide taint state. The wiring is
    // `createSkillGuardrailOptions` from `./agent-skills`, which
    // `createAgentSkills` uses for per-agent skills too (COR-1367), so the
    // two paths cannot drift.
    const skillGuardrail =
      guardrails && guardrailsConfig
        ? createSkillGuardrailOptions(guardrailsConfig, guardrails)
        : undefined;

    let skillRecovery: Promise<SkillRecoveryOutcome> | undefined;
    // COR-323: the named agent's own skills. Its client already owns the run's toolbox and the
    // catalog prompt, so Bureau adds only what the agent cannot see: the durable snapshot of the
    // active set after every step, and the re-validation of a stored set on recovery.
    const agentSkills = agentSkillsRun(sessionAgent?.options.hooks);
    if (agentSkills !== undefined) {
      const { client, catalog } = agentSkills;
      const recoverable = runtimeOptions?.initialActiveSkillRecords;
      if (recoverable !== undefined && recoverable.length > 0) {
        skillRecovery = agentSkills.recover(recoverable).then((outcome) => {
          if (outcome.refused.length > 0) skillPolicyUnverified = true;
          return outcome;
        });
      }
      getActiveSkillRecords = () => client.activationRecords();
      getActiveSkillToolPolicy = () => activeSkillToolPolicy(client.narrowedTools());
      if (sessionStore) {
        const writeSkillSnapshot = createSkillRecordSnapshotHook(
          client,
          catalog,
          request.sessionId,
          sessionStore,
          request.runId,
        );
        hooks.on(
          'onStep',
          async (context) => {
            if (!skillPolicyUnverified) await writeSkillSnapshot(context);
          },
          { id: 'bureau:skill-record-snapshot', replay: 'effectful' },
        );
      }
    } else if (options.skills && skillCatalog !== undefined) {
      // COR-892 — the catalog-backed path. Bureau composes policy and durability *around*
      // Agent-owned behaviour rather than reimplementing it: discovery, trust admission,
      // digest-verified activation and the active set all live in `@lostgradient/bureau/skills`, and what
      // Bureau adds here is the run and session correlation the client cannot see, plus durable
      // persistence of what the client decided.
      const skillClient = createSkillClient({
        catalog: skillCatalog,
        ...(options.skills.currentCatalog === undefined
          ? {}
          : { currentCatalog: options.skills.currentCatalog }),
        // Routed by source kind rather than fixed to the filesystem: a catalog can mix a host's
        // filesystem roots with the bureau's own store, and a `storage` record's `sourceLocation`
        // is a store namespace that no filesystem read can follow.
        loadArtifact: createSkillArtifactLoader(kv === undefined ? {} : { storage: kv }),
        // COR-1226's scan, carried onto the client path. Migrating without it would have created
        // the guardrail bypass COR-892 names: skill bodies are untrusted instruction input and
        // pass the same detector pipeline as anything else entering context.
        ...(skillGuardrail === undefined ? {} : { guardrail: skillGuardrail }),
        ...(skillEvents === undefined ? {} : { events: skillEvents }),
        correlation: {
          ...(request.runId === undefined ? {} : { runId: request.runId }),
          sessionId: request.sessionId,
          ...(request.agentName === undefined ? {} : { agentName: request.agentName }),
        },
      });

      // Recovery before anything else reads the active set: a resumed run must re-validate every
      // stored record against the live catalog and re-check its digest, so a skill whose source
      // was revoked or whose content drifted while the run was away does not come back.
      const recoverable = runtimeOptions?.initialActiveSkillRecords;
      if (recoverable !== undefined && recoverable.length > 0) {
        // Detached deliberately: composition is synchronous, and recovery re-reads bundles. The
        // first step's `prepareStep` awaits the same promise below, so nothing reads a half-filled
        // active set.
        skillRecovery = skillClient.recover(recoverable).then((outcome) => {
          if (outcome.refused.length > 0) skillPolicyUnverified = true;
          return outcome;
        });
      }

      // The records verbatim, not a name-and-policy projection of them. The projection was what
      // the provider-backed snapshot could carry; narrowing to it here would throw away the
      // provenance every reader of this snapshot now depends on.
      getActiveSkillRecords = () => skillClient.activationRecords();
      getActiveSkillToolPolicy = () => activeSkillToolPolicy(skillClient.narrowedTools());

      if (options.skills.includeTools !== false) {
        const skillToolset = createSkillClientToolbox(
          skillClient,
          skillGuardrail === undefined ? undefined : { guardrail: skillGuardrail },
        );
        // `undefined` when the admitted catalog is empty, so no skill tool is exposed at all —
        // a model handed `activate_skill` against an empty catalog invents a name to pass it.
        if (skillToolset !== undefined) {
          hooks.on(
            'prepareStep',
            (context) => {
              if (context.step !== 0) return Promise.resolve();
              const rendered = renderClientCatalog(skillClient);
              if (rendered !== undefined) {
                context.conversation.appendSystemMessage(rendered, {
                  _skillCatalogInjected: true,
                });
              }
              return Promise.resolve();
            },
            {
              id: 'bureau:skill-client-catalog',
              // Reads the client's frozen catalog revision and appends to the
              // step's conversation; nothing outside it is touched.
              replay: 'safe',
            },
          );

          toolbox = withAddedTools(
            toolbox,
            createToolbox([
              skillToolset.activateSkill,
              skillToolset.loadSkillResource,
              skillToolset.deactivateSkill,
            ]) as AnyToolbox,
          );
        }
      }

      // Active instructions are re-rendered every step rather than left in the transcript, which
      // is what makes them survive a compaction strategy that rewrote the whole history.
      hooks.on(
        'prepareStep',
        async (context) => {
          // Recovery settles before the first step reads the active set, so nothing renders a
          // half-filled one.
          if (skillRecovery !== undefined) await skillRecovery;
          const instructions = renderActiveSkillInstructions(skillClient.active());
          if (instructions !== undefined) {
            context.conversation.appendSystemMessage(instructions, { _skillContentInjected: true });
          }
        },
        {
          id: 'bureau:skill-client-instructions',
          // Renders the active set into the step's conversation. Re-rendering on
          // a replayed step is the point — see the comment above — and reaches
          // nothing outside that conversation.
          replay: 'safe',
        },
      );

      if (sessionStore) {
        const writeSkillSnapshot = createSkillRecordSnapshotHook(
          skillClient,
          skillCatalog,
          request.sessionId,
          sessionStore,
          request.runId,
        );
        hooks.on(
          'onStep',
          async (context) => {
            // What an unverified policy persisted before is kept: a snapshot of the skills this
            // run holds now would replace the one that governs the call.
            if (!skillPolicyUnverified) await writeSkillSnapshot(context);
          },
          {
            id: 'bureau:skill-record-snapshot',
            // Writes the activation records to the session store.
            replay: 'effectful',
          },
        );
      }
    }

    // AB-40 — `undefined` (not configured) wires the enabled-by-default
    // preset; `false` opts out entirely; anything else replaces the preset.
    // COR-1577 — an agent that resolves its own guardrails was handed this bureau's policy as
    // its inherited one and applies it in its own hook tier, exactly as a catalog dispatch does.
    if (guardrails && sessionAgent?.agentResolvesGuardrails !== true) {
      // Registered last on `prepareStep`, as the array push order had it, so
      // the input guardrail scans a step context every earlier hook has
      // already contributed to rather than one they then append to.
      registerGuardrailInvariants(hooks, guardrails);
    }

    // Records the run was given but no skill client is configured to enforce cannot be honoured.
    if (
      !skillsConfigured &&
      agentSkills === undefined &&
      (runtimeOptions?.initialActiveSkillRecords?.length ?? 0) > 0
    ) {
      skillPolicyUnverified = true;
    }
    const skillToolPolicy: (() => ToolPolicy | undefined) | undefined =
      getActiveSkillToolPolicy === undefined && !skillPolicyUnverified
        ? undefined
        : () => (skillPolicyUnverified ? { allowList: [] } : getActiveSkillToolPolicy?.());
    // COR-1947 — nearest the tools: a layer, so what is added to the run later is held to it too.
    const chatToolbox =
      request.runId === undefined ? toolbox : governedByChat(toolbox, request.runId);
    const runToolbox = withDefaultToolboxRequestContext(
      // COR-1228 — narrow by active-skill policy first, then apply the request
      // context. Order matters only for readability here: both are proxies and
      // neither observes the other, but filtering nearest the toolbox keeps the
      // request-context wrapper the outermost thing a caller sees.
      skillToolPolicy
        ? withToolboxLayer(chatToolbox, (rebuilt) =>
            withActiveSkillToolPolicy(rebuilt, skillToolPolicy),
          )
        : chatToolbox,
      requestContext,
      () => validateDispatch,
      runtimeServices,
    );
    return Promise.resolve({
      generate,
      toolbox: runToolbox,
      hooks,
      getActiveSkillRecords,
      // Records the run was given but no skill client is configured to enforce: all are refused.
      skillPolicyUnverified: () => skillPolicyUnverified,
      skillsRecovered:
        skillRecovery ??
        Promise.resolve({
          recovered: [],
          refused: (runtimeOptions?.initialActiveSkillRecords ?? []).map((record) => record.name),
        }),
    });
  }

  /**
   * COR-1586 — the resolver a reader needs. The engine reclaims runs on its own interval from the
   * moment it exists, which is before `createBureau` has built the catalog the resolver reads, so
   * a reader that finds the resolver unset waits for it when the caller said one is coming (see
   * `awaitsCatalogAgentRunOptionsResolver`), saying once, as a `warn`, which run it is holding.
   * `absent` is the answer of a composition that was never told to expect one, or whose resolver
   * was cleared again; `abandoned` is the answer once the caller gave up on wiring it.
   */
  async function awaitCatalogAgentRunOptionsResolver(
    runId: string | undefined,
  ): Promise<
    | { status: 'wired'; resolver: CatalogAgentRunOptionsResolver }
    | { status: 'absent' }
    | { status: 'abandoned'; reason: string }
  > {
    // Abandonment is terminal: a composition whose Bureau failed to build answers every reader
    // with the failure, even if a resolver was wired before it failed.
    if (catalogResolverAbandonedReason !== undefined) {
      return { status: 'abandoned', reason: catalogResolverAbandonedReason };
    }
    if (catalogAgentRunOptionsResolver) {
      return { status: 'wired', resolver: catalogAgentRunOptionsResolver };
    }
    if (dependencies.awaitsCatalogAgentRunOptionsResolver !== true) return { status: 'absent' };
    if (!catalogResolverGateOpen) {
      diagnose({
        level: 'warn',
        scope: 'recovery',
        message:
          `[bureau] ${runId === undefined || runId === '' ? 'A run' : `Run "${runId}"`} needs the ` +
          `agent run options resolver before the bureau has wired it; holding it until the ` +
          `bureau finishes building its agent catalog.`,
      });
      await catalogResolverGate.promise;
    }
    // Re-read after the wait: the gate opened because the resolver was wired or abandoned.
    if (catalogResolverAbandonedReason !== undefined) {
      return { status: 'abandoned', reason: catalogResolverAbandonedReason };
    }
    return catalogAgentRunOptionsResolver
      ? { status: 'wired', resolver: catalogAgentRunOptionsResolver }
      : { status: 'absent' };
  }

  /**
   * COR-1577 — resolve the catalog agent a session run names, through the resolver `createBureau`
   * wires for catalog dispatch and boot recovery, so a session run and a catalog run of the same
   * agent resolve identically. The placeholder input is discarded: only the run options and the
   * system prompt the definition would seed are read from the result.
   */
  async function resolveSessionAgentRun(
    agentName: string,
    runId: string,
    principal?: string,
    recorded?: CatalogRunRecordedDefinition,
    session?: SessionTaintSource,
  ): Promise<SessionAgentRunResolution> {
    const wired = await awaitCatalogAgentRunOptionsResolver(runId);
    if (wired.status === 'absent') {
      return { status: 'resolver-failed', error: new Error('No catalog agent resolver is wired.') };
    }
    if (wired.status === 'abandoned') {
      return { status: 'resolver-failed', error: new Error(wired.reason) };
    }
    const resolution = await wired.resolver(
      agentName,
      SESSION_AGENT_PLACEHOLDER_INPUT,
      {
        agentName,
        ...(principal === undefined ? {} : { principal }),
        // COR-2105 — an agent that resolves its own guardrails seeds its tracker from the session's
        // taint and writes a new one back. A run with no session has none to hand.
        ...(session === undefined
          ? {}
          : {
              sessionTaint: sessionTaintSeamFor(
                session.sessionId,
                runId === '' ? session.sessionId : runId,
                session.metadata,
              ),
            }),
      },
      runId,
      ...(recorded === undefined ? [] : [recorded]),
    );
    if (resolution.status !== 'resolved') return resolution;
    return {
      status: 'resolved',
      run: {
        agentName,
        options: resolution.options,
        definitionRevision: resolution.definitionRevision,
        ...(resolution.agentBinding === undefined ? {} : { agentBinding: resolution.agentBinding }),
        agentResolvesGuardrails: resolution.agentResolvesGuardrails === true,
        ...(resolution.agentTaintThreshold === undefined
          ? {}
          : { agentTaintThreshold: resolution.agentTaintThreshold }),
        generationMode: resolution.generationMode,
        instructions: agentInstructionsFromRunOptions(resolution.options),
      },
    };
  }

  /**
   * Rebuild a recovered run's non-serializable {@link DurableRunDeps} from durable
   * config: reconstruct the run runtime from the owning session's persisted
   * request — the same `createRunRuntime` a fresh run uses. Its one caller
   * (`resolveRunServices`, below) already narrows `session` non-null before
   * calling this, so the parameter is typed non-optional rather than
   * defending an absent-session case nothing reaches — AB-260 removed the
   * `null`-returning branch this used to have, which was covered only
   * through the retired `setBuildRunDepsFromSession` override seam.
   *
   * The reconstructed `conversation` is a placeholder: a resumed run reads its
   * transcript from the checkpoint, not from `options.conversation`. Weft's
   * awaited recovery hook attaches the live emitter after these services are
   * rebuilt and before resumed user code advances.
   */
  async function buildRunDepsFromSession(
    session: AgentSession,
    runId?: string,
    agentName?: string,
  ): Promise<DurableRunDeps> {
    const message = session.metadata['lastUserMessage'];
    // Rehydrate the active skill set from the last-written snapshot so the
    // recovered toolbox is aware of skills activated in completed pre-crash steps.
    // Completed steps are memoized by Weft and do not re-run their tool executions,
    // so a fresh SkillSession would be unaware of any `activate_skill` calls made
    // before the crash. `activeSkillRecords` is written by createSkillRecordSnapshotHook after
    // each step boundary and is validated here before use (PRRT_kwDORvupsc6MZ1Md).
    // COR-1620: the snapshot it can verify, or none and no tools: a reattached run whose policy
    // cannot be verified, or whose stored skill the catalog refuses, is offered no tool, has its
    // approvals refused at approve, and keeps the snapshot it has.
    // COR-1577 — a recovered named run resumes under its agent, by the catalog path's policy: an
    // agent gone from the catalog fails the run, and a definition that changed since the run
    // started is logged and the current one runs.
    const sessionAgent = await resolveRecoveredSessionAgent(session, runId, agentName);
    const skillSnapshot: SkillSnapshot =
      runId === undefined
        ? { status: 'verified', records: undefined }
        : readSessionSkillSnapshot(
            session,
            runId,
            agentSkillsRun(sessionAgent?.options.hooks) !== undefined,
          );
    const initialActiveSkillRecords =
      skillSnapshot.status === 'verified' ? skillSnapshot.records : undefined;
    let requestContext = recoveredRequestContext(
      session.metadata,
      runId,
      session.id,
      agentName,
      runtimeServices.clock.now,
    );
    if (options.workspace !== undefined && requestContext?.authority.workspace === undefined) {
      const owner = runId === undefined ? undefined : recoveredOwnerOf(session, runId);
      const authority = await recoverRunWorkspaceAuthority(options.workspace, undefined, owner);
      if (authority !== undefined) {
        const context =
          requestContext ??
          normalizeRunRequestContext(
            undefined,
            runId ?? session.id,
            session.id,
            agentName ?? defaultBureauAgentName,
            owner,
          );
        requestContext = { ...context, authority: { ...context.authority, workspace: authority } };
      }
    }
    const runRuntime = await createRunRuntime(
      {
        message: typeof message === 'string' ? message : '',
        sessionId: session.id,
        // Thread the recovered run's id so the memory-persist hook's idempotency
        // key (`${runId}:${step}`) matches the pre-crash execution — the durable
        // recovery path is one place the at-least-once re-fire happens.
        ...(runId !== undefined ? { runId } : {}),
        ...(agentName !== undefined ? { agentName } : {}),
        ...(requestContext ? { requestContext } : {}),
      },
      {
        initialActiveSkillRecords,
        skillPolicyUnverifiable: skillSnapshot.status === 'unverifiable',
        sessionAgent,
        memoryOwner: resolveRunMemoryOwner(session.metadata, runId),
        sessionMetadata: session.metadata,
        // COR-1911 — a run of a tried agent resumes as it began, without memory.
        withoutMemory: sessionOriginOf(session.metadata) === 'try',
      },
    );
    const skillRecovery = await runRuntime.skillsRecovered;
    if (skillSnapshot.status === 'unverifiable' || skillRecovery.refused.length > 0) {
      options.onLog?.({
        workflowId: runId ?? session.id,
        workflowType: 'agentRun',
        timestamp: runtimeServices.clock.now(),
        level: 'warn',
        message: `Session run "${runId ?? session.id}" is reattached without tools: its skill policy cannot be verified (${
          skillSnapshot.status === 'unverifiable'
            ? skillSnapshot.reason
            : `a stored skill was refused on recovery: ${skillRecovery.refused.join(', ')}`
        }).`,
      });
    }

    // AB-336: wire `requestHumanInput`/`scheduleWakeup` in on the RECOVERY
    // path too — see `wireDurableOptInTools`'s own doc comment for the root
    // cause this closes. `servicesRef.current` is assigned to `services`
    // itself, synchronously, below (no `onServices` hook needed here: unlike
    // `createRunFromRequest`'s fresh dispatch, this function already holds
    // the exact object Weft will hand back as `ctx.services` — it's what
    // this function returns).
    let runToolbox: BureauToolbox = runRuntime.toolbox;
    const servicesRef: { current?: DurableRunDeps } = {};
    // COR-1710 — the grant the task started with, not the settings of the moment.
    const grant = grantedTools(
      runId === undefined ? undefined : await dependencies.toolGrantFor?.(runId),
      options,
    );
    const wantsHumanInput = grant.humanInput && runId !== undefined;
    const wantsWakeup = grant.wakeup && runId !== undefined;
    // COR-1709: offered to exactly the runs that are offered `requestHumanInput`.
    const decide =
      runId === undefined
        ? undefined
        : dependencies.decideToolFor?.(recoveredOwnerOf(session, runId), grant.decide);
    if (wantsHumanInput || wantsWakeup || decide !== undefined) {
      runToolbox = wireDurableOptInTools(runRuntime.toolbox, servicesRef, {
        humanInput: wantsHumanInput,
        inputSchemas: grant.inputSchemas,
        wakeup: wantsWakeup,
        ...(decide === undefined ? {} : { decide }),
        // `runId` is non-undefined here (both `wantsHumanInput`/`wantsWakeup`
        // require it); `?? ''` only satisfies the type checker.
        runId: runId ?? '',
        ...(wantsHumanInput
          ? {
              // `DurableRunDeps.emitter` isn't assigned until AFTER this
              // function returns — `createRecoveredRunEventSurface` sets it
              // on the SAME `services` object this closure is about to
              // construct and hand back (see `onRecoveredWorkflow` in
              // `create-bureau.ts`). This forwarder reads it lazily, at
              // actual tool-call time, by which point it has settled;
              // `hasDispatchEvent` narrows without a cast, since
              // `DurableRunDeps.emitter`'s own `EventDispatcher` type
              // declares only `dispatch`, not the DOM-style `dispatchEvent`
              // every real emitter (a `CompletableEventTarget`) also has.
              humanInputEmitter: {
                dispatchEvent: (event: Event) => {
                  const target = servicesRef.current?.emitter;
                  return hasDispatchEvent(target) ? target.dispatchEvent(event) : false;
                },
              },
            }
          : {}),
      });
    }

    const services: DurableRunDeps = {
      toolbox: runToolbox,
      getStepMetadata: () =>
        runRuntime.skillPolicyUnverified()
          ? {}
          : {
              [activeSkillsStepMetadataKey]: activeSkillsStepMetadata(
                runRuntime.getActiveSkillRecords(),
              ),
            },
      options: {
        generate: runRuntime.generate,
        toolbox: runToolbox,
        conversation: new Conversation(session.conversationHistory),
        // COR-2106 — children this run dispatches carry Bureau's tier.
        ...bureauInvariantsField(bureauChildInvariants),
        ...copyAgentOwnedRunOptions(sessionAgent?.options),
        // COR-1577 — the request's cap persisted at the start, then the named agent's, then the
        // Bureau's default; a run with no named agent keeps the Bureau's.
        // The run's owner of record, not its per-run service principal: a managed asset
        // resolves for whoever owns the session, as it did before the crash.
        ...sessionRunMediaOptions(
          sessionAgent,
          mediaOptionsFor(resolveSessionOwner(session.metadata), 'session'),
        ),
        // COR-1707: the caps are the named agent's, as when the run started; a run carries none of
        // its own.
        maximumSteps: sessionAgent?.options.maximumSteps ?? maximumSteps,
        stopWhen: sessionAgent?.options.stopWhen ?? options.stopWhen,
        // COR-1269 — stamped onto this run's hook-plan observations.
        sessionId: session.id,
        // COR-1265 — the completed Bureau tier, snapshotted. A single-tier
        // merge still copies every entry into a fresh registry, so a
        // registration added to `runRuntime.hooks` after this point cannot
        // reach the run that already holds the copy. COR-1577 — a named agent's own tier
        // follows it, as on a catalog dispatch.
        hooks: composeHooks({ bureau: runRuntime.hooks, agent: sessionAgent?.options.hooks }),
        // AB-260: the bureau's single composed RuntimeServices instance,
        // snapshotted into every run it starts — including a recovered run
        // rebuilt here from a persisted session.
        runtime: runtimeServices,
        executeOptions: sessionExecuteOptions(sessionAgent?.options, requestContext),
        // Thread agentName and runId so curated tool.* bubble events stamped by
        // the resumed run carry the same {agentName, runId, step} metadata as the
        // pre-crash run (C3 parity). Without them, recovered runs emit blank ids.
        ...(agentName !== undefined ? { agentName } : {}),
        ...(runId !== undefined ? { runId } : {}),
        ...(sessionAgent?.options.maximumTokens !== undefined
          ? { maximumTokens: sessionAgent.options.maximumTokens }
          : {}),
      },
    };
    if (runId !== undefined) {
      dependencies.configureDurableRun?.(
        runId,
        services,
        ownerOrLocal(recoveredOwnerOf(session, runId)),
      );
    }
    if (wantsHumanInput || wantsWakeup) {
      servicesRef.current = services;
    }
    recordRecoveredSkillPolicy(runToolbox, {
      scheduledFire: false,
      agentName: agentName ?? session.agentName,
      sessionAgent,
      recordsKey: JSON.stringify(initialActiveSkillRecords ?? []),
      recoveredCleanly: skillSnapshot.status === 'verified' && skillRecovery.refused.length === 0,
    });
    return services;
  }

  /** The agent a recovered session run belongs to, or `undefined` for the default agent. */
  async function resolveRecoveredSessionAgent(
    session: AgentSession,
    runId: string | undefined,
    agentName: string | undefined,
  ): Promise<SessionAgentRun | undefined> {
    if (agentName === undefined) return undefined;
    // A composition with no catalog wired (`createBureau` always wires one) has no named agents,
    // so the name is only a label and the run is the Bureau-wide runtime's. A Bureau that is
    // still being built has one coming, and the run waits for it (COR-1586): resuming it under the
    // Bureau-wide runtime would be resuming it under the wrong agent.
    const wired = await awaitCatalogAgentRunOptionsResolver(runId);
    const label = runId === undefined ? 'a recovered run' : `run ${runId}`;
    if (wired.status === 'absent') return undefined;
    if (wired.status === 'abandoned') throw new Error(`${label}: ${wired.reason}`);
    // COR-323 — the implicit Bureau-wide agent no longer exists, so a run stored under it names
    // the cause instead of failing on a missing `generate`.
    if (agentName === BUREAU_AGENT_NAME) {
      throw new Error(
        `${label}: it belongs to the implicit "${BUREAU_AGENT_NAME}" agent, which no longer ` +
          'exists; it is not resumed',
      );
    }
    const owner = resolveSessionOwner(session.metadata);
    const recordedHash = session.metadata[SESSION_AGENT_DEFINITION_HASH_METADATA_KEY];
    const resolution = await resolveSessionAgentRun(
      agentName,
      runId ?? '',
      owner,
      {
        agentDefinitionHash: typeof recordedHash === 'string' ? recordedHash : undefined,
        definitionRevision: sessionRecordedRevision(session.metadata, recordedHash),
      },
      { sessionId: session.id, metadata: session.metadata },
    );
    if (resolution.status === 'missing-agent') {
      throw new Error(`${label}: catalog agent "${agentName}" is no longer in the catalog`);
    }
    if (resolution.status === 'not-durable-capable') {
      throw new Error(
        `${label}: catalog agent "${agentName}" no longer supports durable definition ` +
          `resolution (OPERATIVE_RESOLVE_RUN_OPTIONS)`,
      );
    }
    if (resolution.status === 'resolver-failed') {
      throw new Error(
        `${label}: catalog agent "${agentName}" could not resolve run options during ` +
          `recovery: ${serializeUnknownError(resolution.error)}`,
      );
    }
    const startedAt = session.metadata[SESSION_AGENT_REVISION_METADATA_KEY];
    if (
      resolution.run.agentBinding === undefined &&
      typeof startedAt === 'number' &&
      startedAt !== resolution.run.definitionRevision
    ) {
      diagnose({
        level: 'warn',
        scope: 'recovery',
        message:
          `[bureau] Catalog agent "${agentName}" definition revision changed since ${label} ` +
          `started (was ${startedAt}, now ${resolution.run.definitionRevision}); ` +
          `resuming with the current definition.`,
      });
    }
    return resolution.run;
  }

  /**
   * Persist a scheduled run's conversation back to its session after EVERY
   * completed step (last-write-wins, idempotent). This is what makes the
   * recurring-conversation pattern work: fire N+1 loads the session this hook
   * last wrote, so the agent accumulates context across fires. For a
   * fresh-per-fire (stateless cron) session it records the fire's transcript so
   * the run is observable via `getSession`.
   *
   * Persisting on every step (not only `context.final`) is deliberate: a fire that
   * ends on `maximum-steps` — or any other non-`final` terminal outcome — still did
   * real work, but its last `StepResult.final` is `false`, so a final-only hook
   * would silently drop the whole fire from a recurring digest (review: codex
   * Mn69a). A step that throws before completing never reaches this hook, so a
   * step-0 failure (no assistant turn produced) is correctly NOT persisted — we
   * never seed a bare, reply-less user turn that the next fire would build on.
   *
   * Deliberately writes ONLY the conversation (no `lastRunStatus: 'running'`
   * lifecycle metadata): scheduled fires recover through Weft's handle monitor
   * rather than the bureau's interactive session ownership path, so a `running`
   * marker would only race any interactive run sharing the session.
   */
  function createScheduledSessionPersistHook(
    store: SessionStore,
    sessionId: string,
    agentName: string,
    baseConversationHistory: ConversationHistory,
    runId: string,
    replaceCurrentFireTranscript: boolean,
    getActiveSkillRecords: () => readonly SkillActivationRecord[],
    skillPolicyUnverified: () => boolean,
    owner: string,
    requestContext: ToolRequestContext,
  ): OnStepHook {
    let bound = false;
    return async (context) => {
      // COR-1596: a fire replaying after a crash may have left an approval in its session that
      // its checkpoint never held; only a replay can find one, so only a replay reads the
      // checkpoint, and reads it before the atomic update, which cannot wait on a read.
      let committedApprovals: ReadonlySet<string> | undefined;
      if (replaceCurrentFireTranscript && durable !== undefined) {
        try {
          // Strict, as every reader of the checkpoint for this is: a step record skipped is a
          // committed approval taken for an abandoned one.
          committedApprovals = committedFireApprovalIds(
            runId,
            await durable.checkpointStore.loadSteps(runId, { strict: true }),
          );
        } catch (error) {
          // A checkpoint that cannot be read drops nothing, and does not fail the fire's step:
          // the approvals it holds are checked at the next boot and when the fire settles.
          diagnose({
            level: 'error',
            scope: 'recovery',
            message: `[bureau] Could not read the checkpoint of replaying schedule fire "${runId}", so its session keeps the approvals it holds: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
      }
      const heldTaintKey = pendingTaintKey(sessionId, runId);
      const heldTaint = pendingScheduledTaints.get(heldTaintKey);
      let taintWritten: PersistedSessionTaint | undefined;
      const saved = await store.update(sessionId, (existing: AgentSession | undefined) => {
        // The updater can run again after a lost race, so it decides every time.
        taintWritten =
          heldTaint !== undefined && readSessionTaint(existing?.metadata) === undefined
            ? heldTaint
            : undefined;
        const activeSkillRecords = getActiveSkillRecords();
        const sessionOwnedByAnotherRunningRun =
          existing?.metadata['lastRunStatus'] === 'running' &&
          typeof existing.metadata['lastRunId'] === 'string' &&
          existing.metadata['lastRunId'] !== runId;
        // Decided inside the atomic update: a fire that built its services while the
        // session did not exist must not append to a session another owner has
        // created since, or one that a concurrent fire created for another owner.
        if (existing !== undefined && !isSessionAuthorityAuthorized(existing.metadata, owner)) {
          throw new SessionOwnerConflictError(sessionId);
        }
        const next =
          existing ??
          createAgentSession({
            id: sessionId,
            agentName,
            conversationHistory: context.conversation.current,
          });
        const existingConversationHistory =
          replaceCurrentFireTranscript && existing
            ? removeLastScheduledFireTranscript(existing.conversationHistory, runId)
            : existing?.conversationHistory;
        return {
          ...next,
          metadata: {
            ...next.metadata,
            lastScheduledFireRunId: runId,
            // COR-718 — the fire's run is owned by the schedule's owner, recorded
            // where a restart rehydrates run owners from, and a session this fire
            // creates takes the same owner. An existing session keeps its own.
            lastRunOwningPrincipals: {
              ...(isPlainAuthorityRecord(next.metadata['lastRunOwningPrincipals'])
                ? next.metadata['lastRunOwningPrincipals']
                : {}),
              [runId]: owner,
            },
            // COR-1645 — and its origin, written once with the owner: a session a fire creates is
            // not a chat a person started, while one a fire continues keeps the origin it has.
            ...(existing === undefined
              ? { [SESSION_OWNER_METADATA_KEY]: owner, [SESSION_ORIGIN_METADATA_KEY]: 'schedule' }
              : {}),
            // COR-2105 — a taint the fire raised before its session existed is stored with it.
            ...(taintWritten === undefined
              ? {}
              : { [SESSION_TAINT_METADATA_KEY]: { ...taintWritten } }),
            ...(sessionOwnedByAnotherRunningRun || skillPolicyUnverified()
              ? {}
              : activeSkillSessionMetadataForStep(activeSkillRecords, context.step, runId)),
            // COR-1596 — a tool call this step left awaiting approval is recorded with the
            // conversation, so a restart can list it again.
            ...scheduledFireApprovalMetadata(
              next.metadata,
              runId,
              context.results,
              requestContext,
              committedApprovals,
            ),
          },
          conversationHistory: existingConversationHistory
            ? appendConversationMessages(
                existingConversationHistory,
                context.conversation.current,
                baseConversationHistory,
              )
            : context.conversation.current,
        };
      });
      if (heldTaint !== undefined) {
        pendingScheduledTaints.delete(heldTaintKey);
        if (taintWritten !== undefined && saved !== undefined) {
          try {
            dependencies.onSessionTainted?.({
              sessionId,
              runId: taintWritten.runId,
              detector: taintWritten.detector,
              provenance: taintWritten.provenance,
              confidence: taintWritten.confidence,
            });
          } catch (error) {
            diagnose({
              level: 'warn',
              scope: 'guardrails',
              message: `[bureau] The taint of session "${sessionId}" could not be published: ${serializeUnknownError(error)}`,
              cause: error,
            });
          }
        }
      }
      // COR-1482: the first save of a fresh session gives it its incarnation, which the fire's
      // task is bound to once, so `bureau.tasks.list({ contextId })` finds the fire.
      if (!bound && saved !== undefined) {
        bound = true;
        await reportScheduledSession({ runId, sessionId, incarnation: saved.incarnation });
      }
    };
  }

  /**
   * AB-240: persist the catalog-run recovery record. Called from
   * `create-bureau.ts`'s `runAgent` durable branch BEFORE `createActiveRun`
   * starts the durable engine, so a crash immediately after start still has,
   * on the next boot, enough to reattach against the catalog agent's own
   * run options — see `resolveRunServices`'s catalog branch below. A no-op
   * when this composition has no durable storage (nothing to reattach
   * across a restart without one, matching the schedule-marker precedent
   * above); the caller only reaches this inside an `if (runtime.durable)`
   * guard, so `durableStorage` is defined whenever it actually matters.
   */
  async function persistCatalogRunRecoveryRecord(
    runId: string,
    record: Omit<CatalogRunRecoveryRecord, 'schemaVersion'>,
  ): Promise<void> {
    if (!durableStorage) return;
    const fullRecord: CatalogRunRecoveryRecord = { schemaVersion: 1, ...record };
    await durableStorage.put(catalogRunRecoveryKey(runId), encode(fullRecord));
  }

  async function claimCatalogRunRecoveryRecord(
    runId: string,
    record: Omit<CatalogRunRecoveryRecord, 'schemaVersion'>,
  ): Promise<boolean> {
    if (!durableStorage) return true;
    const key = catalogRunRecoveryKey(runId);
    const fullRecord: CatalogRunRecoveryRecord = { schemaVersion: 1, ...record };
    return storageConditionalBatch(
      durableStorage,
      [{ key, expectedValue: null }],
      [{ type: 'put', key, value: encode(fullRecord) }],
    );
  }

  async function loadCatalogRunRecoveryRecord(runId: string): Promise<CatalogRunRecoveryLoad> {
    if (!durableStorage) return { status: 'missing' };
    try {
      const value = await durableStorage.get(catalogRunRecoveryKey(runId));
      if (!value) return { status: 'missing' };
      const decoded = decode(value);
      return isCatalogRunRecoveryRecord(decoded)
        ? { status: 'found', record: decoded }
        : { status: 'corrupt' };
    } catch (error) {
      return { status: 'read-error', error };
    }
  }

  async function deleteCatalogRunRecoveryRecord(runId: string): Promise<void> {
    await durableStorage?.delete(catalogRunRecoveryKey(runId));
    catalogRunRecoveryCache.delete(runId);
  }

  /** How many times a tombstone retries against a record that changed under it. */
  const FENCE_WRITE_TRIES = 5;

  async function fenceGoalAttemptRecoveryRecord(
    runId: string,
    owner: GoalAttemptClaimOwner,
    tombstonedAt: string,
  ): Promise<GoalAttemptClaimFence> {
    // No durable storage, nothing to claim: a claim cannot exist to be raced.
    if (!durableStorage) return 'fenced';
    const key = catalogRunRecoveryKey(runId);
    const tombstoned = {
      goalRunId: owner.goalRunId,
      attemptIndex: owner.attemptIndex,
      tombstonedAt,
    };
    for (let attempt = 0; attempt < FENCE_WRITE_TRIES; attempt += 1) {
      const bytes = await durableStorage.get(key);
      if (!bytes) {
        // Nothing claimed yet. The tombstone is the claim, written whole, so a
        // start that reaches its own claim next finds this one and starts nothing.
        // The estimator is the "declared none" selection a valid attempt record
        // must carry; the record is never the source of a run, so nothing reads it.
        const created: CatalogRunRecoveryRecord = {
          schemaVersion: 1,
          agentName: owner.agentName,
          definitionRevision: 0,
          input: '',
          ...(owner.principal === undefined ? {} : { principal: owner.principal }),
          goalAttempt: tombstoned,
          costEstimation: null,
        };
        if (
          await storageConditionalBatch(
            durableStorage,
            [{ key, expectedValue: null }],
            [{ type: 'put', key, value: encode(created) }],
          )
        ) {
          return 'fenced';
        }
        continue;
      }
      const decoded = decode(bytes);
      if (!isCatalogRunRecoveryRecord(decoded)) {
        throw new Error(
          `The recovery record for run "${runId}" exists but is not valid, so its attempt cannot be fenced.`,
        );
      }
      const claimed = decoded.goalAttempt;
      if (
        claimed?.goalRunId !== owner.goalRunId ||
        claimed.attemptIndex !== owner.attemptIndex ||
        decoded.agentName !== owner.agentName ||
        decoded.principal !== owner.principal
      ) {
        return 'foreign';
      }
      if (claimed.tombstonedAt !== undefined) return 'fenced';
      const next: CatalogRunRecoveryRecord = {
        ...decoded,
        goalAttempt: { ...claimed, tombstonedAt },
      };
      if (
        await storageConditionalBatch(
          durableStorage,
          [{ key, expectedValue: bytes }],
          [{ type: 'put', key, value: encode(next) }],
        )
      ) {
        return 'fenced';
      }
    }
    throw new Error(
      `The recovery record for run "${runId}" kept changing while its attempt was being fenced.`,
    );
  }

  /**
   * AB-240: whether `runId` has a persisted catalog-run recovery record —
   * `create-bureau.ts`'s boot-recovery classification uses this to route a
   * catalog-dispatched run to a headless monitor (mirroring a native
   * scheduled fire) instead of the session-ownership classification, which
   * would otherwise treat it as an orphaned run and cancel it (a catalog run
   * deliberately owns no bureau session).
   *
   * True for `'read-error'` as well as `'found'` (review finding): a corrupt
   * record still marks this workflow id as catalog territory. `'missing'`
   * is the only status that means "genuinely not a catalog run" — treating
   * `'read-error'` as `false` would let a merely-corrupt (not absent) record
   * fall through to the session-ownership classification below, which would
   * then cancel the run as an unowned orphan instead of leaving it to the
   * `{ status: 'unavailable', reason: '... unreadable' }` outcome
   * `resolveRunServices`'s catalog branch already produced for it.
   */
  async function isCatalogRecoveredRun(runId: string): Promise<boolean> {
    // AB-241 review finding: consult the cache `resolveRunServices` already
    // populated FIRST — `recoverDurableRuns`'s post-recovery loop calls this
    // for every handle `onRecoveredWorkflow` didn't already register, so a
    // catalog run's classification here must stay consistent with the
    // resolver's own earlier, successful read rather than risk a fresh,
    // independent one transiently disagreeing with it (a `false` from a
    // flaky second read would fall through to session-ownership
    // classification and cancel an already-resolved-and-monitored catalog
    // run as an orphan). See `catalogRunRecoveryCache`'s own doc comment for
    // why entries are NOT evicted here — only `classifyCatalogRecoveredRun`
    // (a second, later consumer of the same cache — see its own doc
    // comment for why entries are retained for the whole recovery pass,
    // never evicted per-read).
    if (catalogRunRecoveryCache.has(runId)) return true;
    const load = await loadCatalogRunRecoveryRecord(runId);
    return load.status !== 'missing' && load.status !== 'corrupt';
  }

  /**
   * AB-241 review finding: `create-bureau.ts`'s `onRecoveredWorkflow` calls
   * this ONCE to both classify a recovered workflow as catalog territory
   * and reseed `runAttribution` — see this function's own doc comment on
   * the `RuntimeComposition` interface for why a single combined read
   * replaces what would otherwise be two independent ones.
   *
   * Fresh review finding: `resolveRunServices`'s catalog branch ALREADY
   * reads and decodes this exact record, earlier, for the same workflow
   * (Weft always resolves a recovered workflow's services before invoking
   * the awaited `onRecoveredWorkflow` hook this function is called from).
   * Rather than issue a THIRD independent storage read here, this consumes
   * `catalogRunRecoveryCache`'s entry from that earlier, already-successful
   * read — a transient failure on a fresh read can no longer diverge from
   * the classification `resolveRunServices` already committed to. Falls
   * back to a fresh read only when the cache holds nothing for `runId`
   * (e.g. a direct caller of this function outside the normal recovery
   * hook ordering, or a test exercising it in isolation).
   *
   * Second fresh review finding: does NOT evict the cache entry after
   * reading it. `recoverDurableRuns`'s own post-recovery loop calls
   * `isCatalogRecoveredRun` for the SAME workflow id, AFTER this function
   * already ran for it (via the awaited `onRecoveredWorkflow` hook, which
   * happens during `recoverAll()`, strictly before the post-recovery loop
   * that iterates its returned handles) — evicting here would have starved
   * that second, later consumer of the exact same already-successful read
   * this function exists to reuse, sending it back to an independent
   * storage read whose transient failure could misclassify an
   * already-resolved-and-monitored catalog run as an orphan. The whole
   * cache is cleared in one call at the end of the boot recovery pass
   * instead — see `clearCatalogRunRecoveryCache`.
   */
  async function classifyCatalogRecoveredRun(runId: string): Promise<{
    isCatalogRun: boolean;
    attribution?: { agentName: string; principal?: string };
  }> {
    const cached = catalogRunRecoveryCache.get(runId);
    if (cached) {
      return {
        isCatalogRun: true,
        attribution: {
          agentName: cached.agentName,
          ...(cached.principal !== undefined ? { principal: cached.principal } : {}),
        },
      };
    }
    const load = await loadCatalogRunRecoveryRecord(runId);
    if (load.status === 'missing' || load.status === 'corrupt') return { isCatalogRun: false };
    if (load.status === 'read-error') return { isCatalogRun: true };
    return {
      isCatalogRun: true,
      attribution: {
        agentName: load.record.agentName,
        ...(load.record.principal !== undefined ? { principal: load.record.principal } : {}),
      },
    };
  }

  /**
   * AB-241 review finding: see `catalogRunRecoveryCache`'s own doc comment.
   */
  function clearCatalogRunRecoveryCache(): void {
    catalogRunRecoveryCache.clear();
  }

  /**
   * AB-240: `resolveRunServices`'s catalog branch — resolves a recovered
   * catalog-dispatched run's deps through the CATALOG AGENT's own
   * `OPERATIVE_RESOLVE_RUN_OPTIONS` (via `catalogAgentRunOptionsResolver`,
   * wired by `createBureau`), never through `buildRunDepsFromSession` /
   * the Bureau's own runtime composition — reattaching a catalog run
   * against the Bureau's default provider/tools instead of the agent's own
   * is this feature's rollback trigger.
   */
  async function resolveCatalogAgentRunServices(
    runId: string,
    record: CatalogRunRecoveryRecord,
  ): Promise<WorkflowServicesResolution> {
    const authority =
      options.workspace === undefined
        ? undefined
        : await recoverRunWorkspaceAuthority(
            options.workspace,
            record.workspaceAuthority,
            record.principal,
          );
    if (options.workspace !== undefined && authority === undefined)
      return { status: 'unavailable', reason: 'Workspace authority unavailable.' };
    const baseContext = normalizeRunRequestContext(
      undefined,
      runId,
      record.contextId ?? runId,
      record.agentName,
      record.principal,
    );
    const workspaceContext: ToolRequestContext =
      authority === undefined
        ? baseContext
        : { ...baseContext, authority: { ...baseContext.authority, workspace: authority } };
    const wired = await awaitCatalogAgentRunOptionsResolver(runId);
    if (wired.status === 'absent') {
      return {
        status: 'unavailable',
        reason: `run ${runId}: no catalog agent recovery resolver is configured`,
      };
    }
    if (wired.status === 'abandoned') {
      return { status: 'unavailable', reason: `run ${runId}: ${wired.reason}` };
    }
    const resolution = await wired.resolver(
      record.agentName,
      record.input,
      {
        agentName: record.agentName,
        // The run's own id, as its first dispatch carried, so a row the agent seeds from `input`
        // gets the id it had then (COR-1581) and the options carry the run's id.
        runId,
        // AB-241 review finding: without this, a recovered catalog agent's
        // re-invoked `OPERATIVE_RESOLVE_RUN_OPTIONS` rebuilt `RunOptions` with
        // no `principal` at all, so a resumed run silently lost attribution
        // across a restart.
        ...(record.principal !== undefined ? { principal: record.principal } : {}),
      },
      runId,
      {
        agentDefinitionHash: record.agentDefinitionHash,
        definitionRevision: record.definitionRevision,
      },
    );
    if (resolution.status === 'missing-agent') {
      return {
        status: 'unavailable',
        reason: `run ${runId}: catalog agent "${record.agentName}" is no longer in the catalog`,
      };
    }
    if (resolution.status === 'not-durable-capable') {
      return {
        status: 'unavailable',
        reason:
          `run ${runId}: catalog agent "${record.agentName}" no longer supports durable ` +
          `definition resolution (OPERATIVE_RESOLVE_RUN_OPTIONS)`,
      };
    }
    if (resolution.status === 'resolver-failed') {
      return {
        status: 'unavailable',
        reason:
          `run ${runId}: catalog agent "${record.agentName}" could not resolve run options ` +
          `during recovery: ${serializeUnknownError(resolution.error)}`,
      };
    }
    if (
      resolution.agentBinding === undefined &&
      resolution.definitionRevision !== record.definitionRevision
    ) {
      // Pin-and-warn, mirroring AB-10's workflow-version-mismatch precedent
      // (`workflowVersionMismatches` / 'reattach-version-mismatch'): reattach
      // with the catalog's CURRENT definition (the closest available match)
      // rather than fail, but surface the drift for operators.
      diagnose({
        level: 'warn',
        scope: 'recovery',
        message:
          `[bureau] Catalog agent "${record.agentName}" definition revision changed since ` +
          `run ${runId} was checkpointed (was ${record.definitionRevision}, now ` +
          `${resolution.definitionRevision}); reattaching with the current definition.`,
      });
    }
    // COR-1265 criterion 3b. AB-240's separation is about the PROVIDER and the
    // TOOLBOX — a recovered catalog run must reattach against the agent's own,
    // not the Bureau's, and that is unchanged here. Only the hook tier is added,
    // and only the invariants that close over nothing run-specific, so Bureau's
    // identity and guardrail policy hold on this path as they do on every other.
    // The agent's own tier arrives inside `resolution.options.hooks`, from its
    // own `buildRunOptions`; Bureau goes first so it wins `runFirst` and, being
    // pinned last, still wins the waterfall.
    // A recovered goal attempt's run is fenced exactly as a fresh one is: a run
    // the goal ended over, which a crash left to be resumed here, takes no step.
    const invariants = createBureauInvariantHooks(
      record.goalAttempt === undefined
        ? undefined
        : {
            goalRunId: record.goalAttempt.goalRunId,
            attemptIndex: record.goalAttempt.attemptIndex,
            runId,
          },
      { agentResolvesGuardrails: resolution.agentResolvesGuardrails === true },
    );
    // COR-1577 — a recovered `bureau.run()` run is offered `requestHumanInput` again, exactly
    // when its fresh dispatch was: the option is on, the engine is durable, and it is neither a
    // child nor a goal attempt. The tool parks through the services object being returned, so
    // that object is captured once it exists, as `buildRunDepsFromSession` does.
    // COR-1710 — the grant recorded when the task started; one recorded before grants were
    // resumes with the settings now.
    const catalogGrant = grantedTools(
      record.tools ?? (await dependencies.toolGrantFor?.(runId)),
      options,
    );
    const offersHumanInput =
      catalogGrant.humanInput &&
      durable !== undefined &&
      record.goalAttempt === undefined &&
      record.workflowStep === undefined &&
      resolution.recoveredChild !== true;
    const humanInputServices: { current?: DurableRunDeps } = {};
    // COR-1709: the `decide` tool is offered on exactly the runs `requestHumanInput` is, but is
    // independent of the `humanInput` option.
    const offersDecide =
      durable !== undefined &&
      record.goalAttempt === undefined &&
      record.workflowStep === undefined &&
      resolution.recoveredChild !== true;
    const decide = offersDecide
      ? dependencies.decideToolFor?.(ownerOrLocal(record.principal), catalogGrant.decide)
      : undefined;
    const chatToolbox = governedByChat(resolution.options.toolbox, runId);
    const toolbox =
      offersHumanInput || decide !== undefined
        ? wireDurableOptInTools(chatToolbox, humanInputServices, {
            humanInput: offersHumanInput,
            inputSchemas: catalogGrant.inputSchemas,
            wakeup: false,
            runId,
            ...(decide === undefined ? {} : { decide }),
            humanInputEmitter: {
              dispatchEvent: (event: Event) => {
                const target = humanInputServices.current?.emitter;
                return hasDispatchEvent(target) ? target.dispatchEvent(event) : false;
              },
            },
          })
        : chatToolbox;
    const services: DurableRunDeps = {
      options: {
        // COR-1996: held to the model policy as a fresh dispatch's generate is.
        ...guardWorkspaceRunOptions(
          options.workspace,
          holdToModelPolicy(resolution.options, resolution.generationMode),
          workspaceContext,
        ),
        // The run's owner of record resolves its assets and holds the same
        // unverified-asset policy as on a fresh dispatch, unless the agent set its own.
        ...unsetMediaOptions(
          resolution.options,
          mediaOptionsFor(ownerOrLocal(record.principal), 'run'),
        ),
        toolbox,
        hooks: composeHooks({ bureau: invariants, agent: resolution.options.hooks }),
        // COR-2106 — children this run dispatches carry Bureau's tier.
        ...bureauInvariantsField(bureauChildInvariants),
      },
      toolbox,
    };
    services.childWaitPrincipal = ownerOrLocal(record.principal);
    services.requestChildWait = (request) => {
      if (services.childWaitPrincipal !== request.principal)
        return { parked: false, reason: 'unauthorized' };
      if (
        services.pendingChildWait !== undefined ||
        services.pendingHumanWait !== undefined ||
        services.pendingWakeup !== undefined
      )
        return { parked: false, reason: 'already-parked' };
      services.pendingChildWait = { schemaVersion: 1, ...request };
      return { parked: true };
    };
    dependencies.configureDurableRun?.(runId, services, ownerOrLocal(record.principal));
    humanInputServices.current = services;
    return { status: 'available', services };
  }

  async function loadScheduleIdForRecoveredRun(
    workflowId: string,
  ): Promise<RecoveredScheduleMarker> {
    if (!durableStorage) return { status: 'missing' };
    try {
      const value = await durableStorage.get(KEYS.scheduleRun(workflowId));
      if (!value) return { status: 'missing' };
      const scheduleId = decodeScheduleRunMarker(decode(value));
      return scheduleId !== undefined ? { status: 'found', scheduleId } : { status: 'missing' };
    } catch (error) {
      return { status: 'read-error', error };
    }
  }

  async function loadExistingStatelessScheduledSessionId(
    store: SessionStore,
    runId: string,
  ): Promise<string | undefined> {
    const sessions = await store.list();
    return sessions.find(
      (session: SessionSummary) =>
        session.id.startsWith('sched-') &&
        session.id.endsWith(`-${runId}`) &&
        session.metadata['lastScheduledFireRunId'] === runId,
    )?.id;
  }

  async function loadExistingScheduledSessionId(
    store: SessionStore,
    input: ScheduledAgentRunInput,
    runId: string,
  ): Promise<string | undefined> {
    if (input.sessionId !== undefined) {
      const session = await store.load(input.sessionId);
      return session?.metadata['lastScheduledFireRunId'] === runId ? input.sessionId : undefined;
    }
    return loadExistingStatelessScheduledSessionId(store, runId);
  }

  async function readCommittedScheduledSkillSnapshot(
    session: { readonly metadata: Record<string, JSONValue> } | undefined,
    runId: string,
    recovering: boolean,
    agentHasSkills = false,
  ): Promise<SkillSnapshot> {
    const none: SkillSnapshot = { status: 'verified', records: undefined };
    if (!recovering || !session) return none;

    const metadata = session.metadata;
    const lastFireRunId = metadata['lastScheduledFireRunId'];
    const recordsRunId = metadata['activeSkillRecordsRunId'];
    // Without skills there is no policy to verify, and whatever the session holds is not it.
    if (!skillsConfigured && !agentHasSkills && recordsRunId !== runId) return none;
    // A fire writes its own run id with its snapshot, at every step. A session that names
    // another fire, as a recurring schedule's newer fire leaves it, holds that fire's snapshot;
    // one whose run id was cleared (null, as the start of a later run in the session does) or
    // never written holds none of this fire's. Whether this fire had skills is not known.
    if (lastFireRunId !== runId) {
      return {
        status: 'unverifiable',
        reason: `its session names another fire, ${describe(lastFireRunId)}`,
      };
    }
    if (recordsRunId !== runId) {
      return {
        status: 'unverifiable',
        reason: `its snapshot names another run, ${describe(recordsRunId)}`,
      };
    }
    const activeSkillRecordsRaw = metadata['activeSkillRecords'];
    const activeSkillRecordsStep = metadata['activeSkillRecordsStep'];
    if (
      typeof activeSkillRecordsStep !== 'number' ||
      !Number.isInteger(activeSkillRecordsStep) ||
      activeSkillRecordsStep < 0
    ) {
      return { status: 'unverifiable', reason: 'its snapshot step does not deserialize' };
    }

    try {
      const checkpoint = await durable?.checkpointStore.loadCheckpoint(runId);
      const committedStepRecords = [...(checkpoint?.steps ?? [])];

      const checkpointBytes = await durable?.engine.storage.get(KEYS.checkpoint(runId));
      if (checkpointBytes) {
        const weftCheckpoint = deserializeCheckpoint(checkpointBytes);
        for (const [, value] of weftCheckpoint.accumulatedResults) {
          const record = recordedAgentStep(value);
          if (record) committedStepRecords.push(record);
        }
      }

      const latestCommittedStep = committedStepRecords
        .filter((step) => step.step <= activeSkillRecordsStep)
        .toSorted((a, b) => b.step - a.step)
        .find((step) => activeSkillsFromStepMetadata(step.metadata) !== undefined);

      if (latestCommittedStep !== undefined) {
        return {
          status: 'verified',
          records: activeSkillsFromStepMetadata(latestCommittedStep.metadata),
        };
      }

      if (committedStepRecords.some((step) => step.step === activeSkillRecordsStep)) {
        if (isSkillActivationRecordArray(activeSkillRecordsRaw)) {
          return { status: 'verified', records: activeSkillRecordsRaw };
        }
        if (activeSkillRecordsRaw !== undefined && activeSkillRecordsRaw !== null) {
          return { status: 'unverifiable', reason: 'its stored skill records do not deserialize' };
        }
      }

      // No committed step activated a skill: a verified absence.
      return none;
    } catch (error) {
      options.onLog?.({
        workflowId: runId,
        workflowType: 'agentRun',
        timestamp: runtimeServices.clock.now(),
        level: 'warn',
        message: `Unable to verify scheduled fire skill snapshot checkpoint for run "${runId}": ${serializeUnknownError(error)}`,
      });
      return {
        status: 'unverifiable',
        reason: `its checkpoint could not be read: ${serializeUnknownError(error)}`,
      };
    }
  }

  function readSessionSkillSnapshot(
    session: { readonly metadata: Record<string, JSONValue> } | undefined,
    runId: string,
    agentHasSkills = false,
  ): SkillSnapshot {
    if (session === undefined) {
      return { status: 'unverifiable', reason: 'its session is not found' };
    }
    const metadata = session.metadata;
    const recordsRunId = metadata['activeSkillRecordsRunId'];
    const lastRunId = metadata['lastRunId'];
    // Without skills there is no policy to verify, and whatever the session holds is not it.
    if (!skillsConfigured && !agentHasSkills && recordsRunId !== runId)
      return { status: 'verified', records: undefined };
    if (typeof recordsRunId === 'string' && recordsRunId !== runId) {
      return {
        status: 'unverifiable',
        reason: `its snapshot names another run, "${recordsRunId}"`,
      };
    }
    // The start of a run clears the session's snapshot (a null run id), so a cleared one that a
    // later run left is that run's reset, not a record that this run had no skills.
    if (recordsRunId === null && typeof lastRunId === 'string' && lastRunId !== runId) {
      return {
        status: 'unverifiable',
        reason: `a later run, "${lastRunId}", cleared its snapshot`,
      };
    }
    const raw = metadata['activeSkillRecords'];
    if (raw === undefined || raw === null) return { status: 'verified', records: undefined };
    if (!isSkillActivationRecordArray(raw)) {
      return { status: 'unverifiable', reason: 'its stored skill records do not deserialize' };
    }
    return { status: 'verified', records: raw };
  }

  /**
   * Build fresh {@link DurableRunDeps} for a NATIVE WEFT SCHEDULE FIRE (#109).
   *
   * Reached whenever `resolveRunServices` classifies this run as scheduled — a
   * live timer tick (`info.schedule` set), a recovered fire whose
   * `resolveWorkflowServices` info now also carries `info.schedule` (Weft 0.10+
   * derives it from durable schedule metadata on recovery, same as a live
   * tick), or an older-store recovered fire identified only by the persisted
   * `ScheduledAgentRunInput` / `KEYS.scheduleRun(...)` marker. `info.schedule`
   * being set is therefore NOT a reliable live-vs-recovered signal — both cases
   * populate it. Whether this is a *replay* of a fire that already persisted a
   * partial session before crashing is instead read directly off the session:
   * see `isRecoveredFireReplay` below. It builds deps exactly as a fresh
   * `createRun` would, seeding the conversation with the scheduled prompt and
   * using `info.workflowId` (the per-fire id Weft minted) as the runId. The
   * workflow body reads that same id back as `ctx.workflowId`.
   *
   * Session semantics (D6): `sessionId` present → continue that session's
   * conversation (recurring); absent → a fresh per-fire session (stateless cron).
   */
  async function buildScheduledRunServices(
    info: WorkflowServicesResolverInfo,
    store: SessionStore,
    recoveredScheduleMarker?: RecoveredScheduleMarker,
  ): Promise<WorkflowServicesResolution> {
    if (info.workflowType !== 'agentRun' || !isScheduledAgentRunInput(info.input)) {
      return {
        status: 'unavailable',
        reason: `scheduled fire ${info.workflowId} has an unrecognized workflow type or input`,
      };
    }

    const scheduledInput: ScheduledAgentRunInput = info.input;
    if (
      info.schedule === undefined &&
      !hasPersistedScheduleMarker(scheduledInput) &&
      recoveredScheduleMarker?.status !== 'found' &&
      recoveredMarkerSessionId(recoveredScheduleMarker) === undefined
    ) {
      return {
        status: 'unavailable',
        reason: `scheduled fire ${info.workflowId} is missing a persisted schedule marker`,
      };
    }

    const runId = info.workflowId;
    const agentName = scheduledInput.agentName;

    // sessionId present → recurring conversation; absent → fresh per-fire session.
    // The fresh id is derived from the schedule id + per-fire runId so each fire
    // is observable as its own session and two fires never collide.
    const recurring = scheduledInput.sessionId !== undefined;
    const recoveredScheduleId =
      persistedScheduleMarker(scheduledInput) ??
      info.schedule?.id ??
      (recoveredScheduleMarker?.status === 'found'
        ? recoveredScheduleMarker.scheduleId
        : undefined);
    // AB-223: record the correlation the engine-level terminal listener needs
    // to turn this fire's `workflow:completed`/`workflow:failed` into
    // `schedule.completed`/`schedule.failed`. Every reachable branch above
    // that resolves `{ status: 'available' }` has already confirmed a
    // schedule marker exists (the `hasPersistedScheduleMarker`/`info.schedule`/
    // `recoveredScheduleMarker` guard earlier in this function), so
    // `recoveredScheduleId` is defined here in practice; the `undefined` guard
    // is defensive, not a real branch this function's own preconditions
    // permit — dropping the entry rather than recording a bogus correlation.
    if (recoveredScheduleId !== undefined) {
      scheduledFireScheduleIds.set(runId, recoveredScheduleId);
    }
    const existingStatelessSessionId =
      !recurring && recoveredScheduleId === undefined
        ? recoveredMarkerSessionId(recoveredScheduleMarker)
        : undefined;
    const sessionId =
      scheduledInput.sessionId ??
      existingStatelessSessionId ??
      `sched-${recoveredScheduleId ?? 'unknown'}-${runId}`;

    // COR-718 — the fire is recorded, with its owner and its `schedule.fired` entry,
    // before any refusal below: a refused fire is still a fire, and its run is the
    // schedule owner's.
    const scheduleAuthority =
      options.workspace === undefined
        ? undefined
        : await recoverRunWorkspaceAuthority(
            options.workspace,
            scheduledInput.workspaceAuthority,
            scheduledInput.principal,
          );
    if (
      options.workspace !== undefined &&
      (scheduleAuthority === undefined || scheduledInput.authorityHold !== undefined)
    ) {
      if (recoveredScheduleId !== undefined)
        dependencies.onScheduleAuthorityDenied?.(recoveredScheduleId);
      return { status: 'unavailable', reason: 'Workspace authority unavailable.' };
    }
    const owner = scheduleAuthority?.authorizingOwner ?? ownerOrLocal(scheduledInput.principal);
    if (
      options.workspace !== undefined &&
      !(await mayUseAutomationInput(
        scheduledInput.input,
        mediaOptionsFor(owner, 'session').contentSourceResolver,
      ))
    ) {
      if (recoveredScheduleId !== undefined)
        dependencies.onScheduleAuthorityDenied?.(recoveredScheduleId);
      return { status: 'unavailable', reason: 'Automation input unavailable.' };
    }
    await dependencies.onScheduledFire?.({
      runId,
      scheduleId: recoveredScheduleId,
      sessionId,
      agentName,
      owner,
      message: payloadText(scheduledInput.input),
      ...(info.schedule?.manual === true ? { manual: true as const } : {}),
    });

    // COR-323 — a fire runs as a named catalog agent: its own `generate`, tools, stop condition,
    // and instructions. The implicit Bureau-wide agent no longer exists, so a schedule stored under
    // it (or under an agent that has left the catalog) fails its fire with a diagnostic instead of
    // running on something it never named.
    // A composition with no catalog wired (only a direct `createRuntimeComposition` caller has
    // none; `createBureau` always wires one) has no named agents, so the name is a label and the
    // fire runs the composition's own `generate`, as a recovered session run does.
    let fireAgent: SessionAgentRun | undefined;
    // A recovered fire resolves the definition its first attempt recorded (COR-1524).
    const firePriorReference = await dependencies.agentRunReferences?.reference(runId);
    const catalogWiring = await awaitCatalogAgentRunOptionsResolver(runId);
    if (catalogWiring.status !== 'absent') {
      // COR-2105 — the session's taint seeds the agent's guardrails. A reserved id is refused below
      // before anything is read, so it is not read here either.
      const taintSession =
        reservedIdentifierReason('scheduled session', sessionId) === undefined
          ? await store.load(sessionId)
          : undefined;
      const agentResolution =
        agentName === defaultBureauAgentName
          ? undefined
          : await resolveSessionAgentRun(
              agentName,
              runId,
              owner,
              firePriorReference === undefined || firePriorReference.id !== agentName
                ? undefined
                : {
                    agentDefinitionHash: firePriorReference.hash,
                    definitionRevision: firePriorReference.definitionRevision,
                  },
              { sessionId, metadata: taintSession?.metadata },
            );
      if (agentResolution?.status !== 'resolved') {
        return {
          status: 'unavailable',
          reason:
            agentResolution === undefined
              ? `scheduled fire ${info.workflowId} names the implicit agent "${agentName}", which no longer runs: schedule it under a catalog agent`
              : `scheduled fire ${info.workflowId} cannot run agent "${agentName}": ${agentResolution.status}`,
        };
      }
      fireAgent = agentResolution.run;
      if (fireAgent.agentBinding !== undefined && firePriorReference === undefined) {
        await dependencies.agentRunReferences?.record(fireAgent.agentBinding, runId);
      }
    }

    // COR-851: a goal's sessions are the goal's alone. A schedule can name any
    // session (an agent registers one itself through `scheduleSelf`, and one
    // persisted before the reservation existed is still live), and the fire
    // would load that conversation, append to it, and write it back. The id is
    // refused before anything is read.
    const reservedSession = reservedIdentifierReason('scheduled session', sessionId);
    if (reservedSession !== undefined) {
      return {
        status: 'unavailable',
        reason: `scheduled fire ${info.workflowId} names session "${sessionId}", which durable goals own: ${reservedSession}`,
      };
    }

    // Always check for an existing session at this id. A recurring fire
    // continues its stored session; a fresh-per-fire (stateless) session's id
    // embeds this exact runId, so a live (never-before-run) fire finds nothing
    // here and this load is a harmless no-op. It only finds something for a
    // recurring schedule's later fires, or a REPLAY of a fire that already
    // persisted (partially or fully) before this resume — which is exactly the
    // case `isRecoveredFireReplay` below needs to detect.
    const existing = await store.load(sessionId);
    // Defence in depth behind the id check above: a session a goal wrote carries
    // its `goalRunId`, whatever id it sits under, and no schedule fire reads it.
    if (existing !== undefined && existing.metadata['goalRunId'] !== undefined) {
      return {
        status: 'unavailable',
        reason: `scheduled fire ${info.workflowId} names session "${sessionId}", which belongs to a durable goal`,
      };
    }
    // COR-718 — a fire's run is owned by the schedule's owner, and so is the
    // session it creates. A fire into a session another principal owns would write
    // into a conversation its owner never shared, so it is refused, worded as a
    // session that is not there so the schedule owner learns nothing about whose it is.
    if (existing !== undefined && !isSessionAuthorityAuthorized(existing.metadata, owner)) {
      return {
        status: 'unavailable',
        reason: `scheduled fire ${info.workflowId} names session "${sessionId}", which was not found`,
      };
    }
    // COR-323 — a fire runs as its named agent, and a continued session keeps the system prompt
    // of the agent that began it, so a session another agent owns is refused rather than run
    // under instructions that are not the fire's own.
    if (fireAgent !== undefined && existing !== undefined && existing.agentName !== agentName) {
      return {
        status: 'unavailable',
        reason: `scheduled fire ${info.workflowId} runs agent "${agentName}" but session "${sessionId}" belongs to agent "${existing.agentName}"`,
      };
    }
    // The session's own metadata — not `info.schedule` — is the source of
    // truth for "have we already run this exact fire": `info.schedule` is
    // populated on BOTH a live tick and a recovered one, so it cannot
    // distinguish a fresh fire from a replay of one that crashed mid-flight.
    // A match here means this runId already wrote to this session, so its
    // transcript (and any committed active-skills snapshot) belongs to a
    // stale, partial attempt that must be cleaned before replay re-appends.
    const isRecoveredFireReplay = existing?.metadata['lastScheduledFireRunId'] === runId;
    // COR-1482: a session that already exists has its incarnation now; a fresh one gets it when
    // the fire first saves it (below).
    if (existing !== undefined) {
      await reportScheduledSession({ runId, sessionId, incarnation: existing.incarnation });
    }
    let conversation: Conversation;
    if (existing) {
      conversation = new Conversation(
        isRecoveredFireReplay
          ? removeLastScheduledFireTranscript(existing.conversationHistory, runId)
          : existing.conversationHistory,
      );
    } else {
      conversation = new Conversation(createConversationHistory({ id: sessionId }));
      const firePrompt = fireAgent?.instructions ?? systemPrompt;
      if (firePrompt) {
        conversation.appendSystemMessage(firePrompt);
      }
    }
    const baseConversationHistory = conversation.current;
    appendAgentInput(conversation, scheduledInput.input, { scheduledFireRunId: runId });

    // Same runtime a normal run builds (generate/toolbox/memory/skills/guardrails),
    // wired to this fire's session + per-fire runId, with live streaming off (no
    // ActiveRun surface for a scheduled fire).
    // COR-1620: a replay is decided under the snapshot it can verify. One it cannot, and a stored
    // skill the catalog refuses, leave the replay without tools and without a snapshot write.
    const skillSnapshot = await readCommittedScheduledSkillSnapshot(
      existing,
      runId,
      isRecoveredFireReplay,
      agentSkillsRun(fireAgent?.options.hooks) !== undefined,
    );
    const initialActiveSkillRecords =
      skillSnapshot.status === 'verified' ? skillSnapshot.records : undefined;
    const schedulerContext = createSchedulerServiceRequestContext(runId, agentName, sessionId);
    const requestContext: ToolRequestContext =
      scheduleAuthority === undefined
        ? schedulerContext
        : {
            ...schedulerContext,
            authority: { ...schedulerContext.authority, workspace: scheduleAuthority },
          };

    // COR-1546 — the fire's run writes into the schedule owner's memory, not the scheduler's.
    const runRuntime = await createRunRuntime(
      { message: payloadText(scheduledInput.input), sessionId, runId, agentName, requestContext },
      {
        initialActiveSkillRecords,
        skillPolicyUnverifiable: skillSnapshot.status === 'unverifiable',
        memoryOwner: owner,
        sessionMetadata: existing?.metadata,
        sessionAgent: fireAgent,
        admitDispatch:
          options.workspace === undefined || recoveredScheduleId === undefined
            ? undefined
            : async () => {
                let admitted = false;
                try {
                  const current = workflowScheduleBinding(
                    await storedScheduleInput(durable!.engine, recoveredScheduleId),
                  );
                  admitted =
                    current.authorityHold === undefined &&
                    current.workspaceAuthority?.actorId === scheduleAuthority?.actorId;
                } catch {
                  // Unreadable or malformed durable authority must request the same pause.
                }
                if (!admitted) dependencies.onScheduleAuthorityDenied?.(recoveredScheduleId);
                return admitted;
              },
      },
    );
    const skillRecovery = await runRuntime.skillsRecovered;
    if (skillSnapshot.status === 'unverifiable' || skillRecovery.refused.length > 0) {
      options.onLog?.({
        workflowId: runId,
        workflowType: 'agentRun',
        timestamp: runtimeServices.clock.now(),
        level: 'warn',
        message: `Schedule fire "${runId}" replays without tools: its skill policy cannot be verified (${
          skillSnapshot.status === 'unverifiable'
            ? skillSnapshot.reason
            : `a stored skill was refused on recovery: ${skillRecovery.refused.join(', ')}`
        }).`,
      });
    }

    // COR-1596: a fire is offered `requestHumanInput` exactly as a `bureau.run()` run is, so a
    // scheduled agent can ask for an answer it will wait for. The tool parks through the services
    // object returned below, so that object is captured once it exists, as the recovery of a
    // catalog run captures it.
    const humanInputServices: { current?: DurableRunDeps } = {};
    // COR-1709: a fire is offered `decide` as it is offered `requestHumanInput`, as its owner.
    // COR-1710 — the grant recorded on the fire's task when it was first admitted.
    const fireGrant = grantedTools(await dependencies.toolGrantFor?.(runId), options);
    const fireDecide =
      durable === undefined ? undefined : dependencies.decideToolFor?.(owner, fireGrant.decide);
    const fireToolbox =
      (fireGrant.humanInput && durable !== undefined) || fireDecide !== undefined
        ? wireDurableOptInTools(runRuntime.toolbox, humanInputServices, {
            humanInput: fireGrant.humanInput && durable !== undefined,
            inputSchemas: fireGrant.inputSchemas,
            wakeup: false,
            runId,
            ...(fireDecide === undefined ? {} : { decide: fireDecide }),
            humanInputEmitter: {
              dispatchEvent: (event: Event) => {
                const target = humanInputServices.current?.emitter;
                return hasDispatchEvent(target) ? target.dispatchEvent(event) : false;
              },
            },
          })
        : runRuntime.toolbox;
    if (isRecoveredFireReplay) {
      recordRecoveredSkillPolicy(fireToolbox, {
        scheduledFire: true,
        agentName,
        sessionAgent: fireAgent,
        recordsKey: JSON.stringify(initialActiveSkillRecords ?? []),
        recoveredCleanly: skillSnapshot.status === 'verified' && skillRecovery.refused.length === 0,
      });
    }
    const services: DurableRunDeps = {
      toolbox: fireToolbox,
      // An unverified policy keeps the snapshot the committed steps already hold.
      getStepMetadata: () =>
        runRuntime.skillPolicyUnverified()
          ? {}
          : {
              [activeSkillsStepMetadataKey]: activeSkillsStepMetadata(
                runRuntime.getActiveSkillRecords(),
              ),
            },
      options: {
        generate: runRuntime.generate,
        toolbox: fireToolbox,
        conversation,
        // COR-2106 — children this run dispatches carry Bureau's tier.
        ...bureauInvariantsField(bureauChildInvariants),
        ...scheduledAgentRunOptions(fireAgent?.options, requestContext),
        ...sessionRunMediaOptions(fireAgent, mediaOptionsFor(owner, 'session')),
        maximumSteps: fireAgent?.options.maximumSteps ?? maximumSteps,
        stopWhen: fireAgent?.options.stopWhen ?? options.stopWhen,
        // AB-260: the bureau's single composed RuntimeServices instance,
        // snapshotted into every run it starts — including a scheduled fire.
        runtime: runtimeServices,
        // The session write-back runs AFTER the runtime's own onStep hooks so
        // recurring fires accumulate and a stateless fire is observable.
        // COR-1269 — stamped onto this run's hook-plan observations.
        sessionId,
        // COR-1265 criterion 8 — merged AFTER the trailing registration, so the
        // Bureau tier is complete before it becomes the merge's `bureau` tier
        // and the trailing hook is offset with every other Bureau entry rather
        // than beside them at a raw priority.
        hooks: composeHooks({
          bureau: registerTrailingOnStep(
            runRuntime.hooks,
            'bureau:scheduled-session-write-back',
            createScheduledSessionPersistHook(
              store,
              sessionId,
              agentName,
              baseConversationHistory,
              runId,
              isRecoveredFireReplay,
              runRuntime.getActiveSkillRecords,
              runRuntime.skillPolicyUnverified,
              owner,
              requestContext,
            ),
          ),
          agent: fireAgent?.options.hooks,
        }),
        agentName,
        runId,
      },
    };

    humanInputServices.current = services;
    // Scheduled fires have no interactive ActiveRun surface. The recovery hook
    // monitors them without attaching live event forwarding.
    await reportScheduledServices({ runId, sessionId, agentName, requestContext }, services);
    return { status: 'available', services };
  }

  /**
   * Weft's `resolveWorkflowServices` resolver: re-provide a recovered run's deps
   * on a fresh-process resume. Weft fires it (per recovered inline run that was
   * launched with `services`) BEFORE the generator advances, passing the run's
   * `workflowId` — which equals our `runId`, since `engine.start` pins
   * `{ id: runId }`. Finds the owning `running` session, rebuilds its deps, and
   * returns `{ status: 'available', services }`; a run with no reconstructable
   * session returns `{ status: 'unavailable' }`, which fails just that one run
   * (terminal `failed`) without aborting recovery or the engine.
   *
   * When the owning session exists and is `running` but its deps cannot be rebuilt
   * here (`buildRunDepsFromSession` throws — e.g. no `generate` configured on this
   * process), it best-effort reconciles that session to `error` before returning
   * unavailable, so the session metadata is not left stuck `running` for a run the
   * engine is about to fail. This is the resolver's one write; it is keyed on the
   * session it just loaded (no race) and swallowed on failure.
   *
   * Idempotent: once a session is reconciled to `error`, the `=== 'running'`
   * predicate above no longer matches it on a later boot, so it falls through to
   * the no-running-session return and is never re-failed or re-written.
   */
  async function resolveRunServices(
    info: WorkflowServicesResolverInfo,
  ): Promise<WorkflowServicesResolution> {
    // The engine's background tasks are armed at engine construction, before this closure's later
    // dependencies (sessionStore, createRunRuntime deps) are initialized. A tick or a reclaim that
    // reaches this resolver mid-construction waits for the composition instead of being answered
    // "unavailable", which the engine would turn into a terminal failure of the run. (Reading a
    // not-yet-initialized `const` below would otherwise throw a TDZ error.)
    if (!compositionOpen) {
      diagnose({
        level: 'warn',
        scope: 'recovery',
        message:
          `[bureau] Run "${info.workflowId}" reached recovery before the bureau finished ` +
          `composing; holding it until composition completes.`,
      });
    }
    try {
      await readiness.promise;
    } catch {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId}: composition failed`,
      };
    }
    // COR-1527: an instance of a workflow file runs the interpreter, which reads no services.
    if (dependencies.isWorkflowFileType?.(info.workflowType) === true) {
      return { status: 'available', services: undefined };
    }
    if (!sessionStore) {
      return { status: 'unavailable', reason: 'no session store configured' };
    }
    // AB-240: `bureau.run()`'s durable catalog dispatch persists its OWN
    // recovery record (agent name + a stable definition revision + the
    // original input), keyed by workflowId, entirely independent of
    // `sessionStore`'s lastRunId/lastRunStatus correlation — a catalog run
    // deliberately never owns a bureau session. Check for it FIRST: when
    // present it is authoritative and bypasses every guard below (scheduler
    // origin, session ownership), none of which apply to a catalog run.
    const catalogRecovery = await loadCatalogRunRecoveryRecord(info.workflowId);
    if (catalogRecovery.status === 'read-error') {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId}: catalog recovery record unreadable`,
      };
    }
    if (catalogRecovery.status === 'found') {
      // AB-241 review finding: cache the successfully decoded record so
      // `classifyCatalogRecoveredRun` (called from `onRecoveredWorkflow`,
      // always AFTER this resolver for the same workflow) reuses this exact
      // read instead of issuing its own independent one.
      catalogRunRecoveryCache.set(info.workflowId, catalogRecovery.record);
      return resolveCatalogAgentRunServices(info.workflowId, catalogRecovery.record);
    }
    // NATIVE SCHEDULED FIRE (#109/#126): Weft sets `info.schedule` for a live
    // schedule tick, and (Weft 0.10+) also derives it from durable schedule
    // metadata when re-providing services on recovery — so `info.schedule` alone
    // does not distinguish live from recovered. Some recovered fires (older
    // stores, or a schedule whose metadata could not be resolved) may only carry
    // the persisted ScheduledAgentRunInput, so recovery must also check the
    // persisted schedule marker written by createAgentSchedule(); the broad
    // `{ agentName, input }` shape alone is not enough to bypass the interactive
    // session-ownership guards below.
    let recoveredScheduleMarker =
      info.schedule === undefined &&
      isScheduledAgentRunInput(info.input) &&
      !hasPersistedScheduleMarker(info.input)
        ? await loadScheduleIdForRecoveredRun(info.workflowId)
        : undefined;
    if (
      recoveredScheduleMarker !== undefined &&
      recoveredScheduleMarker.status !== 'found' &&
      isScheduledAgentRunInput(info.input)
    ) {
      try {
        const sessionId = await loadExistingScheduledSessionId(
          sessionStore,
          info.input,
          info.workflowId,
        );
        if (sessionId !== undefined)
          recoveredScheduleMarker = { ...recoveredScheduleMarker, sessionId };
      } catch (error) {
        diagnose({
          level: 'error',
          scope: 'recovery',
          message: `[bureau] Could not inspect scheduled session proof for recovered run "${info.workflowId}"; continuing without scheduled-fire classification: ${serializeUnknownError(error)}`,
        });
      }
    }
    if (
      info.schedule !== undefined ||
      (isScheduledAgentRunInput(info.input) &&
        (hasPersistedScheduleMarker(info.input) ||
          recoveredScheduleMarker?.status === 'found' ||
          recoveredMarkerSessionId(recoveredScheduleMarker) !== undefined))
    ) {
      return buildScheduledRunServices(info, sessionStore, recoveredScheduleMarker);
    }
    // The owning session id rides in the run's durable input (Weft passes the
    // persisted `input` to the resolver on recovery — see #2), so load the
    // session DIRECTLY by id, with no `sessionStore.list()` scan or
    // lastRunId/lastRunStatus correlation. A run whose input predates the
    // sessionId field (or is not an agentRun) fails the guard and is treated as
    // not-reconstructable — no compatibility fallback for cross-upgrade runs.
    if (!isAgentRunWorkflowInput(info.input)) {
      return { status: 'unavailable', reason: `run ${info.workflowId} has no recoverable session` };
    }
    // SCHEDULER-ORIGIN GUARD (#25, #44): Weft 0.7 includes launch metadata in
    // WorkflowServicesResolverInfo, so new scheduler-origin runs discriminate by
    // their explicit launch tag instead of the old synthetic-input shape. Keep
    // the prefix check only as legacy cleanup for persisted scheduler runs
    // created before resolver launch context was available.
    const schedulerOriginByLaunchTag =
      info.launchOptions?.tags?.includes(SCHEDULER_ORIGIN_TAG) ?? false;
    const legacySchedulerOriginBySyntheticInput =
      info.input.sessionId === info.input.runId &&
      info.input.runId.startsWith(SCHEDULER_RUN_ID_PREFIX);
    if (schedulerOriginByLaunchTag || legacySchedulerOriginBySyntheticInput) {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId} is scheduler-origin (no session to recover)`,
      };
    }
    // CORRELATION GUARD (committee MF-5): the workflow id IS the run id (pinned at
    // engine.start), so the input's own runId must match. A mismatch means a
    // corrupt or crafted durable input is trying to correlate this run to a
    // foreign session — fail closed (no session load, no reconcile write) rather
    // than rebuild deps for / write to a session the input doesn't legitimately own.
    if (info.input.runId !== info.workflowId) {
      return { status: 'unavailable', reason: `run ${info.workflowId} input runId mismatch` };
    }
    const sessionId = info.input.sessionId;
    const session = await sessionStore.load(sessionId);

    // The session must still OWN this run AND be IN-FLIGHT (its `lastRunId`
    // matches the workflow id AND `lastRunStatus` is `running`) before we rebuild
    // its deps (committee/Bugbot review: recovery skips session-run ownership).
    // The status check is load-bearing, not just symmetric with the post-recover
    // gate in create-bureau: the resolver fires DURING `recoverAll()` and resuming
    // a run whose session already says `completed`/`error` would let it advance
    // (model/tool SIDE EFFECTS) before the post-recover gate could cancel it —
    // too late. A durable input pointing at a session owning a DIFFERENT run, or
    // at an already-terminal session, fails closed with NO session write.
    if (
      !session ||
      session.metadata['lastRunId'] !== info.workflowId ||
      session.metadata['lastRunStatus'] !== 'running'
    ) {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId} not owned by a running session`,
      };
    }

    const recoveredAuthority = recoveredRequestContext(
      session.metadata,
      info.workflowId,
      sessionId,
      info.input.agentName,
      runtimeServices.clock.now,
    );
    if (!recoveredAuthority) {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId} request authority is unavailable during recovery`,
      };
    }
    const recoveredAuthorizationRevision = recoveredAuthority.authority.authorizationRevision;
    const requiresTransportValidation =
      options.workspace !== undefined ||
      (recoveredAuthorizationRevision !== 'bureau:1' &&
        recoveredAuthorizationRevision !== 'bureau:scheduler:1');
    if (requestAuthorityValidator === undefined && requiresTransportValidation) {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId} authority cannot be revalidated during recovery`,
      };
    }
    if (
      requiresTransportValidation &&
      requestAuthorityValidator &&
      !(await requestAuthorityValidator(recoveredAuthority))
    ) {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId} authority is no longer current`,
      };
    }

    let services: DurableRunDeps;
    try {
      // info.workflowId === the run id (pinned at engine.start) — thread it so the
      // recovered run's memory-persist idempotency key matches its pre-crash key.
      // info.input.agentName is guaranteed non-empty here: isAgentRunWorkflowInput
      // requires a non-empty string (the guard returned earlier if it's missing).
      services = await buildRunDepsFromSession(session, info.workflowId, info.input.agentName);
    } catch (error) {
      // The session exists, but its deps cannot be rebuilt on this process (e.g.
      // no `generate`/provider configured here, so `createRunRuntime` throws).
      // Weft will fail this run terminally pre-replay; the reattached handle then
      // rejects and its adapter stays write-free — so without this reconcile the
      // session would be left stuck `running`. We have the sessionId in hand, so
      // reconcile it to `error` synchronously on the boot path (not a racy
      // detached write).
      const reason = error instanceof Error ? error.message : String(error);
      unrebuildableRecoveredRuns.add(info.workflowId);
      // COR-1911 — a tried agent lives in memory and nowhere else, so a restart loses it and its
      // run cannot be rebuilt. The recovery report lists the run; this names why.
      if (isTryAgentName(info.input.agentName)) {
        diagnose({
          level: 'warn',
          scope: 'agent-try',
          message: `[bureau] Run "${info.workflowId}" (session ${sessionId}) of a tried agent cannot be recovered: try agent not reconstructable after restart. The agent was held in memory only; delete the chat.`,
          cause: error,
        });
      }
      try {
        await sessionStore.updateMetadata(sessionId, {
          lastRunStatus: 'error',
          lastFinishReason: 'error',
          lastError: `Recovered run could not be reconstructed: ${reason}`,
        });
      } catch (writeError) {
        // Reconciliation is best-effort — a failed write must not abort the rest
        // of recovery — but it is NOT silent: a session left stale `running`
        // cannot be repaired by a later boot (the run is already terminal
        // `failed` and is skipped), so surface it for operators.
        diagnose({
          level: 'error',
          scope: 'session-persistence',
          message:
            `[bureau] Failed to reconcile unrecoverable run "${info.workflowId}" ` +
            `(session ${sessionId}) to error: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
        });
      }
      return { status: 'unavailable', reason: `run ${info.workflowId} not reconstructable` };
    }
    // `services` is never null here: the owning-session check above already
    // guarantees a non-null `session`, and `buildRunDepsFromSession` only
    // returns null for a null session — so its return type's `| null` is a
    // defensive contract for OTHER callers (this file's own
    // `resolveCatalogAgentRunServices` and `buildScheduledRunServices` never
    // call it; a future caller might), not a branch reachable from here. A
    // dead `if (services === null)` fail-closed used to guard this anyway,
    // covered only by forcing it through a private mutation seam (AB-260
    // retired both).
    return { status: 'available', services };
  }

  // Every closure dependency the resolver reads is now initialized; open the gate
  // so scheduler-poller ticks (and the bureau's subsequent `recoverAll()`) resolve.
  compositionOpen = true;
  readiness.resolve();

  const composition: RuntimeComposition = {
    kv,
    secretAnswers,
    durable,
    workflowVersionMismatches,
    unrebuildableRecoveredRuns,
    scheduleFireEvents,
    skillEvents,
    stopUsingStorage: () => storageFence?.close(),
    durableStorage,
    memory,
    sessionStore,
    // Exposed so the review queue (`reviews.resolve`) can call `resumeApproval()`
    // on the SAME toolbox instance (or any `.extend()` clone of it, which
    // preserves `approvalSecret` — see armorer's `extend()`) that executed the
    // original tool call. `resumeApproval` re-invokes the tool by name/callId,
    // so any toolbox sharing this instance's `approvalSecret` and tool set can
    // resume a signed pending approval, not only the specific per-run clone.
    baseToolbox,
    withChatPermission: governedByChat,
    holdToModelPolicy,
    setRequestAuthorityValidator(validator) {
      requestAuthorityValidator = createRunAuthorityValidator(options.workspace, validator);
    },
    setCatalogAgentRunOptionsResolver(resolver) {
      catalogAgentRunOptionsResolver = resolver;
      if (resolver !== undefined) openCatalogResolverGate();
    },
    abandonCatalogAgentRunOptionsResolver(reason) {
      if (dependencies.awaitsCatalogAgentRunOptionsResolver !== true) return;
      catalogResolverAbandonedReason ??= reason;
      openCatalogResolverGate();
    },
    persistCatalogRunRecoveryRecord,
    claimCatalogRunRecoveryRecord,
    loadCatalogRunRecoveryRecord,
    deleteCatalogRunRecoveryRecord,
    fenceGoalAttemptRecoveryRecord,
    isCatalogRecoveredRun,
    classifyCatalogRecoveredRun,
    clearCatalogRunRecoveryCache,
    mediaOptionsFor,
    ready: options.generate !== undefined,
    maximumSteps,
    systemPrompt,
    createRunRuntime,
    // AB-260: folded onto the returned object directly — see the interface's
    // own doc comments for why these are genuine capabilities of this
    // composition rather than test-only introspection.
    resolveRunServices,
    buildScheduledRunServices,
    readCommittedScheduledSkillSnapshot,
    readSessionSkillSnapshot,
    createBureauInvariantHooks,
    bureauChildInvariants,
    composeRunHooks: composeHooks,
    sessionTaintSeam: sessionTaintSeamFor,
    pendingScheduledTaintCount: () => pendingScheduledTaints.size,
    resolveSessionAgentRun,
  };

  return composition;
}
