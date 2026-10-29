import type { BureauWorkflows } from './workflow-runtime';
import type {
  EventIteratorOptions,
  EventObservableOptions,
  ObservableLike,
  Observer,
  RuntimeServices,
  Subscription,
} from '@lostgradient/lifecycle';
import type { GovernedMemory, MemoryCapability } from '@lostgradient/memory';
import type {
  AgentRunEventRegistry,
  AgentSession,
  CacheOptions,
  ChildSignalContract,
  CleanupAcknowledgement as RunCleanupAcknowledgement,
  CreateRunEngineOptions,
  DurableEventEnvelope,
  DurableEventGap,
  DurableEventOwner,
  DurableEventPage,
  EnhancedStreamingOptions,
  FlowControlPolicy,
  FreshAttemptSourceResolver,
  HumanInputSchema,
  LivenessSnapshot,
  PeerCallJournal,
  RunEvent,
  RunFrame,
  RunResult,
  SessionInputAdmissionOutcome,
  SessionInputAdmissionRequest,
  SessionInputPayload,
  SessionListOptions,
  SessionStore,
  SessionSummary,
  Store,
  TokenUsage,
  Validator,
} from '@lostgradient/operative';
import type { SkillActivationRecord, SkillCatalogRevision } from './skills';
import type {
  TaskCancelOutcome,
  TaskListPage,
  TaskListQuery,
  TaskRegistry,
  TaskView,
} from './task-registry';
import type { InteractiveSurfaces } from './interactive-surface/store';
import type { ToolPolicy } from 'armorer/protocol';
import type { AgentSource, WorkflowSource } from './sources/definition-source';
import type { ConditionalTextValueStore, Storage, TextValueStore } from '@lostgradient/storage';
import type {
  ListFilter,
  ListOptions,
  ObservabilityOptions,
  PaginatedResult,
  RegistryAgnosticEngine,
  ScheduleFilter,
  ScheduleSummary,
  StorageConfiguration,
  WorkflowLogRecord,
  WorkflowState,
  WorkflowSummary,
} from '@lostgradient/weft';
import type { PendingToolApproval, SignedPendingToolApproval, ToolRequestContext } from 'armorer';
import type { ConversationHistory, Message, MultiModalContent } from 'conversationalist';

import type {
  AgentDefinitions,
  AgentHasOutput,
  AgentNames,
  AgentOutput,
  BureauAgentCatalog,
} from './agent-catalog';
import type { BureauAssetOptions } from './assets/asset-service';
import type { McpResourceReader } from './assets/content-source-resolver';
import type { AssetService } from './assets/types';
import type { AuditRetentionOption, AuditTrail, CheckpointRetentionOption } from './audit-trail';
import type { BureauEventFeed } from './bureau-event-feed.ts';
import type { RunCreationReceipt, RunCreationReceiptLocation } from './command-ledger';
import type { BureauChildDelegationOptions, BureauChildren } from './child-topology';
import type {
  DurableEventHistoryPageOptions,
  DurableEventHistorySubscribeOptions,
} from './durable-event-history';
import type { BureauEventMap } from './events';
import type { BureauGoals } from './goal-types';
import type { BureauModelPolicyOptions } from './model-policy';
import type { BureauDecisions, DecisionsOptions } from './decisions/types';
import type { BureauSettings, SettingsOptions } from './settings/types';
import type { Models, ModelsOptions } from './models/create-models';
import type { OnlineEvalSampler, OnlineEvalSamplerOptions } from './online-evals';
import type { ForkSessionRequest, ForkSessionResult } from './session-fork';
import type {
  SessionSteeringState,
  SteeringCommandAdmissionOutcome,
  SteeringCommandRequest,
} from './steering';
import type { WebhookNotifier, WebhookNotifierOptions } from './webhook-notifier';

// ── Provider Configuration ───────────────────────────────────────────

/**
 * The subset of operative's `ProviderName` union that `createRuntimeComposition`
 * can resolve to a generative (text/tool-call) backend. `voyage` and `ollama`
 * exist in `ProviderName` but are embedding-only — no generate factory exists for
 * them, so accepting them here would produce a runtime "Unknown provider" error
 * that TypeScript could have caught.
 */
export type GenerateProviderName = 'anthropic' | 'openai' | 'gemini';

export interface ProviderConfiguration {
  provider: GenerateProviderName;
  model: string;
  maximumTokens?: number;
  temperature?: number;
  apiKey?: string;
}

export interface ProviderRouteConfiguration {
  name: string;
  provider: ProviderConfiguration;
  budgetRatio?: number;
}

export type RoutingConfiguration =
  | {
      type: 'step-based';
      first: string;
      middle: string;
      last?: string;
      middleAfterStep?: number;
    }
  | {
      type: 'complexity';
      simple: string;
      complex: string;
      frontier?: string;
      simpleMaxTools?: number;
      simpleMaxLength?: number;
    }
  | {
      type: 'cost-aware';
      cheap: string;
      expensive: string;
      budget: number;
      thresholdRatio?: number;
    };

export interface IdentityConfiguration {
  resolve: () => Promise<string>;
  warn?: (message: string) => void;
}

export interface SkillRuntimeConfiguration {
  /**
   * An already-discovered catalog revision (COR-889).
   *
   * Omit it and the bureau discovers the skills its own persistence store holds, through the
   * `storage` source. That is the only discovery Bureau does on a caller's behalf: the store is
   * already the bureau's, and what is in it is what this runtime itself persisted. Reading
   * filesystem roots or remote registries means deciding which of them to trust, which COR-752's
   * Decision 1 puts on the host — so a caller that wants those discovers them and hands in the
   * result.
   *
   * A *revision*, not a set of sources, because it is an immutable input to a run: a caller that
   * hands one in has already decided which generation this run sees, and the catalog cannot move
   * underneath it mid-conversation.
   */
  catalog?: SkillCatalogRevision;
  includeTools?: boolean;
  skillPolicy?: ToolPolicy;
}

export type { FlowControlPolicy, SkillActivationRecord, SkillCatalogRevision, ToolPolicy };

export interface SkillCatalogEntry {
  name: string;
  description: string;
}

export interface LoadedSkill {
  metadata: {
    name: string;
    description: string;
    toolPolicy?: ToolPolicy;
  };
  body: string;
}

export interface SkillProvider {
  listSkills(): Promise<SkillCatalogEntry[]>;
  loadSkill(name: string): Promise<LoadedSkill | undefined>;
  saveSkill?(name: string, skill: LoadedSkill): Promise<void>;
  deleteSkill?(name: string): Promise<void>;
  listResources(name: string): Promise<string[]>;
  /**
   * Loads a resource as raw bytes.
   *
   * Bytes, not text, because a skill bundle carries images, fonts and other binary assets, and
   * decoding one as UTF-8 corrupts it irreversibly. Decoding happens at the model-facing tool,
   * which is the only place text is actually required.
   */
  loadResource(name: string, path: string): Promise<Uint8Array | undefined>;
  isEnabled(name: string): Promise<boolean>;
}

export interface CacheConfiguration extends Omit<CacheOptions, 'store'> {
  enabled?: boolean;
  store?: TextValueStore;
}

export interface StreamingConfiguration extends Pick<EnhancedStreamingOptions, 'onTextDelta'> {
  enabled?: boolean;
}

// ── Diagnostics ──────────────────────────────────────────────────────

/**
 * A single operational diagnostic emitted by bureau internals — recovery
 * failures, live-frame listener exceptions, dispose errors, and persistence
 * failures. Distinct from {@link BureauOptions.onLog}: `onLog` carries
 * only replay-safe `ctx.log` records emitted BY durable workflow code, while
 * `BureauDiagnostic` covers bureau's own operational logging — the sites
 * that today write straight to `console.error`/`console.warn`.
 */
export interface BureauDiagnostic {
  level: 'warn' | 'error';
  /**
   * The subsystem the diagnostic originated from, e.g. `'recovery'`,
   * `'live-frames'`, `'dispose'`, `'webhook'`, `'audit-trail'`, or
   * `'session-persistence'`.
   */
  scope: string;
  message: string;
  cause?: unknown;
}

/** Sink for {@link BureauDiagnostic} events. See {@link BureauOptions.onDiagnostic}. */
export type DiagnosticSink = (diagnostic: BureauDiagnostic) => void;

// ── Bureau (headless, no HTTP) ──────────────────────────────────────

/**
 * COR-41 — how Bureau derives each run's memory authority. The chain is Bureau
 * (a `service:bureau` link holding `runCapabilities`), then the request's
 * persisted principal, then the run. A request authority that names explicit
 * `memory:*` capabilities can only narrow `runCapabilities`; one that names
 * none receives them unchanged. A run with no persisted request authority gets
 * no memory hooks at all.
 */
export interface BureauMemoryAuthorityOptions {
  /**
   * Defaults to `['memory:search', 'memory:write']`. `[]` does not detach the
   * memory hooks: every run's recall and write are refused as
   * `missing-capability`, and each refusal is recorded as a
   * `memory.access.denied` event and passed to `onEvent`. Leave
   * {@link BureauOptions.memory} unset to attach no memory hooks.
   */
  readonly runCapabilities?: readonly MemoryCapability[];
  /** Recorded on every memory operation. Defaults to `'conversation-memory'`. */
  readonly purpose?: string;
}

/**
 * COR-1477 — how long a kind of history is kept: `'forever'`, or
 * `{ olderThan: milliseconds }` on the runtime clock.
 */
export type RetentionWindowOption = 'forever' | { readonly olderThan: number };

/**
 * COR-1674, COR-1700 — the shape of {@link BureauOptions.humanInput}: `false` removes
 * `requestHumanInput`; the object form keeps it and supplies the answer schema per signal name.
 * `true` is refused with `BAD_REQUEST`, because the tool is already the default.
 */
export type BureauHumanInputOption =
  false | { readonly inputSchemas?: Readonly<Record<string, HumanInputSchema>> | undefined };

/**
 * COR-1701 — the retention windows {@link BureauOptions.retention} groups. Each field is optional and
 * keeps the meaning and default it had as a flat option.
 */
export interface BureauRetentionOptions {
  /**
   * AB-388: retention policy for the durable audit trail
   * ({@link Bureau.auditTrail}). Defaults to `'forever'` — unbounded,
   * exactly today's behavior — so a long-lived deployment must opt in
   * before any postmortem evidence is ever removed.
   *
   * `{ olderThan: milliseconds }` prunes any audit record older than that
   * many milliseconds by the runtime clock, but never a record newer than
   * the Weft fleet feed's own retention floor — audit evidence always
   * outlives the durable events it describes, even when `olderThan` would
   * otherwise have allowed pruning it sooner. Pruning runs inside the
   * existing durable maintenance pass: {@link Bureau.maintain}
   * for a `'manual'` host's own alarm/Cron trigger, and — under the
   * default `'automatic'` profile — the same background interval that
   * already prunes stale run ownership (AB-374). It is never driven on a
   * separate schedule of its own.
   *
   * Each pass that actually prunes something writes exactly one
   * `audit.pruned` record into the trail itself, naming the count and the
   * effective cutoff, and persists the highest pruned sequence so a
   * restart's boot-time sequence scan
   * ({@link computeInitialAuditSequence}) never reissues a value a pruned
   * record already used.
   */
  audit?: AuditRetentionOption;
  /**
   * COR-625: checkpoint-retention policy applied by the terminal-run cleanup
   * step. Defaults to `'keep-all'` — unbounded, exactly today's behavior —
   * so a long-lived deployment must opt in before any checkpoint history is
   * ever pruned.
   *
   * `{ keepLast }` must be a positive integer, and `timeoutMilliseconds`, when
   * supplied, a finite non-negative number; otherwise `createBureau` throws
   * `BureauError(..., 'BAD_REQUEST')`.
   *
   * On every terminal transition of a durable run — completion, error, abort,
   * or a durable cancel through {@link BureauTasks.cancel} — bureau runs exactly ONE cleanup step
   * for that run, however many of those triggers fire. The step re-reads the
   * run's durable record first and prunes only once the engine reports a
   * terminal status, so a checkpoint can never be pruned ahead of the
   * transition it belongs to.
   *
   * The step's own acknowledgement is written to the audit trail as one
   * `run.cleanup-settled` record. It also folds into the run's `closed()`,
   * but only ever DOWNGRADES it: a step that prunes cleanly (or has nothing
   * to prune) leaves a `completed` run `completed`, while a step that fails
   * or cannot be resolved surfaces in its place. Has effect only when a
   * durable engine is composed.
   */
  checkpoints?: CheckpointRetentionOption;
  /**
   * COR-424 — how long a run-creation request id stays bound to its run after
   * the run settles, in milliseconds: a positive integer, default 86400000
   * (24 hours, the same as Weft's mailbox `terminalRetentionMs`). Measured on
   * the runtime clock from the run's terminal action; a run that settled
   * before a restart and was not reattached is measured from when the ledger
   * first observes it settled. A run still in progress holds its binding.
   * Once the window has passed, {@link BureauTasks.receipt}
   * reports `expired`, the same request id creates a new run, and durable
   * maintenance deletes the binding. `createBureau` throws
   * `BureauError(..., 'BAD_REQUEST')` for any other value.
   */
  receipts?: BureauReceiptRetentionOption | undefined;
  /**
   * COR-1477 — how long the durable event history keeps an event, measured
   * from when it was emitted on the runtime clock. Default
   * `{ olderThan: 604800000 }` (7 days); `'forever'` keeps every event. Each
   * durable maintenance pass advances the fleet feed's retention floor past
   * the events older than the window (`FleetEventFeed.retain()`), so the
   * history is bounded. A reader that resumes from a cursor below the new
   * floor receives one gap event instead of a silent skip, and an open
   * subscription the floor overtakes receives it too. The audit trail's own
   * {@link BureauRetentionOptions.audit} never prunes a record the retained
   * history still describes, so a shorter event window lets audit pruning
   * proceed no further than its own setting allows. Has effect only where a
   * persistent durable event history is composed. `olderThan` must be a
   * finite, non-negative number; otherwise `createBureau` throws
   * `BureauError(..., 'BAD_REQUEST')`.
   */
  events?: RetentionWindowOption;
  /**
   * COR-1477 — how long a terminal task (a run that completed, errored, or was
   * aborted) is kept, measured on the runtime clock from its closing
   * `run.completed` or `run.aborted` action (`run.error` is followed by
   * `run.completed`, so it does not start the window). Default
   * `{ olderThan: 2592000000 }` (30 days); `'forever'` keeps every task.
   * Durable maintenance removes a terminal task older than the window through
   * the run store, so Bureau's existing `run.removed` event fires for it and
   * everything keyed on the task releases its own state; deleting a task is
   * also what eventually releases a withdrawn agent's tombstone mount. A
   * running task, and a terminal one not yet older than the window, is never
   * removed. Only tasks in this process's run store are candidates, so a
   * terminal run from before a restart is not removed. The pass runs from
   * {@link Bureau.maintain} and from the automatic maintenance timer,
   * which starts only for a durable bureau or one with KV-backed audit
   * retention; an ephemeral bureau with neither keeps its terminal tasks until
   * something calls `maintain`. A task is also kept for as long as its run-creation binding
   * ({@link BureauRetentionOptions.receipts}) is stored, so an
   * exact retry of the request that created it always finds its task.
   * `olderThan` must be a finite, non-negative number; otherwise
   * `createBureau` throws `BureauError(..., 'BAD_REQUEST')`.
   */
  tasks?: RetentionWindowOption;
}

/**
 * COR-1701 — how long a run-creation request id stays bound to its run after the run settles, as
 * {@link BureauRetentionOptions.receipts}. Only the `{ olderThan }` form exists: a receipt is a
 * deduplication ledger entry, and keeping it forever would pin every settled run, so `'forever'`
 * is refused with `BureauError(..., 'BAD_REQUEST')`.
 */
export interface BureauReceiptRetentionOption {
  /** Milliseconds after the run settles; a positive integer. Default `86400000` (24 hours). */
  readonly olderThan: number;
}

export interface BureauOptions<D extends AgentDefinitions = AgentDefinitions> {
  /**
   * This bureau's identity, as {@link Bureau.id} and as the `bureauId` a
   * `bureau.events` subscription names.
   *
   * Defaults to a runtime-generated identifier, which is fine for a single
   * in-process bureau. A host serving several needs ids it can hand a client,
   * so it supplies them.
   *
   * It is also the tenant of the memory every run writes (COR-1546), so a Bureau with
   * {@link BureauOptions.memory} over a {@link BureauOptions.storage} needs a stable `id`: the
   * generated default changes on every restart, and a restarted Bureau would then read and write
   * a partition that holds none of what it remembered before. COR-1701: `createBureau` refuses
   * that combination, `memory` with `storage` and no `id`, with `BureauError(..., 'BAD_REQUEST')`.
   */
  id?: string;
  /**
   * The typed agent catalog (AB-15, AB-22) — a plain literal map of agent
   * name to `RunnableAgent`, exposed read-only as {@link Bureau.agents} and
   * started by name through {@link BureauTasks.start}. Optional (COR-1701):
   * omitted means `{}`, typed `Record<never, never>`, for a bureau that only
   * runs file agents ({@link BureauOptions.agentSource}) and starts nothing
   * from the code catalog. There is no register/unregister lifecycle: the map
   * is fixed for the bureau's lifetime. Every task and schedule fire
   * belongs to one of these agents.
   *
   * The name `bureau` is reserved (it named the implicit Bureau-wide agent,
   * which no longer exists); an entry called `bureau` is refused with
   * `BureauError` (`BAD_REQUEST`).
   */
  agents?: D;
  /**
   * COR-1702 — where agent definitions are loaded from, watched in, and written back to. Pass
   * `agentFileDirectory(path, { tools })` from `@lostgradient/bureau/sources` for a directory of
   * Markdown agent files (COR-1524): every `*.md` file in it is an agent whose identifier is the
   * filename without the extension, listed in {@link Bureau.agents} beside the code-defined ones
   * and started by name through {@link BureauTasks.start}. See
   * `documentation/agent-files.md`.
   *
   * Bureau keeps parsing, validation, snapshots, revisions, publication, and the write-through
   * operations; the source only holds bytes. The source's `tools` is the deployment's tool
   * catalog: the tools an agent file may name in `tools`. With {@link BureauOptions.workflowSource}
   * Bureau adds `workflows-create`, `workflows-update`, `workflows-pause`, `workflows-resume`,
   * and `workflows-list` (COR-1529); a tool of the host's with one of those names is refused with
   * `BureauError` (`BAD_REQUEST`). Requires {@link ModelsOptions.generate}: a model name that
   * nothing can turn into a `generate` would be silently ignored, so `createBureau` refuses the
   * combination with `BureauError` (`BAD_REQUEST`).
   */
  agentSource?: AgentSource;
  /**
   * COR-1702 — where workflow definitions are loaded from, watched in, and written back to. Pass
   * `workflowFileDirectory(path)` from `@lostgradient/bureau/sources` for a directory of JSON
   * workflow files (COR-1527): every `*.json` file in it is an agent-authored workflow
   * (COR-1525's document plus `agent` and `paused`) whose identifier is the filename without the
   * extension, registered with the durable engine as its own workflow type and run on the
   * schedule its `trigger` names. Requires a durable engine, and `createBureau` refuses the
   * combination without one with `BureauError` (`BAD_REQUEST`). See
   * `documentation/workflow-files.md`.
   */
  workflowSource?: WorkflowSource;
  /**
   * COR-772 — configuration for {@link Bureau.children}, Bureau's durable
   * parent-child topology. Omit it and children still dispatch, persist, and
   * recover; this only adds typed signals and delegation grants.
   */
  children?: BureauChildrenOptions<D>;
  /**
   * COR-851 — the validators durable goals may name. A goal persists only a
   * validator's identity (name and version); the executable is registered here
   * and resolved by that exact identity every time it runs, including after a
   * restart. A validator that was removed or re-versioned between restarts is
   * reported explicitly — `bureau.goals.create` refuses it, and a goal already
   * running ends its attempt `unavailable` — and is never swapped for another
   * version. Two validators with the same name and version are a startup error.
   */
  validators?: readonly Validator[];
  /**
   * COR-851 — resolves the producing run of a `fresh-from-artifact` goal's
   * handoff artifact: its sealed context epoch and the actors permitted to
   * publish for it. A goal validates its artifact at `create` and again before
   * every attempt that consumes it, and an artifact this cannot resolve is
   * unauthorized. Omitted, no `fresh-from-artifact` goal can be created, because
   * nothing can vouch for any artifact's source run.
   */
  resolveFreshAttemptSource?: FreshAttemptSourceResolver;
  /**
   * AB-64/AB-250 — deployment/Bureau model-policy invariants and the
   * per-principal user configuration `Bureau.models.plan`/a run's
   * `SelectionGate` compose against, held in memory for the bureau's
   * lifetime. Named policy profiles are keys of `users` and of each
   * configuration's own `fallbackOrder`; there is no storage schema and no
   * migration. `BureauRunOptions` gains no field for any of this — see
   * AB-64's decision record, `## AB-15 and AB-22 boundaries (AC9)`.
   */
  modelPolicy?: BureauModelPolicyOptions;
  store?: Store;
  /**
   * Storage configuration or an already-constructed Weft storage adapter. Raw
   * adapters let platform packages such as `cloudflare` supply a Durable Object
   * SQLite backend; their lifecycle remains owned by the caller.
   */
  storage?: StorageConfiguration | Storage;
  /**
   * Override for Weft-backed durable execution. Durable execution is **on by
   * default whenever a persistent `storage` backend (`sqlite`/`lmdb`) is
   * configured** — every task is then checkpointed on the same backend
   * and resumes from its last completed step after a crash, with the standard
   * run event surface unchanged.
   *
   * The default follows persistence because that is the only place resume is
   * real: a `memory` backend loses its checkpoints with the process, so it stays
   * OFF by default. Set this explicitly to override the default either way —
   * `true` forces the engine on (incl. for `memory`, so durable behavior is
   * testable locally); `false` forces it off even for a persistent backend.
   * Has no effect without any `storage` (a durable engine needs a backend).
   *
   * Recovered runs are registered through Weft's pre-resume recovery hook, so
   * {@link BureauTasks.detail} and live event subscribers see them before resumed
   * user code advances.
   */
  durable?: boolean;
  /**
   * Select how the durable engine's periodic maintenance is driven. The
   * default `'automatic'` profile uses in-process intervals. Cloudflare
   * Durable Objects and other serverless hosts should use `'manual'`, then
   * call {@link Bureau.maintain} from each alarm or Cron wake-up.
   */
  maintenance?: 'automatic' | 'manual';
  /**
   * COR-1701 — how long each kind of Bureau history is kept: `audit`, `checkpoints`, `events`,
   * `tasks`, and `receipts`. See {@link BureauRetentionOptions}. Every window is read at the next
   * maintenance pass. Omitted fields keep their defaults. Invalid values make `createBureau`
   * throw `BureauError(..., 'BAD_REQUEST')`.
   */
  retention?: BureauRetentionOptions;
  /**
   * COR-41 — governed memory for the Bureau's recall and persistence hooks.
   * Recall goes through mandatory recall admission (trust minimums, detector
   * scan, evidence labeling) and final assistant content is admitted as
   * untrusted conversation memory, both under the run's memory authority
   * (see {@link BureauOptions.memoryAuthority}). The host constructs the
   * instance (`createGovernedMemory` from `@lostgradient/memory`) so it owns
   * the storage, ledger, and policy.
   */
  memory?: GovernedMemory;
  /**
   * COR-41 — the memory authority Bureau delegates to each run it composes
   * memory hooks for. See {@link BureauMemoryAuthorityOptions}.
   */
  memoryAuthority?: BureauMemoryAuthorityOptions;
  identity?: IdentityConfiguration;
  /** Host-owned authority check used before durable recovery resumes user code. */
  requestAuthorityValidator?: (context: ToolRequestContext) => boolean | Promise<boolean>;
  /**
   * AB-13 — declarative flow control gating run ADMISSION, composed over
   * operative's `createFlowController`: a per-key concurrency cap, a rate
   * limit keyed by an arbitrary function of the trigger, and singleton
   * dedupe of concurrent identical triggers. Applies uniformly to both
   * API-triggered runs (`tasks.start`) and durable schedule fires — the same
   * policy instance tracks state across both surfaces. `concurrency`/`rateLimit`
   * default their grouping key to the run's `agentName`; `singleton`
   * requires an explicit key (there is no sane default identity for "this
   * is a duplicate of that"). A rejected admission throws
   * `BureauError` with code `RATE_LIMITED`. Omit to disable — the default.
   */
  flowControl?: FlowControlPolicy;
  /**
   * F3, COR-1700 — whether a durable Bureau offers operative's `requestHumanInput` HITL tool.
   * It is offered by default (COR-1577) to a durable task and to a schedule fire. It is never offered without a durable engine, whatever this option
   * says, nor to a child run, a goal attempt, or a workflow-file agent step. An agent file's
   * `tools:` list does not gate it. The tool is bound to that run's OWN event emitter and its real
   * `ctx.services` object — the only wiring under which a `HumanWaitParkedEvent` the tool
   * dispatches actually reaches `frames`/`store` listeners (including AB-13's
   * flow-control `markParked`) and `reviews.list` (AB-20). The park is a `human-wait`
   * review: a task's carries its context's id as `sessionId`, and `runId` is the task's id. The agent
   * must stop on the call (`stopWhen.toolCalled('requestHumanInput')`) for the run to park.
   *
   * Pass `false` to remove the tool. Passing `true` throws `BureauError` `BAD_REQUEST`: the tool
   * is already the default.
   *
   * COR-1674 — pass `{ inputSchemas }` to give a signal a JSON Schema (2020-12) for the answer a
   * person must give. `inputSchemas` maps a `signalName` to its schema; a call to
   * `requestHumanInput` on that signal carries the schema into its park, so an A2A client sees a
   * form and an answer that does not satisfy the schema is refused before the run resumes. The
   * object form keeps the tool on; `createBureau` checks every schema eagerly with operative's
   * `checkHumanInputSchemas` and throws `HumanInputSchemaError` for one it cannot accept. A
   * signal with no entry takes any answer.
   */
  humanInput?: BureauHumanInputOption;
  /**
   * AB-201, COR-1700 — whether a durable Bureau offers operative's `scheduleWakeup`
   * self-scheduling tool to a durable task, mirroring
   * {@link BureauOptions.humanInput}'s wiring exactly. It is offered by default: Bureau adds a
   * `scheduleWakeup` tool to each durable run's toolbox, bound to that run's real `ctx.services`
   * object so a call genuinely parks the workflow via `ctx.sleep` (AB-41's decision record)
   * rather than merely returning a success-shaped no-op. Without a durable engine it is absent
   * whatever this option says. Pass `false` to leave the tool out of the toolbox; it is simply
   * absent rather than wired to throw (mirroring `requestHumanInput`'s own omission behavior).
   * Passing `true` throws `BureauError` `BAD_REQUEST`: the tool is already the default. A
   * standalone `scheduleWakeup` tool built outside Bureau's composition with `durable: false`
   * throws `DurableCapabilityUnavailableError` instead (AB-41 / AB-43), unchanged by this option.
   */
  wakeup?: false;
  /**
   * COR-1709 — whether a durable Bureau offers the `decide` tool to a task: a typed question put
   * to a model (`boolean`, `choice`, `scale`, or `structured` against a JSON Schema). It is offered
   * by default, to the run kinds that are offered `requestHumanInput`, and only when something can
   * answer: {@link BureauOptions.decisions}'s `model` or {@link ModelsOptions.generate}. The tool
   * acts as the task's principal and is capped per task by {@link DecisionsOptions.maximumPerTask}.
   * Pass `false` to leave it out. Passing `true` throws `BureauError` `BAD_REQUEST`: the tool is
   * already the default.
   */
  decide?: false;
  /**
   * COR-1709 — how `bureau.decisions.decide` and the `decide` tool are answered: a `model` for the
   * kinds it serves, a `fallbackModel` row of the model catalog for the rest, and a
   * `maximumPerTask` cap on the tool. See {@link DecisionsOptions}.
   */
  decisions?: DecisionsOptions;
  /**
   * COR-1710 — the runtime settings: the code options above are each setting's default, a value
   * stored through {@link Bureau.settings} overrides one, and `locked` names the keys the store may
   * not override. See {@link SettingsOptions}.
   */
  settings?: SettingsOptions;
  /**
   * Opt into OpenTelemetry spans + metrics for durable runs. `true` enables the
   * default interceptor; pass an {@link ObservabilityOptions} (minus `eventTarget`,
   * which the engine supplies) to customize. Has effect only when a durable engine
   * is composed. `@opentelemetry/api` is an optional peer — without it spans are
   * no-ops, so enabling this is safe before any telemetry backend exists.
   */
  observability?: boolean | Omit<ObservabilityOptions, 'eventTarget'>;
  /**
   * Host sink for `ctx.log` records emitted by durable workflows (Weft 0.4.0
   * structured logging). Has effect only when a durable engine is composed.
   */
  onLog?: (record: WorkflowLogRecord) => void;
  /**
   * History/checkpoint guardrails for durable runs. `history.maxEvents` is a
   * circuit breaker (a breach terminates the run as an error, classified
   * distinctly from a deadline timeout); `checkpointSizeWarningThreshold` arms an
   * early-warning event observed via {@link onCheckpointSizeWarning}. Has effect
   * only when a durable engine is composed.
   */
  durableGuardrails?: DurableGuardrailsConfiguration;
  /**
   * Multi-process ownership posture for the durable engine (AB-178). Omit for
   * the default `ownership: 'workflow-lease'`. Pass `{ ownership: 'none' }` to
   * opt out — one bureau process per durable store, enforced by infrastructure
   * convention (one replica, a `Recreate` deploy) rather than the engine
   * itself. Has effect only when a durable engine is composed.
   *
   * Under `'workflow-lease'` more than one bureau process can safely share a
   * durable store: Weft fences each workflow to exactly one engine before its
   * generator runs, so a second process racing to resume the same workflow
   * fails closed instead of double-executing it.
   *
   * Under `'workflow-lease'`, run-ownership pruning (`maintain()`
   * and the automatic maintenance timer) also skips any run whose workflow
   * claim is currently live on any process; under `'none'` pruning is
   * unchanged.
   */
  durableOwnership?: Pick<
    CreateRunEngineOptions,
    'ownership' | 'workflowClaimTtlMs' | 'workflowClaimRenewIntervalMs'
  >;
  /**
   * Caller-supplied version identifier for the currently-deployed agent/workflow
   * code (e.g. the app's `package.json` version or a deploy SHA) — AB-10,
   * workflow versioning for in-flight durable runs. Has effect only when a
   * durable engine is composed.
   *
   * Stamped into every new durable run's checkpoint at creation
   * (`CreateRunEngineOptions.runWorkflowVersion` /
   * `createRunWorkflow`'s `version` option), and compared against each
   * recovered run's stamped version on boot. A mismatch does not block or
   * alter recovery — it is a PIN-AND-WARN signal only, surfaced via
   * `classifyRecoveredRun`'s `'reattach-version-mismatch'` verdict (instead of
   * plain `'reattach'`) and logged at boot. See
   * `documentation/workflow-versioning.md` for the deploy runbook: what happens
   * to in-flight runs when this value changes across a deploy.
   *
   * Omit to disable version tracking entirely — every run's stamped version is
   * then `undefined` and no mismatch is ever reported.
   */
  workflowVersion?: string;
  /**
   * Notification delivery for pending approvals (AB-21). Configured targets
   * receive a webhook POST on `elicitation.requested`, a newly-appeared
   * `approval-pending` review, and a newly-appeared `human-wait.parked`
   * review, each carrying a deep link back into the AB-20 review queue (or
   * the run detail page for elicitation, which has no review-queue item).
   * Omit or pass `{ targets: [] }` to disable — the default.
   */
  webhooks?: WebhookNotifierOptions;
  /**
   * Online evaluations (AB-53) — samples a fraction of completed live runs
   * through configured judges/matchers, records every sampled score to the
   * durable audit trail, and fires a webhook (via `options.webhooks`, AB-21's
   * durable delivery infra) when a judge's score breaches its configured
   * alert threshold. Omit, pass no judges, or pass `sampleRate: 0` to
   * disable — the default.
   */
  onlineEvals?: OnlineEvalSamplerOptions;
  /**
   * Managed assets (COR-794) — composes one asset service over the injected
   * asset storage, policy, and ports, running on this bureau's runtime
   * services. Exposed as {@link Bureau.assets} and shut down as the
   * `'assets'` owner. Omit to compose none — the default.
   */
  assets?: BureauAssetOptions;
  /**
   * Reads the MCP resource an `mcp-resource` part of a tool result links to (COR-1634), so the
   * step after a tool returned an MCP `resource_link` can send the linked bytes to a provider.
   * Bureau holds no MCP connections, so the host that connected the server supplies the read. Only a
   * tool result introduces such a link (a run, session or schedule input carrying one is refused),
   * but the reader must still authorize the run's principal, the server and the URI on every
   * call, and it is called again at every step that sends the row. Without it, a run whose
   * row holds such a link fails its next generation with a `MediaAdmissionError`. See
   * {@link McpResourceReader}.
   */
  mcpResources?: McpResourceReader;
  /**
   * Host sink for internal operational diagnostics — recovery failures,
   * live-frame listener exceptions, dispose errors, and persistence
   * failures (see {@link BureauDiagnostic}). Distinct from {@link onLog},
   * which only carries `ctx.log` records emitted by durable workflow code.
   * Omit to log to the console exactly as before (`console.error`/
   * `console.warn`, keyed by {@link BureauDiagnostic.level}). A throwing
   * sink falls back to the console for that one diagnostic without failing
   * the run.
   */
  onDiagnostic?: DiagnosticSink;
  /**
   * A listener on the Bureau's own event emitter that is registered before any
   * recovery pass can dispatch, so it hears every boot-time event (recovery
   * decisions, committed `run.settled`, `run.registered`, and `action` events of recovered runs) that a
   * listener added through `addEventListener` after `createBureau()` returns
   * would miss. It receives every event the emitter dispatches for the life of
   * the Bureau, in dispatch order. A throwing listener, or an async one that rejects, is
   * reported through {@link onDiagnostic} and does not affect the Bureau. Live frames have no
   * such option: `frames` replays the frames emitted during
   * recovery to its first subscriber.
   */
  onEvent?: (event: BureauEventMap[BureauEventType]) => void | Promise<void>;
  /**
   * AB-42/AB-194 — per-session and per-principal backlog caps for pending
   * `SessionInputRecord`s admitted through {@link BureauContexts.input}.
   * Both are validated as positive integers at `createBureau()` construction
   * time, throwing `BureauError('...', 'BAD_REQUEST')` for a non-positive-integer
   * value (0, a negative number, or a non-integer). Omitting a field leaves it
   * unvalidated (no error) — {@link DEFAULT_SESSION_INPUT_BACKLOG_LIMIT} and
   * {@link DEFAULT_PRINCIPAL_SESSION_INPUT_BACKLOG_LIMIT} are the values the
   * mailbox-backed admission path will apply for an omitted field once it
   * lands, not values `createBureau()` resolves or stores today.
   *
   * AB-42 fixes only that two independent caps exist over the not-yet-terminal
   * `SessionInputRecord`s for a session (and, separately, for one principal's
   * records against that session); it does not fix the numbers, and neither
   * cap is enforced by this issue's code paths — every reachable outcome here
   * is a pre-admission rejection, before any record (and so any backlog)
   * exists. Enforcement lands with the mailbox-backed `ab-42-bureau-b` slice.
   */
  sessionInput?: {
    readonly sessionBacklogLimit?: number;
    readonly principalBacklogLimit?: number;
  };
  /**
   * The model rows the deployment offers and how a row becomes a `generate`, exposed as
   * {@link Bureau.models}. `catalog` defaults to `@lostgradient/operative`'s static seed.
   * `generate` is required with {@link BureauOptions.agentSource}: a model name that nothing
   * can turn into a `generate` would be silently ignored, so `createBureau` refuses the
   * combination with `BureauError` (`BAD_REQUEST`).
   */
  models?: ModelsOptions;
  /**
   * AB-92/AB-252/AB-260 — the injectable runtime-service seam: wall time,
   * monotonic time, timers, identifiers, randomness, and deferred-work
   * tracking. `createBureau` resolves `options.runtime ?? createDefaultRuntimeServices()`
   * exactly once, before any subsystem is constructed, and snapshots that
   * single instance into every run, session, schedule,
   * heartbeat tick, audit write, webhook delivery, and background evaluation
   * the bureau starts — two bureaus in one process given independent manual
   * runtimes never share a clock, an identifier sequence, or a deferred
   * ledger. Omit to use the real globals (`createDefaultRuntimeServices()`),
   * exactly as before this option existed. A test composes its own via
   * `createManualRuntimeServices` from `@lostgradient/operative` (or
   * `lifecycle`, which `@lostgradient/operative` re-exports it from).
   */
  runtime?: RuntimeServices;
}

/**
 * AB-42/AB-194 coordinator-chosen default for
 * {@link BureauOptions.sessionInput}'s `sessionBacklogLimit` — the per-session
 * cap over all not-yet-terminal `SessionInputRecord`s, applied when the caller
 * omits an explicit value. Not itself load-bearing for any AB-42 acceptance
 * criterion beyond being enforced once the mailbox-backed admission path lands.
 */
export const DEFAULT_SESSION_INPUT_BACKLOG_LIMIT = 32;

/**
 * AB-42/AB-194 coordinator-chosen default for
 * {@link BureauOptions.sessionInput}'s `principalBacklogLimit` — the per-principal
 * cap over one principal's `SessionInputRecord`s against a given session,
 * applied when the caller omits an explicit value.
 */
export const DEFAULT_PRINCIPAL_SESSION_INPUT_BACKLOG_LIMIT = 128;

/**
 * Durable history/checkpoint guardrail configuration surfaced on
 * {@link BureauOptions.durableGuardrails}. A direct `Pick` of the matching
 * {@link CreateRunEngineOptions} fields — no duplicated field declarations, so the
 * single source of truth stays on the engine options and the composition spreads
 * this straight through.
 */
export type DurableGuardrailsConfiguration = Pick<
  CreateRunEngineOptions,
  | 'history'
  | 'checkpointSizeWarningThreshold'
  | 'checkpointHistory'
  | 'payloadSize'
  | 'maxNestingDepth'
  | 'onCheckpointSizeWarning'
>;

export type BureauEventType = keyof BureauEventMap & string;

// ── Review queue (AB-20) ─────────────────────────────────────────────

/**
 * Shared review lifecycle vocabulary (AB-46) both {@link PendingToolApprovalReview}
 * and {@link PendingHumanWaitReview} report a `status` from. `reviews.list()`
 * only ever returns `'pending'` items; every other status surfaces through
 * `reviews.get(id)`'s audit-trail reconstruction or the audit trail itself.
 *
 * - `'pending'` — awaiting a decision.
 * - `'approved'` / `'denied'` — resolved via `reviews.resolve` with `decision: 'approve' | 'deny'`.
 * - `'rejected'` — resolved via `reviews.resolve` with `decision: 'reject'` (requires a reason).
 * - `'expired'` — a tool-approval review swept by the expiry pass (a schedule fire's, the maintenance pass's) past its binding's `expiresAt`.
 * - `'revoked'` — transitioned by task-retention expiry or `deleteSession` via `revokePendingApprovalsForRun`.
 * - `'canceled'` — transitioned by `tasks.cancel` via `revokePendingApprovalsForRun`.
 * - `'superseded'` — a tool-approval review whose `resumeApproval` re-gate produced a new `pendingApproval` for the same `callId`.
 */
export type ReviewStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'rejected'
  | 'expired'
  | 'revoked'
  | 'canceled'
  | 'superseded';

/**
 * A tool call parked by armorer's `needs_approval` policy decision. `approval`
 * is the exact {@link PendingToolApproval} (signed with `approvalToken` when
 * the bureau's toolbox was constructed with `approvalSecret`) that
 * `reviews.resolve` passes straight to `Toolbox.resumeApproval` on approve.
 */
export interface PendingToolApprovalReview {
  kind: 'tool-approval';
  /** Stable id for this review, e.g. `approval:<runId>:<callId>`. */
  id: string;
  runId: string;
  sessionId: string;
  agentName: string | undefined;
  approval: PendingToolApproval | SignedPendingToolApproval;
  /** Epoch-ms timestamp the tool call requested approval. */
  requestedAt: number;
  /** Milliseconds elapsed since `requestedAt`, computed at read time. */
  ageMilliseconds: number;
  /** The review's current lifecycle status (AB-46). See {@link ReviewStatus}. */
  status: ReviewStatus;
  /**
   * The supersession round (COR-855): 0 for an approval never superseded,
   * incremented each time `reviews.resolve` approves it and the policy gates the
   * resumed call again, which replaces the approval under the same id. It
   * separates one supersession's resolution from the next.
   */
  round: number;
  /**
   * COR-1717 — `true` when the approval was approved and its resolution started, but the process
   * ended before the decision committed, so the tool may or may not have run. Absent otherwise.
   * The tool is never re-run automatically: resolving the review runs the normal approval path
   * once, and an approval whose signed binding has expired follows the normal expiry path.
   */
  interrupted?: true | undefined;
  /**
   * COR-1717 — epoch-ms timestamp the interrupted resolution started. Undefined when the review
   * is not interrupted, or when the session holds the legacy marker that recorded no time.
   */
  resolutionStartedAt?: number | undefined;
}

/**
 * A durable run parked on `ctx.waitForSignal` by the `requestHumanInput` tool
 * (operative's F3 HITL primitive). `signalName` is the exact name
 * `reviews.resolve` passes to `Bureau.contexts.signal` on approve.
 */
export interface PendingHumanWaitReview {
  kind: 'human-wait';
  /** Id for this review, e.g. `human-wait:<runId>:<signalName>:<parkOrdinal>`; distinct per park, stable across restart. */
  id: string;
  runId: string;
  /**
   * The Bureau session the run belongs to. Absent only for a review of a run that has no session,
   * which is addressed by its run id; {@link Bureau.reviews.resolve} resumes it through the
   * engine by that id.
   */
  sessionId?: string | undefined;
  agentName: string | undefined;
  signalName: string;
  prompt: string | undefined;
  /**
   * The JSON Schema (2020-12) the agent's author configured for the signal, when one is: the
   * shape of the answer the wait expects. An A2A task projects it as a form.
   */
  inputSchema?: HumanInputSchema | undefined;
  /** Epoch-ms timestamp the run parked. */
  requestedAt: number;
  /** Milliseconds elapsed since `requestedAt`, computed at read time. */
  ageMilliseconds: number;
  /** The review's current lifecycle status (AB-46). See {@link ReviewStatus}. */
  status: ReviewStatus;
}

/** A single item in the gateway's review queue (AB-20). */
export type PendingReview = PendingToolApprovalReview | PendingHumanWaitReview;

/**
 * A review that belongs to a session: every tool approval, and a human wait of a task.
 * Bureau's session code works in this type; a human wait of a run with no session lacks one.
 */
export type SessionPendingReview =
  PendingToolApprovalReview | (PendingHumanWaitReview & { readonly sessionId: string });

export interface ResolveReviewInput {
  /** The {@link PendingReview.id} to resolve. */
  id: string;
  /**
   * `'reject'` (AB-46) is a `deny` outcome plus a REQUIRED caller-supplied
   * `reason`: `reviews.resolve` throws `BureauError('reject requires a reason',
   * 'BAD_REQUEST')` before any state change when `reason` is absent or empty,
   * for both review kinds.
   */
  decision: 'approve' | 'deny' | 'reject';
  /**
   * The authenticated principal making the decision (e.g. `api-key:<id>` or
   * `static-token`). Recorded in the audit trail for attribution — required,
   * not optional, so every resolution is attributable.
   */
  principal: string;
  /**
   * `tool-approval` approve only: override the tool call's arguments instead
   * of resuming with the originally-proposed ones. Ignored for `deny`/`reject`
   * and for `human-wait` reviews.
   */
  arguments?: unknown;
  /** `human-wait` approve only: the payload delivered with the signal. */
  payload?: unknown;
  /**
   * COR-1659 — the {@link PendingToolApprovalReview.round} the caller read. A re-gated approval
   * keeps its id and advances its round, so a caller that read round N would otherwise resolve
   * the replacement. When given, `reviews.resolve` compares it with the review's current round
   * before anything is claimed, and throws a `CONFLICT` `BureauError` (a
   * `ReviewRoundChangedError`) on a mismatch: nothing is decided, written, or audited. A human
   * wait is always at round 0. Omitted, the call is not fenced.
   */
  round?: number;
  /**
   * Optional human-readable note, recorded in the audit trail either way.
   * REQUIRED (non-empty) when `decision` is `'reject'`.
   */
  reason?: string;
}

export interface ResolveReviewResult {
  id: string;
  kind: PendingReview['kind'];
  decision: 'approve' | 'deny' | 'reject';
  /** The tool's `ToolExecutionResult` when a `tool-approval` was approved. */
  result?: unknown;
  /**
   * `tool-approval` reject only: echoes `input.reason` back so a caller
   * building the next manual run (per `create-agent.ts`'s docstring) can
   * splice it into the tool's `ToolExecutionResult`.
   */
  feedback?: string;
  /**
   * `tool-approval` approve only: `true` when the policy gated the resumed call
   * again, so the tool did not run and the review stays pending under the same
   * id with its {@link PendingToolApprovalReview.round} incremented.
   */
  superseded?: true;
}

/**
 * Armorer's cleanup-outcome vocabulary
 * (`packages/armorer/src/execution-lifecycle.ts`'s `ExecutionCleanupOutcome`
 * `status`), reused verbatim per AB-34's vocabulary constraint — the same
 * reuse the other started-work
 * handles make.
 *
 * - `'completed'` — the owner's drain settled normally.
 * - `'failed'` — the owner's drain settled by rejecting; the failure is
 *   diagnosed and teardown continues past it.
 * - `'unresolved'` — a `shutdown({ timeoutMilliseconds })` wait elapsed
 *   before this owner's drain settled. The drain itself is not abandoned —
 *   only `shutdown()`'s wait for it is.
 * - `'not-required'` — this owner had nothing to release.
 */
export type CleanupAcknowledgement = 'not-required' | 'completed' | 'failed' | 'unresolved';

/**
 * Options for {@link Bureau.shutdown}. `policy` defaults to `'abort'` when
 * omitted (including when `options` itself is omitted) — matching
 * `dispose()`'s existing behavior.
 *
 * - `'abort'` aborts caller-owned and catalog runs, including durable runs this process started.
 *   A durable run this process recovered at boot is left recoverable, as under `'detach'`.
 * - `'drain'` waits for caller-owned and catalog runs to finish naturally.
 * - `'detach'` leaves durable caller-owned runs recoverable, aborts process-local and catalog
 *   runs, and waits for errored runs as `'drain'` does. Toolbox cleanup remains abortive.
 */
export interface BureauShutdownOptions {
  readonly policy?: 'abort' | 'drain' | 'detach';
  /**
   * Bounds `shutdown()`'s WAIT only — see {@link Bureau.shutdown}. Omit to
   * wait indefinitely.
   *
   * The wait itself sleeps on this bureau's own resolved
   * `RuntimeServices.timers` (AB-260's deterministic contract) — never a
   * real timer, even under a real-globals bureau. Under a
   * `ManualRuntimeServices`, that means nothing advances this wait on its
   * own: the CALLER owns advancing the clock
   * (`runtime.advance(timeoutMilliseconds)`) far enough for it to elapse,
   * exactly as for any other timer-driven behavior. `bureau/test`'s
   * `BureauTestHarness.close(shutdownOptions)` is the one exception — it
   * owns that advance itself once `shutdown()` has armed the timer, so a
   * test built on the harness never needs to (Coordinator ruling on
   * AB-338).
   */
  readonly timeoutMilliseconds?: number;
}

/** One row of {@link BureauShutdownReport.owners} — one Bureau-composed subsystem's drain outcome. */
export interface BureauShutdownOwnerReport {
  /**
   * Which Bureau-composed subsystem this row reports on. A row is emitted
   * only for a subsystem this bureau actually composes — `'heartbeat'` is
   * reserved for the day Bureau composes one; no row carries it today.
   */
  readonly kind:
    | 'online-evals'
    | 'webhook-notifier'
    | 'audit-trail'
    | 'event-history'
    | 'durable-engine'
    | 'assets'
    | 'heartbeat';
  readonly id?: string;
  readonly outcome: CleanupAcknowledgement;
}

/**
 * Returned by {@link Bureau.shutdown}, modeled on armorer's
 * `ExecutionCleanupReport` shape (`packages/armorer/src/execution-lifecycle.ts`)
 * rather than a new report vocabulary.
 */
export interface BureauShutdownReport {
  readonly admissionClosed: true;
  readonly policy: 'abort' | 'drain' | 'detach';
  /**
   * Number of durable caller-owned runs left running for a later process to recover: every one
   * under `'detach'`, and under `'abort'` the ones this process recovered rather than started.
   */
  readonly detached: number;
  readonly requested: number;
  readonly completed: number;
  readonly failed: number;
  readonly unresolved: number;
  readonly notRequired: number;
  readonly owners: readonly BureauShutdownOwnerReport[];
}

/**
 * Returned by {@link Bureau.recovery}, modeled on
 * {@link BureauShutdownReport}'s shape rather than a new report vocabulary
 * (AB-242's decision record). Aggregates one boot recovery pass's outcome so
 * a caller who wants to know whether recovery actually succeeded has a
 * typed, awaitable answer instead of only a `scope: 'recovery'` diagnostic
 * log line — recovery itself stays diagnostic-only: `createBureau()` never
 * rejects on a `recoverDurableRuns()` failure, in whole or in part.
 */
export interface BureauRecoveryReport {
  /**
   * `'failed'` when {@link BureauRecoveryReport.batchFailure} is set (no
   * handle was classified at all); otherwise `'partial'` when
   * {@link BureauRecoveryReport.sweepFailure} is set,
   * {@link BureauRecoveryReport.perRunFailures} is non-empty, or
   * {@link BureauRecoveryReport.skippedRuns} is non-empty; otherwise
   * `'clean'`. The `'skip'`, `'reattach'`, `'monitor'`, and
   * `'reattach-version-mismatch'` per-run verdicts never change `outcome`.
   */
  readonly outcome: 'clean' | 'partial' | 'failed';
  /** Set when the unconditional scheduler-residue sweep failed before `recoverAll()` ran. */
  readonly sweepFailure?: { readonly message: string };
  /** Set when `durable.engine.recoverAll()` itself threw, so no handle was classified at all. */
  readonly batchFailure?: { readonly message: string };
  /**
   * One entry per handle whose verdict was `'cancel'` (`RecoveryRejectedEvent`),
   * for a caller that wants the aggregate without re-deriving it from the
   * event stream. Empty when every handle recovered, was skipped, or was
   * monitor-only.
   */
  readonly perRunFailures: readonly { readonly runId: string; readonly reason: string }[];
  /**
   * COR-1583 — one entry per stored run that was left untouched because its workflow type is not
   * registered with this Bureau (a Bureau started without `workflowSource`, or a workflow whose
   * file and stored revisions are both gone). A skipped run keeps its state and has no claim taken
   * on it, so a later boot that has registered its type recovers it; no other run is held back by
   * it. Empty when every stored run's type was registered. Each entry is also diagnosed once, as a
   * `scope: 'recovery'` `warn`.
   */
  readonly skippedRuns: readonly { readonly runId: string; readonly type: string }[];
}

/** {@link BureauOptions.children}. */
export interface BureauChildrenOptions<D extends AgentDefinitions = AgentDefinitions> {
  /**
   * The COR-814 signal contract each child agent accepts, keyed by agent
   * name. A child whose agent has a contract gets a typed channel on every
   * dispatch, and again after a restart, so `bureau.children.signal` can
   * reach it by its stable identifier. Contracts are code, not data, so
   * they are configured here rather than persisted.
   */
  readonly signals?: { readonly [TName in AgentNames<D>]?: ChildSignalContract };
  /**
   * COR-336 delegation grants. When configured, every child dispatch issues
   * a signed grant and reserves budget against its parent's; recovery
   * re-verifies each recovered child's grant before reattaching it.
   */
  readonly delegation?: BureauChildDelegationOptions;
}

/**
 * Per-call options of a catalog dispatch (a child, a goal attempt, or a workflow step) —
 * session/tracing/attribution concerns that are properties of the CALL, not the agent (AB-15).
 * {@link StartTaskOptions} carries the same concerns for a task.
 * There is deliberately no `systemPrompt`, `maximumSteps`, or `maximumTokens`
 * override here: anything that shapes how the agent runs is fixed on the
 * catalog agent's own definition (`createAgent({ instructions, ... })`).
 */
export interface BureauRunOptions {
  /**
   * Seeds the `ActiveRun`'s session-correlation key on the durable dispatch
   * (defaulting to the minted run id when omitted).
   */
  sessionId?: string;
  signal?: AbortSignal;
  traceContext?: unknown;
  withTraceContext?: <T>(parentContext: unknown, fn: () => Promise<T>) => Promise<T>;
  /**
   * AB-241 — the authenticated principal attributed with this run, forwarded
   * into `AgentRunContext.principal`. The dispatch records it as a task does —
   * `LivenessSnapshot.owner` and the in-memory `runAttribution` map the
   * event history's principal gate consults — so audit entries and
   * liveness observers see the same attribution. A non-string
   * value is `BAD_REQUEST`.
   */
  principal?: string;
}

/**
 * The reviews of a Bureau: the queue of parked runs awaiting a human decision, and the
 * decision. A tool approval the policy gated and a `requestHumanInput` wait are both reviews.
 * `bureau.reviews.*` operations served by `createBureauHandler` delegate to these members.
 */
export interface BureauReviews {
  /**
   * List every parked run awaiting human review (AB-20): armorer's
   * `needs_approval` tool-approval flow AND durable `requestHumanInput`
   * (`ctx.waitForSignal`) waits, across all live runs. Newest requests last
   * are NOT guaranteed — order is run-registration order, not age order.
   * Excludes items already resolved via `reviews.resolve` (approved, denied, or
   * rejected), even if the underlying run has not produced further activity.
   * Also excludes any `tool-approval` review whose binding's `expiresAt` is at
   * or before the current clock time (AB-46) — a read-time filter with no
   * write; the expiry pass is the write that transitions it to `'expired'`.
   */
  list(): PendingReview[];

  /**
   * Look up one review by id, live or resolved (AB-46). For a still-pending
   * id this is `reviews.list()`'s live scan. For a resolved id, this
   * reconstructs `PendingReview & { status }` from the chronologically-last
   * `review.*` audit-trail record matching `detail.review.id === id` —
   * `undefined` when no audit trail is configured (ephemeral bureau) or when
   * `id` matches nothing at all.
   */
  get(
    id: string,
  ): Promise<(PendingReview & { status: ReviewStatus; resolvedBy?: string }) | undefined>;

  /**
   * The human waits a run is still parked on, read from durable state (COR-1579), so a process
   * that shares a durable store with the one holding the run can list, read and resolve its park.
   * When this process holds the run it returns the run's entries from
   * {@link BureauReviews.list}. Otherwise it derives the park as recovery does: the park,
   * its ordinal and its prompt from the run's checkpoint, still pending while the engine's
   * `waitingForSignals` names its signal. A session run's review carries the session from the
   * durable run input. Empty for a run that is not parked on
   * a human wait, or that this Bureau has no durable engine to read. Pending tool approvals are
   * not derived.
   */
  pendingOf(taskId: string): Promise<PendingHumanWaitReview[]>;

  /**
   * Approve, deny, or reject a pending review (AB-46). Approve resumes the
   * run: a `tool-approval` calls `Toolbox.resumeApproval` on the bureau's
   * toolbox and returns its `ToolExecutionResult`; a `human-wait` calls
   * `signalSession` with the parked signal name. Deny records the decision
   * without resuming anything for `tool-approval` (the binding is revoked; no
   * run to continue), and delivers `{ __abDenied: true, reason? }` on the
   * parked signal for `human-wait`, continuing that run one generation step.
   * Reject is deny plus a REQUIRED `input.reason`: `reviews.resolve` throws
   * `BureauError('reject requires a reason', 'BAD_REQUEST')` before any state
   * change when it is absent or empty. A `tool-approval` reject echoes
   * `input.reason` on `ResolveReviewResult.feedback`; a `human-wait` reject
   * delivers `{ __abRejected: true, reason: input.reason }` on the signal.
   * Every resolution is recorded in the audit trail attributed to
   * `input.principal`.
   *
   * A `tool-approval` resolution also writes its outcome into the session's
   * conversation (COR-855): the executed result on approve, an error result
   * carrying the reason on deny and reject, each replacing the pending
   * `action_required` tool-result row in place, so the next run started on the
   * session answers an up-to-date conversation. A resolution the policy gates
   * again (`superseded`) writes nothing.
   *
   * Throws `BureauError('NOT_FOUND')` when `input.id` does not match a
   * currently pending review (including an already-resolved one).
   */
  resolve(input: ResolveReviewInput): Promise<ResolveReviewResult>;
}

/** What {@link BureauAudit.query} narrows the trail by. Every field is optional. */
export type AuditQuery = {
  /** Only records about this resource: a run id, or `schedule:<id>`, `session:<id>`, `agent:<id>`, `workflow:<id>`. */
  readonly runId?: string | undefined;
  /** Only records of this type. */
  readonly type?: string | undefined;
  /** Only records at or after this time, in epoch milliseconds. */
  readonly since?: number | undefined;
  /** The `nextCursor` of the previous page. */
  readonly cursor?: string | undefined;
  /** How many records a page holds, 1 to 100. Defaults to 50. */
  readonly limit?: number | undefined;
};

/** Who is asking, for {@link BureauAudit.query}. */
export type BureauAuditQueryOptions = {
  /**
   * Only records about resources this owner owns (the `api-key:<subject>` or `anonymous:local`
   * string `ownerOf` returns). A record about a resource with no owner is never returned for an
   * owner. Omitted, every record is returned: an in-process caller is the host itself.
   */
  readonly owner?: string | undefined;
};

/**
 * One audit record, redacted to metadata: when it happened, its type, what it is about, the
 * actor, and a few scalar fields. Never a secret, transcript, tool argument, tool result, review
 * prompt, or memory content.
 */
export type AuditQueryRecord = {
  /** The trail's own order among records of one millisecond; `null` for a record written before it existed. */
  readonly sequence: number | null;
  /** ISO-8601 time of the record. */
  readonly timestamp: string;
  /** The record's type, such as `run.completed`. */
  readonly type: string;
  /** What the record is about: a run id, or `schedule:<id>`, `session:<id>`, `agent:<id>`, `workflow:<id>`. */
  readonly resource: string;
  /** The actor, when the record names one. Never the owner. */
  readonly principal: string | null;
  /** Scalar fields from an allowlist (`agentName`, `finishReason`, `scheduleId`, `sessionId`, `status`, `toolName`), or `null`. */
  readonly detail: Readonly<Record<string, string | number | boolean>> | null;
};

/** One page of {@link BureauAudit.query}. */
export type AuditQueryPage = {
  /** The records, oldest first. */
  readonly records: readonly AuditQueryRecord[];
  /** Pass it as `cursor` for the next page; `null` on the last. */
  readonly nextCursor: string | null;
};

/**
 * What {@link BureauTasks.start} runs: a message for the context (a string, or an ordered list of
 * parts, as `AgentInput` takes), a conversation that seeds a new context, conversation rows to
 * append with their own ids (as an A2A continuation sends them), or `{ continue: true }` to answer
 * the context's conversation as it stands (an AG-UI resume).
 */
export type TaskInput =
  | SessionInputPayload
  | {
      /** Seeds a new context with this conversation. Naming a `contextId` too is `BAD_REQUEST`. */
      readonly conversation: ConversationHistory;
    }
  | {
      /** Rows appended to the context's conversation verbatim, ids and parts included. */
      readonly append: readonly Message[];
    }
  | {
      /** Answers the context's conversation as it stands, which must end in a user or tool row. */
      readonly continue: true;
    };

/** How {@link BureauTasks.start} starts a task. */
export interface StartTaskOptions {
  /**
   * The context to continue. Omitted, the task creates a context. A context bound to another
   * agent is `BAD_REQUEST`; another principal's reads as one that does not exist (`NOT_FOUND`).
   */
  readonly contextId?: string;
  /**
   * The owner of record of the task, and of a context it creates: the authenticated principal that
   * started it. Omitted, the task is owned by `anonymous:local`.
   */
  readonly principal?: string;
  /**
   * The caller's idempotency key for this start. A retry with the same principal, agent, and key
   * and the same `agentName`, `input`, `contextId`, and `requestContext` returns the original task;
   * the same key with any of those changed is refused with `BureauLedgerConflictError`. Needs
   * `principal` (`BAD_REQUEST` otherwise) and a durable engine (`NOT_CONFIGURED`, subject
   * `durable`). Bound to its task until {@link BureauRetentionOptions.receipts} after it settles.
   * A receipt that cannot be recorded rejects the start with `RunCreationReceiptUnrecordedError`
   * naming the task, which is aborted; a retry returns it.
   */
  readonly commandId?: string;
  /** Authenticated, request-scoped authority forwarded to Armorer tool execution. */
  readonly requestContext?: ToolRequestContext;
  /** Aborts the task when it fires, from the moment the task starts executing. */
  readonly signal?: AbortSignal;
  /** The caller's trace context, the parent of the task's spans. */
  readonly traceContext?: unknown;
  /** Runs the task's work under `parent`, the caller's tracer binding. */
  readonly withTraceContext?: <T>(parent: unknown, fn: () => Promise<T>) => Promise<T>;
}

/**
 * A started task. It iterates the task's run events; `result()` settles with the run's result,
 * `abort()` requests cancellation (a no-op once the task has settled), and `snapshot()` reads its
 * liveness now. A handle a `commandId` retry replays for a task this process does not run settles
 * `result()` from {@link BureauTasks.wait}.
 */
export interface TaskHandle<O = unknown> extends AsyncIterable<RunEvent> {
  /** The task's id. */
  readonly id: string;
  /** The context the task runs in. */
  readonly contextId: string;
  /** The receipt of a start that named a `commandId`. */
  readonly receipt?: RunCreationReceipt;
  /** Settles with the run's result once the task has ended. */
  result(): Promise<RunResult<O>>;
  /** Requests cancellation of the task; once it has settled, does nothing. */
  abort(reason?: string): void;
  /** The task's liveness as of now. */
  snapshot(): LivenessSnapshot;
}

/** Which `commandId` {@link BureauTasks.receipt} looks up, scoped as the ledger key is. */
export interface TaskReceiptQuery {
  /** The authenticated caller that issued the start. */
  readonly commandId: string;
  readonly principal: string;
  /** The agent the task ran as. Required unless `contextId` names an existing context. */
  readonly agentName?: string | undefined;
  /** The context the start continued, whose agent the task then ran as. */
  readonly contextId?: string | undefined;
}

/** What {@link BureauTasks.inspect} reads about one task. */
export interface TaskInspection {
  readonly task: TaskView;
  /** The run's liveness, or `undefined` when this process holds no live run for the task. */
  readonly liveness: LivenessSnapshot | undefined;
  /** The children the task's run owns, in the order the topology records them. */
  readonly children: readonly {
    readonly childRunId: string;
    readonly childAgentName: string;
    readonly status: string;
    readonly parentCancellation: string;
    readonly revision: number;
    /** The child's liveness, or `undefined` when this process holds no live run for it. */
    readonly liveness: LivenessSnapshot | undefined;
  }[];
}

/**
 * One answer to a task's open wait, for {@link BureauTasks.respond}. Send exactly one of `answer`,
 * `data`, and `decision`.
 */
export interface TaskRespondRequest {
  /** The task whose wait is answered. */
  readonly taskId: string;
  /** The caller's idempotency key for this command, at most 200 characters. */
  readonly messageId: string;
  /** Answer text for a human-input wait; a list of parts is joined with a newline. */
  readonly answer?: string | readonly string[] | undefined;
  /** The answer of a human wait that carries an input schema, validated against it. */
  readonly data?: Readonly<Record<string, unknown>> | undefined;
  /** The decision on an approval or a human wait. */
  readonly decision?: 'approve' | 'deny' | 'reject' | undefined;
  /** Required, and non-blank, for `reject`. */
  readonly reason?: string | undefined;
  /** Addresses the human wait with this signal. */
  readonly signalName?: string | undefined;
  /** Addresses the tool approval for this call. */
  readonly callId?: string | undefined;
  /**
   * Who answers: the owner string (`api-key:<subject>` or `anonymous:local`) the answer is
   * recorded as resolved by, and the caller the receipt belongs to.
   */
  readonly principal: string;
  /**
   * Answer as an operator: another owner's human-input waits may be answered, and an approval of
   * a task `principal` does not own is answered as a missing task. Omitted, only the task's owner
   * may answer. `createBureauHandler` sets it for a caller holding `bureau.tasks:write`.
   */
  readonly operator?: boolean | undefined;
}

/** What {@link BureauTasks.respond} answered, and the receipt an exact retry returns. */
export interface TaskRespondResult {
  readonly taskId: string;
  readonly messageId: string;
  /** The review the command resolved. */
  readonly reviewId: string;
  readonly kind: 'tool-approval' | 'human-wait';
  readonly decision: 'approve' | 'deny' | 'reject';
  /** `applied`, or `superseded` when the approval was gated again and the tool did not run. */
  readonly receipt: 'applied' | 'rejected' | 'superseded';
  /** A `tool-approval` reject only: the reason, for the next run to splice in. */
  readonly feedback?: string | undefined;
}

/** The output a task of the catalog agent `TName` settles with: its schema's, else `unknown`. */
export type TaskOutputOf<
  D extends AgentDefinitions,
  TName extends keyof D & string,
> = TName extends TName
  ? AgentHasOutput<D, TName> extends true
    ? AgentOutput<D, TName>
    : unknown
  : never;

/**
 * The tasks of a Bureau: start one, and read, wait on, watch, and cancel it.
 * `bureau.tasks.*` operations served by `createBureauHandler` delegate to these members. None of
 * them authorizes the caller beyond the principal a start or a receipt names.
 */
export interface BureauTasks<D extends AgentDefinitions = AgentDefinitions> {
  /**
   * Starts a task of the catalog agent `agentName` with `input`, in the context
   * `options.contextId` names or in a new one. The task is durable when a durable engine is
   * composed and otherwise runs in memory. Refusals land before anything is persisted: an unknown
   * agent is `NOT_FOUND`, an agent with no definition resolver `UNSUPPORTED_CAPABILITY`.
   */
  start<TName extends AgentNames<D>>(
    agentName: TName,
    input: TaskInput,
    options?: StartTaskOptions,
  ): Promise<TaskHandle<TaskOutputOf<D, TName>>>;
  /** Starts a task of an agent named at run time, such as a file agent; its output is untyped. */
  start(agentName: string, input: TaskInput, options?: StartTaskOptions): Promise<TaskHandle>;
  /**
   * A task this process holds, by id, with its steps, events, transcript, and liveness. A task is
   * held after it settles until its record expires under {@link BureauRetentionOptions.tasks}.
   * `undefined` for any other id.
   */
  detail(id: string): RunDetail | undefined;
  /** The task's record, from the task registry; `undefined` for a task it does not hold. */
  get(id: string): Promise<TaskView | undefined>;
  /** A page of the task registry's tasks, as `query` filters and pages them. */
  list<T = TaskView>(query: TaskListQuery<T>): Promise<TaskListPage<T>>;
  /**
   * Cancels a task and reports where its cleanup stands, waiting up to `waitMilliseconds`
   * (default 0) for the acknowledgement: `cancel-requested`, `canceled`, `cleanup-pending`,
   * `cleaned-up`, `cleanup-failed`, `cleanup-unresolved`, `unknown-outcome`, or `rejected` (the
   * task had already finished). A task the registry does not hold is `NOT_FOUND`.
   */
  cancel(id: string, options?: { readonly waitMilliseconds?: number }): Promise<TaskCancelOutcome>;
  /**
   * Where a `commandId`'s receipt stands: `recorded`, `pending`, `expired`, or `not-found`. A
   * blank principal or command id is `BAD_REQUEST`; without a durable engine, `NOT_CONFIGURED`.
   */
  receipt(query: TaskReceiptQuery): Promise<RunCreationReceiptLocation>;
  /**
   * The durable engine's view of the task's workflow: `null` when the engine does not know it,
   * `undefined` when no durable engine is composed.
   */
  workflow(id: string): Promise<WorkflowState | null | undefined>;
  /** The durable engine's workflows, filtered; `undefined` when no durable engine is composed. */
  workflows(
    filter?: ListFilter,
    options?: ListOptions,
  ): Promise<PaginatedResult<WorkflowSummary> | undefined>;
  /**
   * Resolves with the task's workflow state once it is terminal in the durable store, `null`
   * when the engine does not know it, and `undefined` when no durable engine is composed. Under
   * `maintenance: 'manual'` a task that is not yet terminal rejects (`UNSUPPORTED_CAPABILITY`).
   */
  wait(id: string): Promise<WorkflowState | null | undefined>;
  /**
   * Delivers the task's liveness now and again on every change, until unsubscribed or `signal`
   * fires. A task this process does not hold is `NOT_FOUND`.
   */
  snapshot(
    id: string,
    observer: (snapshot: LivenessSnapshot) => void,
    options?: { signal?: AbortSignal },
  ): Subscription;
  /** A page of the task's durable event history. */
  events(
    id: string,
    options?: DurableEventHistoryPageOptions,
  ): Promise<
    | DurableEventPage
    | DurableEventGap
    | EventHistoryUnsupportedOutcome
    | EventHistoryNotFoundOutcome
    | EventHistoryDeletedAggregateOutcome
  >;
  /** Subscribes to the task's durable event history: a replay from the cursor, then the live tail. */
  subscribeEvents(
    id: string,
    listener: (event: DurableEventEnvelope) => void,
    options?: DurableEventHistorySubscribeOptions,
  ): Subscription;
  /**
   * The task's record, its run's liveness, and the children it owns, for the run inspector;
   * `undefined` for a task the registry does not hold.
   */
  inspect(id: string): Promise<TaskInspection | undefined>;
  /**
   * Answers one open wait of a task as `request.principal`: answer text or structured `data` for
   * a human-input wait, or a `decision` on an approval or a human wait. `signalName` or `callId`
   * says which wait when several are open; with neither, exactly one must be. Only the task's
   * owner may answer, unless `request.operator` is set (see {@link TaskRespondRequest.operator});
   * another owner's task, and a task the registry does not hold, are `NOT_FOUND`. An exact retry
   * of a `messageId` returns the original receipt, even after the task's record is gone; the same
   * `messageId` with another command is `CONFLICT`, as are a task with no open wait and a review
   * already resolved. A malformed request, or an answer the wait cannot take, is `BAD_REQUEST`.
   */
  respond(request: TaskRespondRequest): Promise<TaskRespondResult>;
}

/**
 * The Bureau's audit trail, read as metadata. `bureau.audit.query` served by `createBureauHandler`
 * delegates to {@link BureauAudit.query}, so both return the same records for the same filter.
 * The raw trail is {@link BureauInternals.auditTrail}.
 */
export interface BureauAudit {
  /**
   * Read audit records, oldest first, redacted to metadata. Rejects with a `BureauError`
   * (`UNSUPPORTED_CAPABILITY`) when the Bureau keeps no audit trail (it has no `storage`), and
   * with `BAD_REQUEST` for a `limit` outside 1 to 100 or a `cursor` it did not issue. A page is
   * filled from the records {@link BureauAuditQueryOptions.owner} may see, so a cursor advances across
   * any number of records it may not.
   */
  query(filter?: AuditQuery, options?: BureauAuditQueryOptions): Promise<AuditQueryPage>;
}

/**
 * The durable schedules of a Bureau: registering, reading, and changing recurring schedules, and
 * the history of their definitions. Every operation that needs the durable engine resolves
 * `undefined` when none is composed. `bureau.schedules.*` operations served by
 * `createBureauHandler` delegate to these members.
 */
export interface BureauSchedules {
  /**
   * Register a durable recurring schedule via `engine.schedule(...)`.
   * Throws `ScheduleLocatorUnavailableError` when the schedule was created
   * but its summary could not be immediately retrieved — the schedule IS
   * registered in that case, only its locator failed. Returns `undefined`
   * when no durable engine is composed.
   */
  create(definition: DurableScheduleDefinition): Promise<ScheduleSummary | undefined>;

  /**
   * Retrieve a durable schedule by id. Returns `null` when the schedule does not
   * exist, `undefined` when no durable engine is composed.
   */
  get(scheduleId: string): Promise<ScheduleSummary | null | undefined>;

  /**
   * List durable schedules, optionally filtered. Returns `undefined` when no
   * durable engine is composed.
   */
  list(filter?: ScheduleFilter): Promise<PaginatedResult<ScheduleSummary> | undefined>;

  /**
   * Pause a durable schedule. Returns `true` on success, `undefined` when no
   * durable engine is composed. With `guard.expectedRevision`, the pause applies only if the
   * schedule's `revision` is still that value, and a mismatch throws Weft's
   * `ScheduleStaleRevisionError` having written nothing; Weft compares it inside its serialized
   * write, so Bureau never compares it itself.
   */
  pause(scheduleId: string, guard?: ScheduleRevisionGuard): Promise<true | undefined>;

  /**
   * Resume a paused durable schedule. Returns `true` on success, `undefined` when no durable
   * engine is composed. `guard` as for {@link BureauSchedules.pause}.
   */
  resume(scheduleId: string, guard?: ScheduleRevisionGuard): Promise<true | undefined>;

  /**
   * Cancel and permanently delete a durable schedule. Returns `true` on success,
   * `undefined` when no durable engine is composed. `guard` as for {@link BureauSchedules.pause}.
   */
  cancel(scheduleId: string, guard?: ScheduleRevisionGuard): Promise<true | undefined>;

  /**
   * Change a durable schedule's cadence, description, and overlap policy (COR-1482), by wrapping
   * Weft's `updateSchedule`. Weft replaces the cadence wholesale, so `update.spec` is required, in
   * the same grammar as {@link DurableScheduleDefinition.spec}. The schedule's input, agent, owner
   * and session are not changed. Resolves `true`, or `undefined` when no durable engine is
   * composed. A schedule that does not exist, and a workflow file's schedule (which belongs to its
   * file), reject with `NOT_FOUND`; an overlap Bureau does not offer, or `'allow'` on a schedule
   * with a recurring session, rejects with `BAD_REQUEST`. `guard` as for
   * {@link BureauSchedules.pause}.
   */
  update(
    scheduleId: string,
    update: DurableScheduleUpdate,
    guard?: ScheduleRevisionGuard,
  ): Promise<true | undefined>;

  /**
   * The name of the catalog agent an agent schedule runs, or `undefined` when there is no such
   * schedule, when it is a workflow file's schedule (which runs no agent of its own), or when no
   * durable engine is composed. It is read from the schedule's stored input and is the only part
   * of that input this returns: never its text or its session. It does not check who may see the
   * schedule, so a caller answers to {@link Bureau.ownerOf} first.
   */
  agentName(scheduleId: string): Promise<string | undefined>;

  /**
   * The start of the text an agent schedule sends each fire: at most 500 characters, ending in `…`
   * when it was cut, so a schedule can be told by what it says. `undefined` when there is no such
   * schedule, when it is a workflow file's, when its input holds no text, or when no durable engine
   * is composed. It reads the stored input beside {@link BureauSchedules.agentName}, never its
   * session, and does not check who may see the schedule, so a caller answers to
   * {@link Bureau.ownerOf} first.
   */
  inputPreview(scheduleId: string): Promise<string | undefined>;

  /**
   * One page of the schedule definition's durable event history (`schedule.created`, paused,
   * resumed, and cancelled), from the exclusive `options.since` cursor. It is
   * {@link BureauTasks.events} for the `schedule` owner: the outcomes, `options.principal`
   * authorization, and paging are that method's, so see it for the full contract.
   */
  events(
    scheduleId: string,
    options?: DurableEventHistoryPageOptions,
  ): Promise<
    | DurableEventPage
    | DurableEventGap
    | EventHistoryUnsupportedOutcome
    | EventHistoryNotFoundOutcome
    | EventHistoryDeletedAggregateOutcome
  >;

  /**
   * Replays the schedule definition's durable event history from the exclusive `options.since`
   * cursor, then delivers live events with no gap and no duplicate at the handoff. It is
   * {@link BureauTasks.subscribeEvents} for the `schedule` owner, so an ephemeral bureau returns
   * an already-closed subscription and `options.principal` applies as it does there.
   */
  subscribeEvents(
    scheduleId: string,
    listener: (event: DurableEventEnvelope) => void,
    options?: DurableEventHistorySubscribeOptions,
  ): Subscription;
}

/**
 * The contexts (sessions) of a Bureau: reading and deleting them, signalling a parked run, admitting
 * input and steering, branching, and the history of their events. A context is the durable
 * conversation a task runs in; `bureau.contexts.*` operations served by `createBureauHandler`
 * delegate to these members. None of them authorizes the caller: that is the caller's to do, as for
 * {@link BureauContexts.get}.
 */
export interface BureauContexts {
  /** The summaries of the contexts this Bureau holds, as `options` filters, sorts, and pages them. */
  list(options?: SessionListOptions): Promise<SessionSummary[]>;

  /** One context by id, or `undefined` when this Bureau does not hold it. */
  get(id: string): Promise<AgentSession | undefined>;

  /**
   * Deletes a session (a context), and resolves a {@link ContextDeletionReport} of
   * what the deletion did to the tasks that were live in it (COR-1481). A caller
   * that ignores the report is unaffected.
   *
   * The deletion fences the session first: while it is in flight, a new run on the
   * id, session input to it, and a signal to it read as a session that does not
   * exist. It cancels every live run in the session, not only the latest, then
   * deletes the session, and empties the originating message history of each of
   * its tasks. With `options.incarnation` it deletes only that incarnation of the
   * session: an id reused since the caller read the session is left untouched and the
   * report says nothing was deleted. It resolves when every run it cancelled has ended; each task's
   * `closed` acknowledgement may settle later.
   */
  delete(
    id: string,
    options?: { readonly incarnation?: string | undefined },
  ): Promise<ContextDeletionReport>;

  /**
   * Deliver a fire-and-forget signal to a session's current in-flight durable run.
   * Maps to `engine.signal(runId, name, payload)`. Requires a durable engine and a
   * session store. Throws `BureauError('NOT_CONFIGURED', subject: 'durable')` when no durable
   * engine is composed; throws `BureauError('NOT_FOUND')` when the session has no current run.
   */
  signal(contextId: string, name: string, payload?: unknown): Promise<void>;

  /**
   * AB-42/AB-194 — admit a caller's session input as a fifth session verb.
   * Pre-admission checks run in AB-42's fixed order: authorization, then
   * session lifecycle, then capability/capacity. An unauthorized caller or an
   * unknown `sessionId` returns `{ outcome: 'not-found' }` (indistinguishable
   * by design — the document's authorization-denial rule). An authorized
   * caller naming a session already in a terminal state returns
   * `{ outcome: 'session-terminal', sessionId }`. Both checks consult this
   * process's live runs (COR-301, `resolveSessionPreAdmission`): a session
   * with any live run is not terminal, whichever run last wrote
   * `lastRunStatus`, and authorization targets the session's sole live run,
   * falling back to `lastRunId` only when several runs are live.
   *
   * On a durably-configured Bureau every other authorized, non-terminal
   * request is admitted to the session's durable mailbox (`admitted`,
   * `replayed`, `conflict`, or `backlog-exhausted`). Each admitted input ends
   * with exactly one terminal receipt. It reads `promoted` once a live run's
   * step boundary appends its user turn to the conversation: before the run's
   * next step generates, or once more after its last step generated while the
   * run has a step left. The turn is appended at most once, in admission order
   * within a run, keyed by the mailbox command so a reused `id` is a new input
   * (an `id` must therefore be unique for the life of the session: the turn
   * carries it as its message id, and a second turn under the same `id` takes
   * a fresh message id instead),
   * under the input's own `id` as its message id, and the promotion commits in
   * the write that saves the turn, whatever that step's outcome. It reads
   * `canceled` when the input was not appended before its run ended, however
   * it ended (completed, failed, cancelled through `tasks.cancel`, or promoted
   * but never started), so the client resends it; Bureau never starts a run to
   * answer input, and the ending run cancels what it never delivered unless
   * another run of the session is live, whose end does the cancelling. With no
   * run live or starting when the admission commits, this call cancels the
   * input itself and returns the re-read receipt. Shutdown releases open input
   * instead, for the next boot's recovered run to deliver or its sweep to
   * cancel. An input still undelivered after seven days reads `expired`, one
   * whose session is deleted reads `canceled`, and one that cannot be decoded
   * reads `failed`. `steer` and `queue` share that one FIFO path; `expiresAt`
   * and `supersedes` are stored but not yet honored. A Bureau with no session
   * mailbox, durable storage, or key-value store, or a session id too long to
   * address a mailbox, returns `{ outcome: 'unsupported-capability', reason:
   * 'durable-mailbox-unavailable' }`.
   */
  input(
    contextId: string,
    request: SessionInputAdmissionRequest,
  ): Promise<SessionInputAdmissionOutcome>;

  /**
   * COR-1490 — the identifiers of the conversation rows `runId` itself took session input into,
   * in delivery order, from the durable delivery record (which commits with the transcript the
   * run saved). Empty for a run that delivered none, and for a Bureau with no session mailbox.
   */
  inputsDeliveredBy(taskId: string, contextId: string): Promise<readonly string[]>;

  /**
   * AB-67/AB-199/AB-200 — admit a steering command as a sixth session verb,
   * for in-memory and durable sessions alike. Reads
   * authority and terminal status through the same pre-admission decision
   * `contexts.input` uses (`resolveSessionPreAdmission`, COR-301), over
   * the session's live runs: authorization targets the request's `runId`,
   * else the session's sole live run, else `lastRunId`; and a session with
   * any live run is not terminal. An unauthorized caller or unknown
   * `sessionId` returns `{ outcome: 'not-found' }`; an authorized caller
   * naming an already-terminal session returns `{ outcome: 'session-terminal',
   * sessionId }`.
   *
   * All seven targets are admitted (AB-199/AB-200/AB-68, COR-1227):
   * `pause`/`resume` bind to one run; `agent-identity` is deferred to the
   * session's next run, and its `override` must name a key of this
   * Bureau's `agents` map (otherwise `rejected` with `policy-denied`);
   * `route`, `model`, `provider`, and `effort` apply at the next step
   * boundary. A configuration `override` is checked against the live model
   * catalog (`route` is not catalog-validated), and a configuration
   * `policyRef` resolves through `modelPolicy.users` — an unknown profile,
   * a profile that omits the coordinate, or an uncatalogued coordinate is
   * `rejected` with `policy-denied`. Only an `agent-identity` `policyRef`
   * returns `{ outcome: 'unsupported-capability', reason:
   * 'selector-unavailable' }`.
   *
   * Durable sessions are admitted too, through the session's durable
   * steering log (`steering-log.ts`): an append-only log of every
   * admission and run-boundary transition, with the inputs each was decided
   * from, committed atomically and never consumed. The session's gate is a
   * fold of it, so desired configuration, agent identity, pause state,
   * command states, and `configVersion` survive any number of restarts, and
   * every Bureau process sharing the backend folds the same history before
   * it decides. An exact `(principal, id)` retry replays and a mismatched
   * one conflicts after any restart and across sessions and processes; a
   * refused command's id stays decided too, answering an exact retry with
   * the original refusal. `pause`/`resume` bind against the session's live
   * runs in every process sharing the backend. A run reads its own process's gate: steering
   * admitted by another process reaches it when this process next folds
   * the log (before its next admission or run). `{ outcome:
   * 'unsupported-capability', reason: 'durable-steering-unavailable' }` is
   * returned only by the guard for a durably-configured Bureau with no
   * resolved storage backend, which normal composition does not produce.
   *
   * A `pause` against an authorized, non-terminal session is
   * accepted, increments the session's `configVersion` by exactly one, and
   * is idempotent against a second `pause` while the first is still
   * `accepted`/`applied` (no second increment). A `resume` against a session
   * that is not currently paused is accepted as a no-op, matching the
   * idempotent-abort precedent at
   * `documentation/operative-type-safe-api.md#required-capabilities`. An `accepted`
   * pause/resume transitions to `failed` with `SteeringCommandFailure.reason
   * = 'run-terminal'` if the targeted run aborts or completes before its
   * `runStep` boundary is reached. An exact retry of the same
   * `(principal, id)` with an identical `requestedValue` replays the
   * original command's current state; a same-`id`, different-`requestedValue`
   * reuse returns a typed conflict.
   */
  steer(
    contextId: string,
    request: SteeringCommandRequest,
  ): Promise<SteeringCommandAdmissionOutcome>;

  /**
   * What the session's steering has settled on (COR-1559): its latest admitted `model` override
   * and its `configVersion`. On a durable Bureau the session's log is folded first, so the answer
   * includes commands another process admitted. `undefined` for a session this Bureau does not
   * hold. It does not authorize the caller: that is the caller's to do, as for `contexts.get`.
   */
  steering(contextId: string): Promise<SessionSteeringState | undefined>;

  /**
   * Branches a session after a completed agent reply (COR-1560): a new session, owned by
   * `request.owner`, whose history is the parent's through `throughMessageId`, which must be the
   * final assistant message of a run that ended `completed` in this session, with no tool approval
   * pending and no tool call left without a result. The parent is unchanged. The new session
   * records where it came from (`SessionSummary.parentContextId`, `forkedFromMessageId`) and keeps
   * the parent's model choice: its latest `model` override is admitted on the fork as
   * `<commandId>:model`, and that outcome is returned beside the new `contextId`; a refusal of it
   * leaves the fork in place, on the agent's default.
   *
   * `commandId` is recorded in the durable command ledger (COR-424): an exact retry, even after a
   * restart, returns the original result and creates nothing more, and a crash between the steps
   * never forks twice. The same `commandId` with another `throughMessageId` throws a
   * {@link SessionForkRefusedError} with reason `command-conflict`; a message that is not a branch
   * point throws one naming why, and nothing is created. It does not authorize the caller: that is
   * the caller's to do, as for `contexts.get`. Throws a `BureauError` `CONFLICT` when Bureau is
   * shutting down.
   */
  fork(contextId: string, request: ForkSessionRequest): Promise<ForkSessionResult>;

  /**
   * One page of the context's durable event history, from the exclusive `options.since` cursor. It
   * is {@link BureauTasks.events} for the `session` owner: the outcomes, `options.principal`
   * authorization, and paging are that method's, so see it for the full contract.
   */
  events(
    contextId: string,
    options?: DurableEventHistoryPageOptions,
  ): Promise<
    | DurableEventPage
    | DurableEventGap
    | EventHistoryUnsupportedOutcome
    | EventHistoryNotFoundOutcome
    | EventHistoryDeletedAggregateOutcome
  >;

  /**
   * Replays the context's durable event history from the exclusive `options.since` cursor, then
   * delivers live events with no gap and no duplicate at the handoff. It is
   * {@link BureauTasks.subscribeEvents} for the `session` owner, so an ephemeral bureau returns an
   * already-closed subscription and `options.principal` applies as it does there.
   */
  subscribeEvents(
    contextId: string,
    listener: (event: DurableEventEnvelope) => void,
    options?: DurableEventHistorySubscribeOptions,
  ): Subscription;
}

/**
 * The seam between a Bureau and the code that serves or tests it: `createBureauHandler` reads
 * these members to serve the operations, and the test harness reads them to inspect what the
 * Bureau holds. An application builds on the other members of {@link Bureau}; none of these
 * is part of its surface, and the project may reshape them without a deprecation period.
 */
export interface BureauInternals {
  /**
   * Whether {@link BureauOptions.id} was supplied. `false` means {@link Bureau.id}
   * is a generated identifier that changes on every restart, which
   * `createBureauHandler` refuses to serve over persistent storage because it
   * would orphan whatever that storage holds.
   */
  readonly hasExplicitId: boolean;

  /**
   * How long a settled task stays addressable: {@link BureauRetentionOptions.tasks}, or its
   * 30-day default when none was given.
   */
  readonly taskRetention: RetentionWindowOption;

  /**
   * Whether this bureau has storage and a durable engine. Only such a bureau
   * keeps run-creation receipts and human-wait parks across a restart, so an
   * adapter that promises either (the AG-UI mount of `createBureauHandler`)
   * refuses a bureau without one.
   */
  readonly hasDurableEngine: boolean;

  /**
   * This bureau's own events, as a replay-plus-live feed.
   *
   * The same events `addEventListener`/`subscribe` deliver, but recorded with
   * cursors, so a client that reconnects resumes where it stopped instead of
   * missing whatever happened while it was away. Serve it as `bureau.events`
   * by registering this bureau's id against it — see
   * `createBureauEventRegistry`.
   *
   * Shutdown ends every subscriber rather than leaving it hanging, but does
   * not promise a final `bureau.disposed` envelope — see Weft's
   * `bindFeedLifetime` for why. A client treats the stream ending as the
   * signal.
   *
   * Named `eventFeed` because `events` is already this interface's
   * async-iterator method.
   */
  readonly eventFeed: BureauEventFeed;

  /**
   * The event feeds of the runs this bureau owns, keyed by run id.
   *
   * A bureau owns its operatives' events as well as their lifecycles: it
   * creates each run's feed before registering the run, pumps the run into
   * it, and reaps it when the run is removed. Pass this as the
   * `operative.runs.events` engine's `runFeeds` and a client can watch any
   * run this bureau started.
   *
   * A feed outlives its run's completion and is reaped when the run's task
   * expires under {@link BureauRetentionOptions.tasks}, so a client that
   * subscribes on hearing `run.completed` still gets the whole history. A
   * host that keeps `retention.tasks` at `'forever'` retains them.
   *
   * Read-only: entries are bureau's to create and remove.
   */
  readonly runEventFeeds: AgentRunEventRegistry;

  readonly store: Store;

  readonly sessionStore: SessionStore | undefined;

  readonly kv: ConditionalTextValueStore | undefined;

  /**
   * The durable audit trail (Layer B glass-box).
   *
   * Present when the bureau has a KV store configured (`storage`). `undefined`
   * when the bureau is ephemeral (no `storage`).
   *
   * The audit trail sinks `tool.*`, `run.*`, and `step.completed` events into
   * the KV store as an append-only log. Use `auditTrail.query()` to read them
   * back with optional `since`, `runId`, and `type` filters.
   *
   * Layer A (live) = `store.getState()` + `memory.list()` + `getSession()`.
   * Layer B (durable) = `auditTrail.query()`.
   */
  readonly auditTrail: AuditTrail | undefined;

  /**
   * The webhook notifier (AB-21). Present whenever `options.webhooks.targets`
   * is non-empty; `undefined` when no webhooks are configured (the default).
   * Use `webhookNotifier.listDeliveries()` to inspect durable delivery state.
   */
  readonly webhookNotifier: WebhookNotifier | undefined;

  /**
   * The online eval sampler (AB-53). Present whenever `options.onlineEvals`
   * configures at least one judge with a positive `sampleRate`; `undefined`
   * when online evals are disabled (the default). Use
   * `onlineEvalSampler.sampledCount()`/`observedCount()` to inspect sampling
   * state and `onlineEvalSampler.flush()` to await in-flight judge
   * evaluations deterministically.
   */
  readonly onlineEvalSampler: OnlineEvalSampler | undefined;

  /**
   * AB-369: every run whose cancellation `tasks.cancel` or a task handle's `abort` has requested
   * but whose `activeRun.closed()` has not yet settled, read from the abort bookkeeping rather
   * than inferred. `since` is the {@link RuntimeServices.clock} timestamp of the first request
   * for that run.
   * A run still listed here long after its abort should have settled is a
   * genuine leak — {@link BureauQuiescenceReport} (`bureau/test`) surfaces
   * it as a non-quiescent row.
   */
  abortingTasks(): readonly AbortingRun[];

  /**
   * COR-1490 — resolves once the session has recorded the end of the run `runId`, however long
   * its save takes (it waits on the save itself, never on a count of turns), and at once for a run
   * whose end is already recorded or that this process does not hold (so a reader in another
   * process can read a session that does not yet hold the run's final rows).
   *
   * Rejects when the run ended without this process saving its end: the engine lost a checkpoint
   * compare-and-swap or was disposed and abandoned the run to whoever owns it, or the Bureau shut
   * down first. The rejection comes when the run's own result settles, never at a deadline. A save
   * that starts and keeps failing does not reject: it is diagnosed after its last attempt and this
   * resolves, so a reader should check that the session holds what it needs. A reader that needs
   * the thread as the run left it, such as the AG-UI mount's end-of-run snapshot, waits here before
   * it reads the session.
   */
  whenTaskRecorded(runId: string): Promise<void>;

  /**
   * COR-1481 — the task registry behind `bureau.tasks.*`: the durable record of
   * each top-level run (its owner, context, originating message, and how it ended),
   * and the reads and cancellation the management plane serves over it. See
   * `task-registry.ts`.
   */
  readonly taskRegistry: TaskRegistry;
}

export interface Bureau<D extends AgentDefinitions = AgentDefinitions> {
  /** This bureau's identity — {@link BureauOptions.id}, or a generated one. */
  readonly id: string;
  /**
   * The reviews awaiting a human decision, and the decision (`list`, `get`, `resolve`,
   * `pendingOf`). See {@link BureauReviews}.
   */
  readonly reviews: BureauReviews;
  /**
   * The durable schedules: `create`, `get`, `list`, `pause`, `resume`, `cancel`, `update`, the
   * `agentName` and `inputPreview` of an agent schedule, and the schedule definition's event
   * history (`events`, `subscribeEvents`). See {@link BureauSchedules}.
   */
  readonly schedules: BureauSchedules;
  /**
   * The contexts (sessions): `list`, `get`, `delete`, `signal`, `input`, `inputsDeliveredBy`,
   * `steer`, `steering`, `fork`, and the context's event history (`events`, `subscribeEvents`).
   * See {@link BureauContexts}.
   */
  readonly contexts: BureauContexts;
  /**
   * The tasks: `start` one, and `detail`, `get`, `list`, `cancel`, `receipt`, `workflow`,
   * `workflows`, `wait`, `snapshot`, `events`, `subscribeEvents`, and `inspect`. See
   * {@link BureauTasks}.
   */
  readonly tasks: BureauTasks<D>;
  /**
   * The audit trail read as redacted metadata: `query(filter, options?)`. See {@link BureauAudit}.
   */
  readonly audit: BureauAudit;
  /**
   * The seam the handler and the test harness read: stores, event feeds, and the task registry.
   * It is not part of the surface an application builds on. See {@link BureauInternals}.
   */
  readonly internals: BureauInternals;
  /**
   * The runtime this bureau runs on: {@link BureauOptions.runtime}, or the process's own services
   * when none was given. An adapter that compares a deadline or schedules a timer for the
   * bureau (the A2A mount of `createBureauHandler`) reads it here, so a custom runtime governs
   * the adapter too and not only the bureau.
   */
  readonly runtimeServices: RuntimeServices;
  readonly memory: GovernedMemory | undefined;
  /**
   * The model namespace: the catalog the deployment offers (`catalog()`, `replace(rows)`), the
   * `generate` for a row, and `plan(request)`, which builds the `SelectionPlan` a request would be
   * given against the current catalog and {@link BureauOptions.modelPolicy} without starting a
   * run. Present regardless of `D`, matching the rule that Bureau's administrative surface does
   * not depend on the registered agent set.
   */
  readonly models: Models;
  /**
   * COR-1709 — ask a model a typed question: `decide(request, options?)`. See
   * {@link BureauDecisions}.
   */
  readonly decisions: BureauDecisions;
  /**
   * COR-1710 — the deployment's runtime settings: `get`, `schema`, `update`, and `subscribe` over
   * the revisioned `settings` record. See {@link BureauSettings}.
   */
  readonly settings: BureauSettings;

  /**
   * The typed agent catalog (AB-15, AB-22) — the immutable, read-only view
   * over `BureauOptions.agents`. `bureau.agents.has(name)` narrows a literal
   * string to a known agent name where TypeScript permits it.
   */
  readonly agents: BureauAgentCatalog<D>;
  /**
   * COR-1527 — the workflow files in {@link BureauOptions.workflowSource}, or `undefined` when
   * the Bureau has none. Every workflow belongs to the deployment's owner of record.
   */
  readonly workflows: BureauWorkflows | undefined;

  /**
   * COR-772 — Bureau's durable parent-child topology: dispatch a catalog
   * agent as the child of a run this bureau knows (a task, or another child),
   * then list, get, wait on,
   * signal, and cancel it by its stable identifier — including after a
   * process restart. Every operation names the owning parent; naming an
   * unrelated parent reads as `not-found`. A child never shares its
   * parent's abort signal: cancelling a parent through `tasks.cancel`,
   * its own `TaskHandle`, or `children.cancel`
   * applies each child's recorded `parentCancellation` policy instead. See
   * `child-topology.ts`.
   */
  readonly children: BureauChildren<AgentNames<D>>;

  /**
   * COR-1670 — the journal that makes a peer call survive a restart: hand it to
   * `createPeerCallTool({ durable })`. A durable run's tool call records the A2A task it started
   * here, keyed by the run and the call's operation key, and the replay of that call after a
   * restart follows the recorded task instead of sending again. Each record carries a digest of
   * its request, so a replay that makes a different request at the same position is refused.
   * Records are deleted when the run's task is removed (`run.removed` of a non-catalog run, or
   * retention expiring its task). A run that has no task record, such as a child, a goal attempt
   * or a workflow step, keeps its records, and so does a run deleted while its call was in flight:
   * a record written after the deletion is never read. Agents are built before the Bureau, so the
   * tool reaches the journal through a reference set once the Bureau exists (see the README). A
   * write for a run this Bureau never knew is refused.
   */
  readonly peerCalls: PeerCallJournal;

  /**
   * COR-851 — durable goals: create a goal, read and list it, see what it has
   * in flight, cancel it, close it once it has ended, and recover every
   * unfinished one after a restart. A goal's record, its controller, and each
   * attempt's run all survive the process. Needs a durable engine and the
   * validators named in {@link BureauOptions.validators}. See `goal-types.ts`.
   */
  readonly goals: BureauGoals<AgentNames<D>>;

  /**
   * The owner of record of a resource (COR-718), or `undefined` when no such
   * resource exists. The owner is the principal that created the resource,
   * stored once at creation and unchanged afterward; a service principal such as
   * `system:scheduler` is only ever the actor on an audit entry, never an owner.
   * A resource created with no stated principal, and a record persisted before
   * owners existed, read as `anonymous:local`.
   *
   * - `run`: the principal the run was created with (`CreateRunRequest.principal`,
   *   or its schedule's owner for a schedule fire, or its parent's for a child).
   * - `session`: the owner of the run that created it.
   * - `goal`: the goal request's `principal`.
   * - `schedule`: `DurableScheduleDefinition.principal`.
   * - `review`: its run's owner.
   * - `audit`: derived from the entry, never stored on it as a field of its own: a
   *   run id gives that run's owner, `schedule:<id>` the schedule's, and
   *   `session:<id>` (a `session.deleted` entry) the `owner` its `detail` records.
   *   Bureau captures that owner at deletion, so the answer never depends on the
   *   live session, which may be gone or recreated under another owner. An entry
   *   without one, such as a deletion that bypassed Bureau, has no owner.
   */
  ownerOf(resource: OwnedResource): Promise<string | undefined>;

  /**
   * The durable Weft engine this bureau composed, or `undefined` when none is composed. It is the
   * engine that checkpoints and owns this bureau's runs, so a host that serves Weft's own API or
   * console over the same runs hands out this one rather than building a second engine over the
   * same storage: a second engine holds no lease on these runs, so its cancel is not fenced by
   * their owner and its live feed does not see them. The bureau still owns it. The host must not
   * dispose it, and must not register workflows on it or start its own background tasks.
   *
   * This is an admin surface for one local principal. Every operation on the engine, a cancel, a
   * signal, a start, bypasses the checks `tasks.start` and the session verbs make on the caller's
   * ownership of a session or run, so a host that serves it must authenticate its callers
   * itself. Hand it only to a host that answers to a single trusted caller, such as a local
   * console.
   */
  durableEngine(): RegistryAgnosticEngine | undefined;

  /**
   * Run one host-driven durable-engine maintenance cycle. This fires due
   * timers and schedules and performs Weft's cleanup, retention, and alert
   * maintenance. Intended for `maintenance: 'manual'` hosts.
   *
   * Also prunes a session's `lastRunOwningPrincipals` entries (AB-359) once
   * a run's entire durable event history has fallen below the fleet feed's
   * retention floor (AB-363) — never on a run's terminal transition, and
   * never on a count. AB-388: also prunes the durable audit trail per
   * `BureauRetentionOptions.audit` (default `'forever'`, a no-op) — see
   * that option's own doc comment. COR-424: also deletes run-creation
   * receipts whose `retention.receipts` window has passed, with
   * their conflict records; the automatic profile does the same on its own
   * maintenance interval.
   *
   * AB-388 (Codex review, PR #597, "Document the KV-only maintenance
   * return value"): resolves `true` whenever there was ANY maintenance
   * surface to drive — a composed durable engine, OR just a KV-backed
   * audit trail with no durable engine at all (a persistent backend with
   * `durable: false`). This
   * used to document `undefined` for "no durable engine is composed",
   * which was accurate before this issue but is no longer: a KV-only
   * bureau now genuinely has maintenance to run (audit retention) even
   * with no engine, and this method returns `true` for that case, not
   * `undefined`. `undefined` is reserved for the fully ephemeral case —
   * no durable engine AND no KV-backed audit trail — where there is
   * nothing at all for this method to do.
   *
   * COR-1477: task retention is part of that surface. A pass that removed
   * terminal tasks past `BureauRetentionOptions.tasks` resolves `true` even in
   * a fully ephemeral bureau, because it did maintain something; one that
   * removed none there still resolves `undefined`.
   */
  maintain(now?: number): Promise<true | undefined>;

  /**
   * Installs the host-owned authority freshness check used immediately before
   * a delayed tool approval is resumed. Transports that issue revocable
   * credentials should configure this when they attach to the bureau.
   */
  setRequestAuthorityValidator(
    validator: ((context: ToolRequestContext) => boolean | Promise<boolean>) | undefined,
  ): void;

  /**
   * Waits for boot durable recovery to finish and resolves a typed
   * {@link BureauRecoveryReport} describing its outcome. A Bureau with no durable engine has
   * no runs to recover, so with nothing recorded to sweep this resolves
   * `{ outcome: 'clean', perRunFailures: [], skippedRuns: [] }` immediately.
   *
   * `createBureau()` returns once boot recovery has STARTED — `recoverAll()`
   * has begun resuming recovered handles and each owned run has been
   * registered — not once recovery, or the resumed runs themselves, have
   * completed. A recovered run's first step can dispatch tool calls before a
   * caller's own post-boot dependency wiring (webhook targets, event
   * listeners, and the like) is ready.
   *
   * That timing is DIFFERENT on the two paths this method covers, so what
   * `await recovery()` buys a caller is different too:
   *
   * - **Recovery not deferred** (the common case: `requestAuthorityValidator`
   *   is set in `BureauOptions`, or no persisted session has an in-flight run
   *   under transport-issued authority). `createBureau()` itself already
   *   awaits this same barrier before resolving, so by the time a caller HAS
   *   a `bureau` to call `recovery()` on, recovery classification is
   *   already done and any recovered run may already be advancing. Calling
   *   `recovery()` here reports that (already-settled) fact; it
   *   cannot retroactively delay a recovered run's already-dispatched first
   *   step. A caller with post-boot dependency wiring that a recovered run
   *   will need must finish that wiring BEFORE calling `createBureau()` (or
   *   supply it via `BureauOptions` at construction) — there is no
   *   after-the-fact seam on this path.
   * - **Recovery deferred** (a host that calls `createBureau()` without
   *   `requestAuthorityValidator` and attaches one later with
   *   `setRequestAuthorityValidator()`, when durable execution finds a
   *   persisted session whose in-flight run carries transport-issued
   *   authority — an `authorizationRevision` other than Bureau's own — or
   *   cannot read the sessions to check). `createBureau()` resolves without
   *   starting recovery, and recovery does not start at all until
   *   `setRequestAuthorityValidator()` is called with a validator, so a
   *   caller that finishes its dependency wiring before or immediately after
   *   that call, then `await`s `recovery()`, genuinely gates on
   *   recovery's classification/reattachment pass completing.
   *   `recovery()` is the only way to observe when that deferred pass
   *   finishes.
   */
  recovery(): Promise<BureauRecoveryReport>;

  /**
   * Subscribe to every live frame. The FIRST subscriber is also replayed, in
   * emission order, the frames emitted during boot recovery and by the runs it recovered (at
   * most the newest 1024), so a recovered run that emitted while `createBureau()` was
   * still awaiting is not lost to a caller that can only subscribe after it
   * returns. The replay runs in a microtask, after this call has returned its unsubscribe
   * handle, so a listener may unsubscribe itself from inside it. Later
   * subscribers receive only new frames. Emitter listeners get
   * no such replay; register them through {@link BureauOptions.onEvent}.
   */
  frames(listener: (frame: ServerFrame) => void): () => void;

  addEventListener<K extends keyof BureauEventMap & string>(
    type: K,
    listener: (event: BureauEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;

  removeEventListener<K extends keyof BureauEventMap & string>(
    type: K,
    listener: (event: BureauEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;

  on<K extends keyof BureauEventMap & string>(
    type: K,
    options?: EventObservableOptions,
  ): ObservableLike<BureauEventMap[K]>;

  once<K extends keyof BureauEventMap & string>(
    type: K,
    listener: (event: BureauEventMap[K]) => void,
  ): void;

  subscribe<K extends keyof BureauEventMap & string>(
    type: K,
    observerOrNext?: Observer<BureauEventMap[K]> | ((value: BureauEventMap[K]) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ): Subscription;

  toObservable(): ObservableLike<BureauEventMap[keyof BureauEventMap]>;

  events<K extends keyof BureauEventMap & string>(
    type: K,
    options?: EventIteratorOptions,
  ): AsyncIterableIterator<BureauEventMap[K]>;

  complete(): void;
  readonly completed: boolean;
  readonly signal: AbortSignal;

  dispose(): Promise<void>;

  /**
   * Awaited drain of everything Bureau owns (AB-207/AB-37). `dispose()` is a
   * thin wrapper — `shutdown({ policy: 'abort' })` awaited to completion —
   * kept for the existing `Promise<void>` external shape; prefer `shutdown()`
   * directly when the report is useful.
   *
   * `'abort'` (the default when `policy` is omitted) aborts every active run
   * this process started immediately, then awaits every drain. A durable run this process
   * recovered at boot is left running for the next process to recover, as `'detach'` leaves it,
   * and is counted in the report's `detached`. `'drain'` closes admission
   * identically but lets every already-active caller-owned agent run
   * (task-owned) reach its own natural terminal result while
   * Bureau-owned background work (online-evals, webhook notifier,
   * audit trail) is stopped/awaited exactly as under `'abort'`.
   * `'detach'` closes admission identically, leaves durable caller-owned runs recoverable,
   * aborts process-local and catalog runs, waits errored runs, and stops/awaits Bureau-owned
   * background work exactly as under `'abort'`. Toolbox cleanup is always abortive for detach.
   *
   * `timeoutMilliseconds` bounds the WAIT only: on elapse, `shutdown()`
   * resolves (never rejects) with every already-settled owner's real outcome
   * and every still-outstanding owner reported `'unresolved'` — the
   * underlying teardown keeps running to completion in the background, it is
   * never abandoned. Omitting it waits indefinitely, matching today's
   * `dispose()`. That wait sleeps on the RESOLVED runtime
   * (`RuntimeServices.timers`, never a real timer directly — see
   * {@link BureauShutdownOptions.timeoutMilliseconds}), so under a manual
   * runtime the caller owns advancing the clock far enough for a bounded
   * wait to elapse — `bureau/test`'s `BureauTestHarness.close()` is the one
   * built-in exception, owning that advance itself (Coordinator ruling on
   * AB-338).
   *
   * Calling `shutdown()` (or `dispose()`) more than once is idempotent: every
   * call after the first returns the same cached report promise, regardless
   * of the policy passed to the later call.
   */
  shutdown(options?: BureauShutdownOptions): Promise<BureauShutdownReport>;
  /**
   * COR-1631 — the task's interactive surfaces: create, compare-and-swap update,
   * snapshot, action admission, close, owner abort, and cleanup, kept in the
   * task's durable history (see `documentation/interactive-surface.md`).
   * `undefined` for a Bureau without persistent durable execution
   * (`durable` over persistent storage), which keeps no durable history.
   */
  readonly surfaces: InteractiveSurfaces | undefined;
  /**
   * COR-1481 — where the Bureau is in its life: `ready`, `draining` once
   * `shutdown()` has closed admission, `stopped` once it has completed.
   */
  readonly lifecycle: 'ready' | 'draining' | 'stopped';

  /**
   * The managed-asset service (COR-794). Present whenever `options.assets`
   * is configured; `undefined` otherwise (the default). `shutdown()` aborts
   * its in-flight asset work and awaits every cleanup acknowledgement.
   */
  readonly assets: AssetService | undefined;
}

/**
 * Reads one page of an owner's durable event history. {@link BureauTasks.events},
 * {@link BureauContexts.events}, and {@link BureauSchedules.events} are this read narrowed to their
 * owner kind.
 */
export type DurableEventHistoryRead = (
  owner: DurableEventOwner,
  options?: DurableEventHistoryPageOptions,
) => Promise<
  | DurableEventPage
  | DurableEventGap
  | EventHistoryUnsupportedOutcome
  | EventHistoryNotFoundOutcome
  | EventHistoryDeletedAggregateOutcome
>;

/**
 * Subscribes to an owner's durable event history: a replay from the cursor, then the live tail.
 * Each namespace's `subscribeEvents` is this subscription narrowed to its owner kind.
 */
export type DurableEventHistorySubscribe = (
  owner: DurableEventOwner,
  listener: (event: DurableEventEnvelope) => void,
  options?: DurableEventHistorySubscribeOptions,
) => Subscription;

/**
 * Returned by an event history read ({@link BureauTasks.events} and its siblings) when the bureau has no
 * persistent storage backend configured.
 */
export interface EventHistoryUnsupportedOutcome {
  readonly outcome: 'unsupported-capability';
  readonly reason: 'no-persistent-storage';
}

/**
 * Returned by an event history read ({@link BureauTasks.events} and its siblings) (AB-313) when `options.principal`
 * is provided and does not match `owner`'s recorded principal — the same
 * not-found-shaped denial `submitSessionInput` (AB-42/AB-194) returns, so an
 * unauthorized caller cannot distinguish "no such run/session" from "exists,
 * not yours."
 */
export interface EventHistoryNotFoundOutcome {
  readonly outcome: 'not-found';
}

/**
 * Returned by an event history read ({@link BureauTasks.events} and its siblings) (AB-313) when `owner`'s live
 * Bureau record is gone (its task expired under `retention.tasks`, or a deleted session) but this store
 * still holds committed durable events for it — distinguishable from both
 * an ordinary empty {@link DurableEventPage} (an id nothing was ever
 * recorded under) and {@link EventHistoryNotFoundOutcome} (no committed
 * events at all). Carries the same page fields as `DurableEventPage` so the
 * already-committed events remain queryable through this one call — AB-87's
 * retention/deletion posture is that deleting the owner record never
 * deletes its history.
 */
export interface EventHistoryDeletedAggregateOutcome extends DurableEventPage {
  readonly outcome: 'deleted-aggregate';
  readonly owner: DurableEventOwner;
}

// ── API Request / Response Types ─────────────────────────────────────

/**
 * AB-369: a run `abortRun` requested cancellation for whose cleanup has not
 * yet settled — one row per entry `abortRun`'s own `abortingRunIds`
 * bookkeeping holds. See {@link Bureau.internals.abortingTasks}.
 */
export interface AbortingRun {
  readonly runId: string;
  readonly since: number;
}

/** A resource whose owner of record {@link Bureau.ownerOf} reads. */
export type OwnedResource =
  | { readonly kind: 'run' | 'session' | 'goal' | 'schedule' | 'review'; readonly id: string }
  | {
      readonly kind: 'audit';
      readonly runId: string;
      /** The audit entry's `detail`. A `session.deleted` entry's owner is `detail.owner`. */
      readonly detail?: unknown;
    };

/** What {@link BureauContexts.delete} did (COR-1481). */
export interface ContextDeletionReport {
  /** Whether a session existed and was deleted. */
  readonly deleted: boolean;
  /**
   * The tasks that were live when the deletion began, each with the cleanup
   * acknowledgement of its run, which settles when the run's cleanup does.
   */
  readonly tasks: readonly {
    readonly taskId: string;
    readonly closed: Promise<RunCleanupAcknowledgement>;
  }[];
}

export interface RunSummary {
  id: string;
  sessionId: string;
  status: string;
  steps: number;
  /**
   * Token usage, including AB-92's `cacheCreationTokens`/`cacheReadTokens`
   * when the provider reported them (absent, never fabricated as `0`, when
   * it did not — see {@link TokenUsage}).
   */
  usage: TokenUsage;
  finishReason: string | undefined;
  error: string | undefined;
  actionCount: number;
  /**
   * The agent that ran this run (AB-54 usage analytics grouping). Resolved
   * deterministically from `CreateRunRequest.agentName` (falling back to the
   * house default) at run-creation time. A run reattached after durable
   * recovery — whose process restarted, losing the in-memory resolution —
   * falls back to the tool-bubble-event heuristic and may be `undefined` for
   * a recovered run with no tool activity yet.
   */
  agentName: string | undefined;
  /**
   * The owner of record of the run: the principal it was created with
   * (e.g. `api-key:<id>`), from the run's attribution, or the owner its
   * liveness snapshot reports when no attribution was recorded (one
   * reader, shared with {@link Bureau.ownerOf}). A run reattached after
   * durable recovery keeps it: it is rehydrated from the owning session's
   * `lastRunOwningPrincipals` (AB-359). A run created with no principal reads
   * `undefined` on the direct branch and `anonymous:local` on the durable one;
   * {@link Bureau.ownerOf} and the AG-UI mount read both as `anonymous:local`
   * through the same default.
   */
  principal: string | undefined;
  /**
   * Epoch-ms timestamp of the run's first recorded action (`run.started`).
   * `undefined` only in the vanishingly brief window between `store.register`
   * and the first action being appended.
   */
  startedAt: number | undefined;
}

/**
 * Resolution of Bureau's durable cancel of a task no process-local run holds, which
 * {@link BureauTasks.cancel} takes for such a task (AB-37, AB-205).
 * Never a rejection — every failure mode, including one raised by the engine
 * itself, is represented as a variant here instead.
 */
export type CancelDurableRunOutcome =
  | { readonly status: 'requested' }
  | { readonly status: 'already-terminal' }
  | { readonly status: 'not-found' }
  | { readonly status: 'unsupported-capability' }
  | { readonly status: 'failed'; readonly error: unknown };

export interface RunStepDetail {
  step: number;
  content: string;
  /** The step's settled output parts; generated media is a managed-asset reference (COR-713). */
  parts: readonly MultiModalContent[];
  /** The id of the assistant row the step committed; absent when it committed none. */
  messageId?: string | undefined;
  final: boolean;
  usage?: TokenUsage | undefined;
  toolCalls: readonly {
    id?: string;
    name: string;
    arguments?: unknown;
  }[];
  results: readonly {
    toolName: string;
    result: unknown;
    error?: string | undefined;
  }[];
}

export interface RunEventRecord {
  sequence: number;
  runId: string;
  event: string;
  detail: unknown;
  timestamp: number;
}

export interface RunDetail extends RunSummary {
  events: RunEventRecord[];
  stepDetails: RunStepDetail[];
  /**
   * The current branch's conversation as of the last completed step or run
   * completion, or `undefined` before any step completes. This is the
   * transcript only: the full undo/branch history stays in the operative
   * store's `RunState.snapshots`.
   */
  transcript: ConversationHistory | undefined;
  /**
   * The run's current liveness snapshot (AB-88/AB-214), plain-data and
   * JSON-safe. `getRun(id)` carries the value observed at call time; a
   * caller wanting live updates calls `bureau.subscribeRunSnapshot(id, ...)`
   * instead of polling `getRun`.
   */
  liveness: LivenessSnapshot;
}

export interface CreateRunRequest {
  /**
   * A user message to append to the session's conversation. Optional when
   * {@link CreateRunRequest.appendMessages} supplies the rows, or when the
   * conversation already ends in a user or tool-result row (the run answers
   * it). The conversation the run starts from must end in such a row; else
   * `BAD_REQUEST`.
   */
  message?: string | undefined;
  /**
   * Rows to append to the session's conversation, after the conversation and
   * the system prompt and after `message` when both are given. They are
   * appended verbatim, with their ids and content parts; an id the session
   * already holds is `BAD_REQUEST`. The request digest covers them (by
   * everything but the `createdAt` and `position` the append re-stamps), so an
   * exact retry digests the same.
   */
  appendMessages?: ReadonlyArray<Message> | undefined;
  sessionId?: string;
  /**
   * COR-1577 — the catalog agent to run. The run executes that agent's own `generate`, tools,
   * system prompt and stop conditions, as `tasks.start(name, …)` does, with this Bureau's opt-in
   * tools (`requestHumanInput`, `scheduleWakeup`) and memory around them.
   *
   * A session is bound to the agent of the run that created it. A later run names that same agent;
   * a request that leaves the field out at runtime (the type no longer allows it) still inherits
   * the session's agent. Naming another is refused with `BAD_REQUEST`. A name that is not in the
   * catalog, `bureau` (the implicit agent that no longer exists) included, is refused with
   * `NOT_FOUND`; both land before anything is persisted.
   *
   * The system prompt, `maximumSteps`, `maximumTokens`, and stop conditions are the agent's (COR-1707:
   * a run carries none of its own). The session's request context governs tool approvals, never the
   * agent's `executeOptions.requestContext`.
   *
   * The run uses that agent's own `generate`, tools, and stop condition. A durable run
   * recovers as its agent: one whose agent has left the catalog fails, and one whose
   * definition revision changed logs a warning and resumes with the current definition.
   *
   * Required: callers name the agent explicitly.
   */
  agentName: string;
  /**
   * The owner of record of this run (COR-718), and of the session it creates:
   * the authenticated principal that started it (e.g. `api-key:<id>`). It is
   * stored once, when the run is created, and decides who may later read the run,
   * its session, and its reviews. Omitted, the run is owned by `anonymous:local`.
   * A host serving outside callers supplies it from the caller's credential,
   * never from a request payload: `createBureauHandler` does so itself.
   *
   * A different principal starting a run on an existing session is refused as a
   * session that does not exist (`BureauError` `NOT_FOUND`).
   */
  principal?: string;
  /** Authenticated, request-scoped authority forwarded to Armorer tool execution. */
  requestContext?: ToolRequestContext | undefined;
  /**
   * COR-424 — the caller's idempotency key for this run-creation command.
   * When present, the start records the command in a durable ledger keyed
   * by `(principal, agentName, runCreationRequestId, operation version)`,
   * with surrounding whitespace trimmed from the request id (the principal is
   * keyed exactly as the run records its owner), and a digest of the payload
   * (`agentName`, the task input, `contextId`, and the request context's `authority`, `audience`,
   * and `locale`), and
   * resolves with a receipt. Requires `principal`, since an idempotency key
   * needs an authenticated caller to belong to, and a bureau with a durable
   * engine (`NOT_CONFIGURED` otherwise), since a receipt promises a retry
   * after a restart finds the original run. The request id stays bound to its
   * run until {@link BureauRetentionOptions.receipts} after the
   * run settles; after that it creates a new run.
   */
  runCreationRequestId?: string | undefined;
}

/** COR-424 — which run-creation request {@link BureauTasks.receipt} looks up. */
export interface LocateRunCreationReceiptRequest {
  /** The authenticated caller that issued the request. */
  principal: string;
  /**
   * The agent the request ran as. Required unless `sessionId` names an existing session, whose
   * agent it then is.
   */
  agentName?: string | undefined;
  /**
   * The session the request continued. A request that omitted `agentName` on an existing
   * session ran as the session's agent and was keyed under it, so name the session to find it
   * without knowing the agent. A session that does not exist, or that another principal owns,
   * binds nothing; one bound to an agent other than `agentName` is refused with `BAD_REQUEST`.
   */
  sessionId?: string | undefined;
  runCreationRequestId: string;
}

// ── WebSocket Frame Types ───────────────────────────────────────────

/**
 * Live stream frame shapes as produced by {@link streamEventToFrame}, before
 * the per-run sequence stamp is applied. Kept separate from {@link ServerFrame}
 * so the frame-construction layer (`streamEventToFrame`) never has to know
 * about sequencing — the bureau frame layer (`create-bureau.ts`) stamps
 * `runSeq` once, at the single point where frames are handed to
 * `emitLiveFrame`. See {@link ServerFrame} for the wire-level (stamped) shape.
 */
export type StreamFrame =
  | { type: 'stream:text-delta'; runId: string; content: string; accumulated: string }
  | { type: 'stream:tool-call-start'; runId: string; toolName: string; blockId: string }
  | {
      type: 'stream:tool-call-delta';
      runId: string;
      toolName: string;
      blockId: string;
      partialArgs: string;
    }
  | {
      type: 'stream:tool-call-complete';
      runId: string;
      toolName: string;
      blockId: string;
      arguments: unknown;
    }
  | { type: 'stream:complete'; runId: string; state: unknown }
  | { type: 'stream:error'; runId: string; error: string };

/**
 * AB-96 — a versioned run-lifecycle frame from `operative`'s run envelope
 * (`RunFrame`: run-started, step, assistant-chunk/final, tool-pre/post,
 * notification, run-finished). The terminal `RunReport` is embedded on the
 * `run-finished` variant.
 *
 * Deliberately NOT part of {@link StreamFrame}/the AB-15 `runSeq` replay
 * contract: `create-bureau.ts` emits these without a `runSeq` stamp (they
 * carry their own envelope-level sequencing via `RunFrame`), so
 * `getRunSeq`/the live-frame replay buffer correctly treat them as
 * non-replayable, same as before AB-15 added `runSeq`.
 */
export type RunEnvelopeFrame = { type: 'run-envelope'; runId: string; frame: RunFrame };

export type ServerFrame =
  | {
      type: 'event';
      runId: string;
      event: string;
      detail: unknown;
      /**
       * The store's global action counter (unique across all runs in this
       * store's lifetime). Used by the REST `/api/v1/runs/:id` timeline to
       * dedupe against live frames already rendered — see
       * `use-run-detail.svelte.ts`. NOT a replay cursor; use {@link runSeq}
       * for that.
       */
      sequence: number;
      timestamp: number;
      /**
       * Monotonic per-run sequence number (AB-15), starting at 1 for the
       * first live frame emitted for `runId` and incrementing by 1 for every
       * subsequent run-scoped frame (`event` and `stream:*`) emitted for that
       * same run. This is the replay cursor: a reconnecting client reports
       * the highest `runSeq` it has already seen for a run (WS `subscribe.since`,
       * SSE `Last-Event-ID`) and the door replays buffered frames with a
       * higher `runSeq` before resuming the live feed.
       */
      runSeq: number;
    }
  | { type: 'subscribed'; runId: string }
  | { type: 'unsubscribed'; runId: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' }
  | (StreamFrame & { runSeq: number })
  | RunEnvelopeFrame
  | {
      /**
       * A durable event delivered through the gateway's reconnect-across-
       * restart fallback (AB-312), never through the ordinary in-memory
       * replay buffer this file's `runSeq` doc comment describes. Sourced
       * from `Bureau.subscribeEventHistory`'s replay-then-tail delivery
       * once a client's resume cursor is older than the live buffer's own
       * floor (or the buffer holds nothing at all, e.g. after a Gateway
       * restart) — see `packages/gateway/src/live-events.ts`'s
       * `durableEnvelopeToServerFrame`.
       *
       * Deliberately carries NO `runSeq`: it is not part of the AB-15
       * in-memory replay-buffer cursor space (a `DurableEventEnvelope`'s
       * own `sequence`/`cursor` is Weft's fleet-global position, not a
       * per-run counter, and the two cannot be translated into each
       * other — see this issue's own doc comment on the fallback path).
       * Never buffered and never advances a client's live `runSeq`
       * cursor, the same as every other non-`runSeq`-bearing frame.
       */
      type: 'durable-event';
      runId: string;
      /** The durable envelope's own `kind` (e.g. `'run.completed'`). */
      event: string;
      /** The durable envelope's own `payload`. */
      detail: unknown;
      /** The durable envelope's own opaque `cursor` — never parsed, only round-tripped. */
      cursor: string;
      schemaVersion: number;
      /** The durable envelope's own `emittedAtMs`. */
      timestamp: number;
    };

// ── Durable Schedule ────────────────────────────────────────────────

/**
 * Parameters for registering a durable bureau schedule via
 * {@link BureauSchedules.create}. The schedule fires the named `agentName`
 * on the given `spec`; each fire is either a fresh session (no `sessionId`)
 * or appended to the same persistent session (`sessionId` given).
 */
/**
 * Applies a schedule change only to the schedule the caller read: the `revision` of its summary
 * (COR-1482). Weft compares it inside its serialized write.
 */
export interface ScheduleRevisionGuard {
  readonly expectedRevision?: number | undefined;
}

/** What {@link BureauSchedules.update} changes. Omitted `description` and `overlap` keep their values. */
export interface DurableScheduleUpdate {
  /** The schedule's new cadence: a cron expression or a Weft duration shorthand, as at creation. */
  readonly spec: string;
  readonly description?: string | undefined;
  readonly overlap?: 'skip' | 'allow' | undefined;
}

export interface DurableScheduleDefinition {
  /** Human-readable operator description stored with the schedule. */
  description?: string;
  /** Agent name to run on each schedule fire. */
  agentName: string;
  /**
   * Input delivered to the agent each fire: text, or an ordered list of text and
   * media parts delivered as one user message.
   */
  input: SessionInputPayload;
  /** Cron expression (e.g. `'0 9 * * *'`) or weft duration shorthand (e.g. `'6h'`, `'30s'`, `'1d'`). */
  spec: string;
  /**
   * When given, each schedule fire appends a run to this session — building a
   * recurring conversation that accumulates context across fires. When omitted,
   * each fire is a fresh standalone session.
   */
  sessionId?: string;
  /** Overlap policy when a prior fire is still running. Defaults to `'skip'`. */
  overlap?: 'skip' | 'allow';
  /**
   * The schedule's owner of record (COR-718), written once into the schedule's
   * `ScheduledAgentRunInput.principal`. Every fire's run is owned by it, and the
   * scheduler is only ever the actor on the fire's `schedule.fired` audit entry.
   * Omitted, the schedule is owned by `anonymous:local`.
   */
  principal?: string;
}
