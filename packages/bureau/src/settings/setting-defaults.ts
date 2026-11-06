/**
 * What each setting applies by when nothing sets it (COR-2009, sweep W69): neither a stored value
 * nor a code option. `bureau.settings.get` reports these under `effective`, so a screen can say
 * what an unset setting does ("Default: 1 hour") instead of "Not set".
 *
 * Every value here is the one its owner applies, read from the owner's own constant wherever the
 * owner has one: the engine's defaults for the `engine.*` keys, the decision and session-input
 * defaults, the run-creation ledger's window, memory's built-in embedder. The few that are plain
 * literals (`'forever'`, `'keep-all'`, `'automatic'`, `'workflow-lease'`) are the defaults their
 * options document.
 *
 * @module setting-defaults
 */

import { HASHING_EMBEDDER_ID } from '@lostgradient/memory';
import {
  DEFAULT_CHECKPOINT_HISTORY,
  DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD,
  DEFAULT_MAX_NESTING_DEPTH,
  DEFAULT_MAXIMUM_LOG_LINES_PER_RUN,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_RETENTION_SWEEP_BATCH_SIZE,
  DEFAULT_RETENTION_SWEEP_INTERVAL_MS,
  DEFAULT_WORKFLOW_CLAIM_RENEW_INTERVAL_MS,
  DEFAULT_WORKFLOW_CLAIM_TTL_MS,
} from '@lostgradient/weft';

import { COMMAND_LEDGER_DEFAULT_TERMINAL_RETENTION_MS } from '../command-ledger.ts';
import {
  CATALOG_DECISION_MODEL,
  DEFAULT_DECISION_FALLBACK_MODEL,
  DEFAULT_DECISIONS_PER_TASK,
} from '../decisions/create-decisions.ts';
import {
  DEFAULT_PRINCIPAL_SESSION_INPUT_BACKLOG_LIMIT,
  DEFAULT_SESSION_INPUT_BACKLOG_LIMIT,
} from '../types.ts';
import {
  A2A_DEFAULTS,
  A2A_PUSH_DEFAULTS,
  DEFAULT_MAX_CONCURRENT_RUNS,
} from './settings-options.ts';
import type { SettingKey, SettingsValues } from './settings-schema.ts';

/** {@link BureauRetentionOptions.events}'s default window: 7 days. */
export const DEFAULT_EVENT_RETENTION_MS = 7 * 86_400_000;

/** {@link BureauRetentionOptions.tasks}'s default window: 30 days. */
export const DEFAULT_TASK_RETENTION_MS = 30 * 86_400_000;

/** How long a delegation token lives when neither the setting nor the delegation options say: 1 hour. */
export const DEFAULT_DELEGATION_TIME_TO_LIVE_MILLISECONDS = 60 * 60 * 1000;

/**
 * The keys that have no one value while nothing sets them, because leaving them unset is itself
 * the behavior: no model policy, no summarizer, the memory policy's own windows, log lines and hook
 * deliveries kept with what owns them, notifications kept up to a count, and no workflow version
 * stamped, and no agent named for A2A (each follows its own file). Each key's description in the schema says what unset means. `effective` omits them.
 */
export const SETTINGS_WITHOUT_DEFAULT = [
  'modelPolicy',
  'a2a.agents',
  'context.summarizerModel',
  'retention.memory',
  'retention.logs',
  'retention.notifications',
  'retention.hookDeliveries',
  'workflowVersion',
] as const satisfies readonly SettingKey[];

/** A key {@link SETTINGS_WITHOUT_DEFAULT} names. */
export type SettingWithoutDefault = (typeof SETTINGS_WITHOUT_DEFAULT)[number];

/** Every other key's built-in value. The mapped type makes a new key choose: a default, or the list. */
export type BuiltInSettingDefaults = {
  readonly [Key in Exclude<SettingKey, SettingWithoutDefault>]-?: NonNullable<SettingsValues[Key]>;
};

/** What a built-in default depends on: only whether the Bureau's storage outlives the process. */
export interface BuiltInDefaultsContext {
  /** Whether the storage is persistent (`local` or `remote`): a durable engine is on by default there. */
  readonly persistentStorage: boolean;
}

/** The value each key applies by when neither the store nor a code option sets it. */
export function builtInSettingDefaults(context: BuiltInDefaultsContext): BuiltInSettingDefaults {
  return {
    'tools.humanInput': {},
    'tools.wakeup': true,
    'tools.decide': true,
    'decisions.model': CATALOG_DECISION_MODEL,
    'decisions.fallbackModel': DEFAULT_DECISION_FALLBACK_MODEL,
    'decisions.maximumPerTask': DEFAULT_DECISIONS_PER_TASK,
    'retention.audit': 'forever',
    'retention.events': { olderThan: DEFAULT_EVENT_RETENTION_MS },
    'retention.tasks': { olderThan: DEFAULT_TASK_RETENTION_MS },
    'retention.receipts': { olderThan: COMMAND_LEDGER_DEFAULT_TERMINAL_RETENTION_MS },
    'retention.checkpoints': 'keep-all',
    'memory.embedder': HASHING_EMBEDDER_ID,
    'logs.maximumLinesPerRun': DEFAULT_MAXIMUM_LOG_LINES_PER_RUN,
    'sessionInput.sessionBacklogLimit': DEFAULT_SESSION_INPUT_BACKLOG_LIMIT,
    'sessionInput.principalBacklogLimit': DEFAULT_PRINCIPAL_SESSION_INPUT_BACKLOG_LIMIT,
    'children.delegation.defaultTimeToLiveMilliseconds':
      DEFAULT_DELEGATION_TIME_TO_LIVE_MILLISECONDS,
    // The engine keeps every terminal workflow's history and caps neither history nor payloads.
    'engine.retention': {},
    'engine.retentionSweepInterval': DEFAULT_RETENTION_SWEEP_INTERVAL_MS,
    'engine.retentionSweepBatchSize': DEFAULT_RETENTION_SWEEP_BATCH_SIZE,
    'engine.history': {},
    'engine.payloadSize': { maxBytes: null },
    'engine.checkpointSizeWarningThreshold': DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD,
    'engine.schedulerPollIntervalMs': DEFAULT_POLL_INTERVAL_MS,
    'engine.checkpointHistory': DEFAULT_CHECKPOINT_HISTORY,
    'engine.maxNestingDepth': DEFAULT_MAX_NESTING_DEPTH,
    'engine.maxConcurrentRuns': DEFAULT_MAX_CONCURRENT_RUNS,
    'engine.workflowClaimTtl': DEFAULT_WORKFLOW_CLAIM_TTL_MS,
    'engine.workflowClaimRenewInterval': DEFAULT_WORKFLOW_CLAIM_RENEW_INTERVAL_MS,
    durable: context.persistentStorage,
    maintenance: 'automatic',
    'durableOwnership.ownership': 'workflow-lease',
    'a2a.enabled': A2A_DEFAULTS.enabled,
    'a2a.push.enabled': A2A_PUSH_DEFAULTS.enabled,
    'a2a.push.sweepIntervalMs': A2A_PUSH_DEFAULTS.sweepIntervalMs,
  };
}
