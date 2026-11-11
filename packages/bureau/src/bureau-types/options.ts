import type { WorkspaceMembershipOptions } from '../http/workspace-principal.ts';
import type { AgentContributions } from '../agent-contributions';
import type { AgentWithBureauTools } from '../agents-with-bureau-tools';
import type { AnswerEncryptionKeys } from '../secret-answers';
import type { VersionedCatalog } from '../versioned-catalog';
import type { RuntimeServices } from '@lostgradient/lifecycle';
import type { GovernedMemory, MemoryCapability } from '@lostgradient/memory';
import type {
  CacheOptions,
  ChildSignalContract,
  CreateRunEngineOptions,
  EnhancedStreamingOptions,
  FlowControlPolicy,
  FreshAttemptSourceResolver,
  HumanInputSchema,
  PeerCallJournal,
  ProviderConfigurationBase,
  Store,
  Validator,
} from '@lostgradient/operative';
import type { SkillCatalogRevision } from '../skills';
import type { ToolPolicy } from 'armorer/protocol';
import type { BureauAttentionItem } from '../attention-feed';
import type { AgentSource, WorkflowSource } from '../sources/definition-source';
import type { Storage, TextValueStore } from '@lostgradient/storage';
import type {
  AlertingOptions,
  ObservabilityOptions,
  WorkflowLogRecord,
  WorkerDeploymentCatalog,
} from '@lostgradient/weft';
import type { ToolRequestContext } from 'armorer';
import type { AgentDefinitions, AgentNames } from '../agent-catalog';
import type { BureauAssetOptions } from '../assets/asset-service';
import type { McpResourceRegistration } from '../assets/content-source-resolver';
import type { AuditRetentionOption, CheckpointRetentionOption } from '../audit-trail';
import type { BureauChildDelegationOptions } from '../child-topology';
import type { BureauEventMap } from '../events';
import type { BureauModelPolicyOptions } from '../model-policy';
import type { DecisionsOptions } from '../decisions/types';
import type { SettingsOptions } from '../settings/types';
import type { ModelsOptions } from '../models/create-models';
import type { ScorerSamplerOptions } from '../scorers';
import type { WebhookNotifierOptions } from '../webhook-notifier';
import type { EventFormatterRegistration } from '../bureau-event-formatting';
import type { HookActionKindRegistration, HookSecretStore } from '../hooks/hook-types';
import type { HookUrlPolicy } from '../hooks/hook-url-policy';
import type {
  BureauMemoryFactory,
  BureauPluginEntry,
  BureauPluginSecrets,
  BureauPluginSettings,
} from '../plugins/plugin-types';
import type { RecoverableStartedApproval } from './reviews';

// ── Provider Configuration ───────────────────────────────────────────

/**
 * The configuration a host selects a model provider with: the provider's name, a model, and the
 * optional sampling and key fields every provider shares.
 *
 * A provider package's own configuration may add fields (an injected client, say). Bureau never
 * names them: it hands the whole object to the registered definition whose `name` equals `provider`.
 */
export type ProviderConfiguration = ProviderConfigurationBase;
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
  /**
   * The host's catalog as it is now, read each time a skill is used (COR-1926). `catalog` decides
   * what a run is offered; this decides whether a skill it was offered may still be used, so a
   * source the host stops trusting is refused at the next use by a run already in flight. It
   * narrows and never widens. Omit it and a run uses the revision it started with.
   */
  currentCatalog?: () => SkillCatalogRevision;
  includeTools?: boolean;
  skillPolicy?: ToolPolicy;
}
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
/** What `resolveProviderGenerate` takes beside a stream event target: the callback each text delta reaches. */
export interface StreamingConfiguration extends Pick<EnhancedStreamingOptions, 'onTextDelta'> {}
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
  /** The independent ceiling for file-agent memory tools. Defaults to all tool capabilities. */
  readonly toolCapabilities?: readonly MemoryCapability[];
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
 * COR-2009 — a kind of record {@link Bureau.removeExpiredRecords} removes: `audit` records,
 * resolved `reviews`, `memories`, the log lines of finished runs (`logs`, counted by run),
 * `notifications`, settled `hookDeliveries`, and `chats` whose last message is older than
 * `retention.chats` allows.
 */
export type ExpiredRecordKind =
  'audit' | 'reviews' | 'memories' | 'logs' | 'notifications' | 'hookDeliveries' | 'chats';
/** COR-2009 — what {@link Bureau.removeExpiredRecords} removed. */
export interface ExpiredRecordRemoval {
  /** How many records went, every kind together. */
  readonly removed: number;
  /** How many records of each kind went; a kind whose pass failed counts zero. */
  readonly byKind: Readonly<Record<ExpiredRecordKind, number>>;
  /** The kinds whose pass failed, each diagnosed; empty when every pass ran. */
  readonly failed: readonly ExpiredRecordKind[];
}
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
   * already prunes stale run ownership (AB-374). Under
   * `expiredRecords: 'on-request'` it runs only in
   * {@link Bureau.removeExpiredRecords} instead (COR-2009).
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
   * also what eventually releases an opted-out agent's tombstone mount. A
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
  /**
   * COR-1809 — how long governed memory keeps an `episodic` memory (what a run writes about its
   * chat), measured from when it was written on the runtime clock. Each maintenance pass sweeps
   * governed memory under this window, in place of the 90 days the memory policy's `episodic` rule
   * sets, without activating a policy revision; the sweep deletes an expired memory with a receipt
   * and a `memory.retention.swept` event, and a legal hold keeps what it holds. Leave it out and
   * the memory policy's own rule decides. The other classes keep the policy's rules. Under
   * `expiredRecords: 'on-request'` the sweep runs only in {@link Bureau.removeExpiredRecords}
   * (COR-2009). Has effect only on a Bureau composed with `memory`. `olderThan` must be a positive integer; otherwise
   * `createBureau` throws `BureauError(..., 'BAD_REQUEST')`.
   */
  memory?: BureauMemoryRetentionOption | undefined;
  /**
   * COR-1811 — how long a finished run's persisted `ctx.log` lines are kept after the run last
   * wrote one, swept by each maintenance pass. A run that is still active (running, suspended, or
   * parked on a signal, a review, or a timer) keeps its lines whatever their age. Leave it out to keep them until the run is purged. Under
   * `expiredRecords: 'on-request'` the sweep runs only in {@link Bureau.removeExpiredRecords}
   * (COR-2009). Has effect
   * only on a Bureau composed with {@link BureauOptions.logs}. `olderThan` must be a positive
   * integer; otherwise `createBureau` throws `BureauError(..., 'BAD_REQUEST')`.
   */
  logs?: BureauLogsRetentionOption | undefined;
  /**
   * COR-1941 — how long a notification is kept after it was written, swept by each maintenance
   * pass whether or not it was read. Leave it out to keep notifications until the owner holds
   * more than 1000, when the oldest go. Under `expiredRecords: 'on-request'` the sweep runs only
   * in {@link Bureau.removeExpiredRecords} (COR-2009). `olderThan` must be a positive integer;
   * otherwise `createBureau` throws `BureauError(..., 'BAD_REQUEST')`.
   */
  notifications?: BureauNotificationsRetentionOption | undefined;
  /**
   * COR-1943 — how long a settled hook delivery record (delivered, exhausted, aborted, or failed
   * for want of a secret) is kept after it was last written, swept by each maintenance pass. A
   * pending delivery is never removed, whatever its age. Leave it out to keep delivery records until
   * their hook is deleted. Under `expiredRecords: 'on-request'` the sweep runs only in
   * {@link Bureau.removeExpiredRecords} (COR-2009). Has effect only on a Bureau composed with
   * {@link BureauOptions.hooks}.
   * `olderThan` must be a positive integer; otherwise `createBureau` throws
   * `BureauError(..., 'BAD_REQUEST')`.
   */
  hookDeliveries?: BureauHookDeliveriesRetentionOption | undefined;
}
/**
 * COR-1943 — the window of {@link BureauRetentionOptions.hookDeliveries}. Only `{ olderThan }`
 * exists: keeping delivery records forever is leaving the option out.
 */
export interface BureauHookDeliveriesRetentionOption {
  /** Milliseconds after a delivery was last written; a positive integer. */
  readonly olderThan: number;
}
/**
 * COR-1941 — the window of {@link BureauRetentionOptions.notifications}. Only `{ olderThan }`
 * exists: keeping notifications forever is leaving the option out.
 */
export interface BureauNotificationsRetentionOption {
  /** Milliseconds after a notification was written; a positive integer. */
  readonly olderThan: number;
}
/**
 * COR-1811 — the window of {@link BureauRetentionOptions.logs}. Only `{ olderThan }` exists:
 * keeping lines forever is leaving the option out.
 */
export interface BureauLogsRetentionOption {
  /** Milliseconds after a run last wrote a line; a positive integer. */
  readonly olderThan: number;
}
/** COR-1811 — {@link BureauOptions.logs}: the bounds of a run's persisted `ctx.log` lines. */
export interface BureauLogsOptions {
  /** How many lines a run keeps; the oldest is evicted past it. A positive integer of at most 5000; default 500. */
  readonly maximumLinesPerRun?: number | undefined;
}
/**
 * COR-1809 — the window of {@link BureauRetentionOptions.memory}. Only `{ olderThan }` exists:
 * keeping a memory forever is the memory policy's own decision, so a Bureau that wants no sweep
 * simply does not set it.
 */
export interface BureauMemoryRetentionOption {
  /** Milliseconds after an episodic memory is written; a positive integer. */
  readonly olderThan: number;
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
  /** Supplies the peer-call journal before durable boot recovery begins. */
  peerCallsReady?: (journal: PeerCallJournal) => void;
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
   * COR-2009 — code-defined agents that hold Bureau's own tools, which an entry of
   * {@link BureauOptions.agents} cannot: those tools read the Bureau, so they exist only once
   * `createBureau` has started. Each key is an agent's name and each value builds the agent from
   * the tools, by the name an agent file uses (`bureau:discover-agents`, and with an
   * {@link BureauOptions.workflowSource} `bureau:workflows-create` and the other workflow tools).
   * The function is called once, while the Bureau is built, and the agent it returns joins the
   * catalog under its key as an entry of `agents` does. A key `agents` already holds, or the
   * reserved `bureau`, is refused with `BureauError` (`BAD_REQUEST`).
   */
  agentsWithBureauTools?: Readonly<Record<string, AgentWithBureauTools>>;
  /**
   * COR-1702 — where agent definitions are loaded from, watched in, and written back to. Pass
   * `agentFileDirectory(path, { tools })` from `@lostgradient/bureau/sources` for a directory of
   * Markdown agent files (COR-1524): every `*.md` file in it is an agent whose identifier is the
   * filename without the extension, listed in {@link Bureau.agents} beside the code-defined ones
   * and started by name through {@link BureauTasks.start}. See
   * `documentation/agent-files.md`.
   *
   * Bureau keeps parsing, validation, snapshots, revisions, and the write-through
   * operations; the source only holds bytes. The source's `tools` is the deployment's tool
   * catalog: the tools an agent file may name in `tools`. The built-in `bureau` plugin (COR-1890)
   * adds `bureau:discover-agents` and, with {@link BureauOptions.workflowSource},
   * `bureau:workflows-create`, `bureau:workflows-update`, `bureau:workflows-pause`,
   * `bureau:workflows-resume`, and `bureau:workflows-list` (COR-1529); a tool of the host's in the
   * `bureau` namespace (`bureau:x` or `bureau__x`) is refused with `BureauError` (`BAD_REQUEST`). Requires {@link ModelsOptions.generate}: a model name that
   * nothing can turn into a `generate` would be silently ignored, so `createBureau` refuses the
   * combination with `BureauError` (`BAD_REQUEST`).
   *
   * COR-1873: pass several sources to layer them. The owner's sources come first; a plugin's
   * read-only layer (`agentFileDirectory(path, { plugin })`) sits beneath them, lists its agents
   * as `plugin:name`, reloads them when they change, and refuses every write with
   * `agent-file-read-only`. `agents.duplicate` copies one into the owner's source. The list is
   * read as `layeredAgentSource(list)`; an empty list or two layers of one plugin is refused with
   * `BureauError` (`BAD_REQUEST`).
   */
  agentSource?: AgentSource | readonly AgentSource[];
  /**
   * COR-1897 — the agent source of a running plugin's shipped content. For each running plugin
   * whose descriptor declares `content`, Bureau calls it with the plugin's name and that URL, and
   * layers what it returns beneath {@link BureauOptions.agentSource} (a source with `plugin` set to
   * the name, such as `agentFileDirectory(path, { plugin })`). It returns `undefined` for content it
   * cannot read. A disabled, skipped, or failed plugin is not asked, so its agents are not listed.
   * The Node directory sources stay out of the main entry, so the host that reads files supplies
   * this; without it, or without `agentSource`, a plugin's content is not read.
   */
  pluginAgentSource?: (plugin: string, content: URL) => AgentSource | undefined;
  /**
   * COR-1977 — the workflow source of a running plugin's shipped content, as
   * {@link BureauOptions.pluginAgentSource} is for agents. For each running plugin whose
   * descriptor declares `content`, Bureau calls it with the plugin's name and that URL, and layers
   * what it returns beneath {@link BureauOptions.workflowSource} (a source with `plugin` set to the
   * name, such as `workflowFileDirectory(path, { plugin })`). It returns `undefined` for content it
   * cannot read. A disabled, skipped, or failed plugin is not asked, so its workflows are not
   * listed. Without it, or without `workflowSource`, a plugin's workflows are not read.
   */
  pluginWorkflowSource?: (plugin: string, content: URL) => WorkflowSource | undefined;
  /**
   * COR-1913 — the secret that signs the tool approvals the file agents of
   * {@link BureauOptions.agentSource} raise. A file agent's tools ask a person before they run
   * according to the file's `approvals` (`on-changes` for a tool it does not name), and an
   * approval is resolved by presenting the signed token that raised it, so the secret must be the
   * same after a restart and in every process that resolves reviews of the same store. Keep it
   * with the deployment's other secrets. Without one a file agent's approval is raised unsigned:
   * `reviews.resolve` refuses to approve it (`NOT_CONFIGURED`) and it can only be denied. It does
   * not reach the code agents in {@link BureauOptions.agents}, whose toolboxes carry their own.
   */
  agentApprovalSecret?: string;
  /**
   * COR-1877 — the guardrails and interceptors plugins contribute, which an agent file chooses with
   * `guardrails: [plugin:name]` and `interceptors: [plugin:name]`. Build the value with
   * `createAgentContributions`. Operative's default guardrail preset still guards every agent, and a
   * chosen guardrail runs beside it; a chosen interceptor joins the agent's hook tier, each entry
   * tagged with its plugin as its `source`. A file that lists an id this does not hold is `invalid`
   * with `reference-unresolved`. Omitted, nothing is contributed, so a file that lists any is
   * invalid. Used only with {@link BureauOptions.agentSource}.
   */
  agentContributions?: AgentContributions;
  /**
   * COR-1975 — the host's skill catalog as it is now, which is what an agent file's `skills`
   * draws on. Discovery and the trust decision stay the host's (COR-752), so this is a read, called
   * when a file agent's run starts, each time the run uses a skill, and when a write grants a skill.
   * Bureau recovers durable runs before `createBureau` returns, so answer from the first read: a
   * run recovered while this answers `undefined` has no skills, and one that held a skill active
   * is offered no tool, because its policy cannot be verified. A run of an agent whose file grants
   * no skill reads nothing and has no skills. Omitted, no skill can be granted. Used only with
   * {@link BureauOptions.agentSource}.
   */
  agentSkillCatalog?: () => SkillCatalogRevision | undefined;
  /**
   * COR-1702 — where workflow definitions are loaded from, watched in, and written back to. Pass
   * `workflowFileDirectory(path)` from `@lostgradient/bureau/sources` for a directory of JSON
   * workflow files (COR-1527): every `*.json` file in it is an agent-authored workflow
   * (COR-1525's document plus `agent` and `paused`) whose identifier is the filename without the
   * extension, registered with the durable engine as its own workflow type and run on the
   * schedule its `trigger` names. Requires a durable engine, and `createBureau` refuses the
   * combination without one with `BureauError` (`BAD_REQUEST`). See
   * `documentation/workflow-files.md`.
   *
   * COR-1873: pass several sources to layer them, as for {@link BureauOptions.agentSource}: a
   * plugin's read-only layer lists its workflows as `plugin:name` and refuses every write with
   * `workflow-file-read-only`.
   */
  workflowSource?: WorkflowSource | readonly WorkflowSource[];
  /**
   * COR-1874 — the versioned catalog (`createVersionedCatalog`) whose `activity` and
   * `trigger` entries workflow files may use besides the `agent` activity and the `schedule`
   * and `signal` triggers. An entry is named `plugin:name` and holds a plugin's activity or
   * trigger kind. A file names a contributed activity without a version and floats with it; the
   * revision Bureau registers pins the version that is loaded, and a run resumes after a restart
   * only on that version, otherwise it is cancelled and reported `missing` or `version-mismatch`.
   * A name loaded at two versions is a startup error. Read once, at construction.
   */
  contributionCatalog?: VersionedCatalog;
  /**
   * COR-1813 — Weft's worker deployment catalog, the durable store of worker builds and routing
   * pointers. With it, {@link Bureau.deployments} reads a deployment's routing pointer and ramps,
   * promotes, and rolls back its builds, and the `bureau.deployments.*` operations serve the same
   * calls. Without it, `Bureau.deployments` is `undefined` and those operations answer
   * `UnsupportedCapability`. Pass the catalog the Weft server routes with, built over the same
   * storage, so a move here is the move the server routes by.
   */
  workerDeployments?: WorkerDeploymentCatalog;
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
   * The storage adapter for contexts, key-value data, and the durable engine. The caller
   * constructs it (`new BunSQLiteStorage(path)`, `new LMDBStorage(path)`, a Cloudflare Durable
   * Object SQLite adapter) and keeps its lifecycle: Bureau never disposes a storage it was given,
   * so close it after the Bureau has shut down.
   */
  storage?: Storage;
  /**
   * COR-1920 — the keys a secret answer is sealed with: a question field marked `writeOnly` and
   * `x-secret` is encrypted under `current` before anything holds it, and its ciphertext is kept in
   * `storage`, readable only by a tool of the run that asked (see `secret-answers.md`). A key
   * retired by a rotation stays readable through `retired`. Without this option, or without
   * `storage`, an answer to a question that asks for a secret is refused (`NOT_CONFIGURED`,
   * subject `encryption`) and nothing is delivered.
   */
  answerEncryption?: AnswerEncryptionKeys;
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
   *
   * COR-1946: over persistent storage a Bureau holds a 30-second process lease that other
   * processes read to tell a task whose process stopped from one still running. `'automatic'`
   * renews it on a timer; `'manual'` renews it only inside {@link Bureau.maintain}, so a manual host
   * should call `maintain()` at least every 30 seconds while it runs process-local tasks that
   * another Bureau over the same storage may boot beside.
   */
  maintenance?: 'automatic' | 'manual';
  /**
   * COR-2009 — who removes the records past their retention window: audit records and the
   * resolved reviews they describe, expired memories, finished runs' log lines, notifications and
   * settled hook deliveries. `'maintenance'`, the default, removes them in every maintenance pass,
   * on the automatic timer or in {@link Bureau.maintain}. `'on-request'` leaves them to
   * {@link Bureau.removeExpiredRecords}, for a host that cleans up on a schedule of its own, such as
   * once a night. Every other maintenance pass, task and event history retention included, is
   * unchanged. Any other value makes `createBureau` throw `BureauError(..., 'BAD_REQUEST')`.
   */
  expiredRecords?: 'maintenance' | 'on-request';
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
   *
   * COR-1879: a factory instead builds memory once plugin setup has run, with the memory guardrails and
   * embedders the running plugins contribute ({@link PluginMemoryContributions}), so the host can
   * hand them to `createEmbedderRegistry` and the policy's `contributedDetectors`, each guardrail at the gates it
   * declares. It is called
   * once, during construction, with empty lists when no plugin contributes either.
   */
  memory?: GovernedMemory | BureauMemoryFactory;
  /**
   * COR-1879 — the plugins to load, from workspace packages and Bungalow's `plugins/` folder. Each
   * enabled plugin's `setup` runs once, in load order (package plugins as given, then folder
   * plugins by folder name), with storage confined to `plugin:<name>:`, and its contributions are
   * registered through the options they belong to. A plugin whose configuration does not parse,
   * whose `setup` fails, or that claims a name already held is skipped and the Bureau still
   * starts; `start` runs once the Bureau is built. {@link Bureau.plugins} reports each.
   */
  plugins?: readonly BureauPluginEntry[];
  /** COR-1879 — the owner's `{ enabled, configuration }` for each plugin, by plugin name. */
  pluginConfiguration?: Readonly<Record<string, BureauPluginSettings>>;
  /** COR-1879 — reads the secrets plugins declare; a plugin reads only the keys it declared. */
  pluginSecrets?: BureauPluginSecrets;
  /**
   * COR-41 — the memory authority Bureau delegates to each run it composes
   * memory hooks for. See {@link BureauMemoryAuthorityOptions}.
   */
  memoryAuthority?: BureauMemoryAuthorityOptions;
  /** Trusted workspace directory used by run and tool authorization. */
  workspace?: WorkspaceMembershipOptions;
  identity?: IdentityConfiguration;
  /** Host-owned authority check used before durable recovery resumes user code. */
  requestAuthorityValidator?: (context: ToolRequestContext) => boolean | Promise<boolean>;
  /** Trusted, version-pinned adapters used only to attach to journaled peer tasks after a crash. */
  recoverableStartedApprovals?: ReadonlyMap<string, RecoverableStartedApproval>;
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
   * answer: a model registered in {@link DecisionsOptions.models} or {@link ModelsOptions.generate}. The tool
   * acts as the task's principal and is capped per task by {@link DecisionsOptions.maximumPerTask}.
   * Pass `false` to leave it out. Passing `true` throws `BureauError` `BAD_REQUEST`: the tool is
   * already the default.
   */
  decide?: false;
  /**
   * COR-1709 — how `bureau.decisions.decide` and the `decide` tool are answered: `models` registered by
   * name, of which the `decisions.model` setting (default `model`) names the one that answers the
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
   * COR-1811 — keep the `ctx.log` lines of durable workflows with their runs. Setting it (even to
   * `{}`) composes a Weft log store over the durable storage: every non-replayed line, inline and
   * worker-forwarded, is written beside the run (the human-wait park marker excepted), and
   * `engine.getLogs` and `weft.workflows.logs.list` serve it per run and per step. {@link onLog}
   * still receives every line. A run keeps its newest `maximumLinesPerRun` lines (500 by default);
   * each older line the cap evicts is counted as dropped. A line's message and attributes together are held to
   * 2 KiB: a long message is cut with a marker, and attributes that do not fit are dropped. Lines are kept {@link BureauRetentionOptions.logs} (unset keeps them until the run is purged),
   * and the `logs.maximumLinesPerRun` and `retention.logs` settings replace these at runtime. The
   * sink is buffered, so a crash can lose the last turn's lines; shutdown flushes it. Has effect
   * only when a durable engine is composed. A `maximumLinesPerRun` that is not a positive integer of
   * at most 5000 throws `BureauError(..., 'BAD_REQUEST')`.
   */
  logs?: BureauLogsOptions;
  /**
   * History/checkpoint guardrails for durable runs. `history.maxEvents` is a
   * circuit breaker (a breach terminates the run as an error, classified
   * distinctly from a deadline timeout); `checkpointSizeWarningThreshold` arms an
   * early-warning event observed via {@link onCheckpointSizeWarning}. Has effect
   * only when a durable engine is composed.
   */
  durableGuardrails?: DurableGuardrailsConfiguration;
  /**
   * Alert rules the durable engine evaluates against its own metrics (Weft's built-in alerting),
   * such as a `storage.size` rule over the storage size the engine reports every minute. What is
   * firing is read with `engine.getActiveAlerts()` and reported by {@link Bureau.attention} and
   * `bureau.health.attention`. Omitted, the engine evaluates no rule. Has effect only when a
   * durable engine is composed.
   */
  alerts?: AlertingOptions;
  /**
   * COR-2009 — how often, in milliseconds, the durable engine reports its storage's size, the
   * `storage.size` metric {@link BureauOptions.alerts} reads. Omitted, every minute (Weft's
   * default); `0` turns the periodic report off, so the only sizes reported are the ones dispatched
   * on the engine. Has effect only when a durable engine is composed.
   */
  storageSizeReportIntervalMs?: number;
  /**
   * COR-2009 — the problems the host can see and the Bureau cannot, such as `no-provider` when no
   * model provider is connected. Read on every {@link Bureau.attention} call and merged into the one
   * list, most recent first; a plugin the Bureau already reports as not loaded is listed once.
   */
  attention?: () => Promise<readonly BureauAttentionItem[]> | readonly BureauAttentionItem[];
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
   * COR-1939 — user-defined hooks: owner-scoped webhooks over the Bureau's published events, each
   * delivery HMAC-signed (`X-Signature`), its request, response excerpt and attempts kept on a
   * record, and retried and resumed after a restart. Exposed as {@link Bureau.hooks} and as the
   * `bureau.hooks.*` operations. Needs durable storage (`NOT_CONFIGURED`, subject `persistence`,
   * without it) and {@link BureauOptions.answerEncryption} to seal signing secrets (a write of one
   * is refused without it). Deliveries use the HTTP client, retry schedule, clock and shutdown of
   * {@link BureauOptions.webhooks} (`fetch`, `maxAttempts`, `backoffBaseMilliseconds`, `sleep`,
   * `now`, `signal`), which may have no `targets`. Omit to compose none — the default.
   */
  hooks?: BureauHooksOptions;
  /**
   * The event formatters plugins contribute (COR-1876), the entry point plugin composition feeds
   * with each plugin's `formatters`. {@link Bureau.formatEvent} uses them; an event no
   * formatter claims is shown by its raw kind. Two formatters that claim one event kind are
   * refused at construction.
   */
  formatters?: readonly EventFormatterRegistration[];
  /**
   * Online evaluations (AB-53) — samples a fraction of completed live runs
   * through configured judges/matchers, records every sampled score to the
   * durable audit trail, and fires a webhook (via `options.webhooks`, AB-21's
   * durable delivery infra) when a judge's score breaches its configured
   * alert threshold. Omit, pass no judges, or pass `sampleRate: 0` to
   * disable — the default.
   */
  scorers?: ScorerSamplerOptions;
  /**
   * Managed assets (COR-794) — composes one asset service over the injected
   * asset storage, policy, and ports, running on this bureau's runtime
   * services. Exposed as {@link Bureau.assets} and shut down as the
   * `'assets'` owner. Omit to compose none — the default.
   */
  assets?: BureauAssetOptions;
  /**
   * Reads the MCP resources an `mcp-resource` part of a tool result links to (COR-1634), so the
   * step after a tool returned an MCP `resource_link` can send the linked bytes to a provider.
   * Bureau holds no MCP connections, so the host that connected the server supplies the read. Only a
   * tool result introduces such a link (a run, session or schedule input carrying one is refused),
   * but the reader must still authorize the run's principal, the server and the URI on every
   * call, and it is called again at every step that sends the row. Without it, a run whose
   * row holds such a link fails its next generation with a `MediaAdmissionError`. See
   * `McpResourceReader`. Several readers register together (COR-1875), each with the test
   * that claims its resources ({@link McpResourceRegistration}); the first registration that
   * serves a resource reads it, and a resource none serves fails that step with the reason
   * `mcp-resource-not-served`.
   */
  mcpResources?: readonly McpResourceRegistration[];
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
  | 'maxConcurrentRuns'
  | 'onCheckpointSizeWarning'
>;
export type BureauEventType = keyof BureauEventMap & string;
/** {@link BureauOptions.hooks}. */
export interface BureauHooksOptions {
  /**
   * Where the sealed signing secrets are kept. Bureau seals each secret (COR-1816's scheme, under
   * {@link BureauOptions.answerEncryption}) before it reaches the port, so the port holds
   * ciphertext only. A host whose secrets live elsewhere supplies its own; its `writeLock()` makes
   * a secret write fail with `locked` and that reason (`deployment` for a remote home). Omitted,
   * the ciphertext is kept in Bureau's key-value store.
   */
  secrets?: HookSecretStore;
  /**
   * Which URLs a hook may deliver to. By default loopback and private-network addresses are
   * allowed (Interborough is local-first); link-local (including the cloud metadata endpoints
   * `169.254.169.254` and `fd00:ec2::254`), unspecified and multicast never are. A hosted
   * deployment, a remote Interborough home included, must set `allowPrivateNetworks: false` when it
   * enables hooks.
   */
  urlPolicy?: HookUrlPolicy;
  /** How long one delivery request may take before it counts as failed. Default `10000`. */
  requestTimeoutMilliseconds?: number;
  /**
   * The hook action kinds plugins contribute (COR-1876): a hook whose action is
   * `{ type: 'plugin', plugin, kind, configuration? }` runs the named kind. This is the entry point
   * plugin composition feeds with each plugin's `reactions`. A plugin and kind name given
   * twice is refused at construction. Omitted, only the built-in actions exist.
   */
  actionKinds?: readonly HookActionKindRegistration[];
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
