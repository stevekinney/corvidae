/**
 * The keys of `bureau.settings` (COR-1710): their schema, how each one applies, and the record
 * that stores them.
 *
 * A key is a dotted name, `retention.audit` or `engine.history`, and a value is what the matching
 * code option takes, except that every duration is a number of milliseconds. A `live` key takes
 * effect at its next point of use: the next task start, admission, maintenance pass, dispatch, or
 * `engine.reconfigure`. A `restart` key is stored and reported `pendingRestart` until a new
 * `createBureau` over the same store reads it at boot.
 *
 * @module settings-schema
 */

import type { UserModelConfiguration } from '@lostgradient/operative';
import { checkHumanInputSchemas, PROVIDER_NAME_PATTERN } from '@lostgradient/operative';
import type { EnginePatch } from '@lostgradient/weft';
import { z } from 'zod';

/** A positive safe integer: `z.number().int()` alone admits integers past 2^53. */
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** The most lines a run may keep (COR-1811): Weft's `MAXIMUM_LOG_LINES_PER_RUN_LIMIT`, which a test holds equal. */
export const MAXIMUM_WORKFLOW_LOG_LINES_PER_RUN = 5000;
/** A safe integer, 0 or more: Weft reads 0 as "disabled" for its history and payload caps. */
const nonNegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nonNegativeMilliseconds = z.number().finite().nonnegative();
const positiveMilliseconds = z.number().finite().positive();

const humanInputSetting = z.union([
  z.literal(false),
  z
    .object({
      inputSchemas: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.inputSchemas === undefined) return;
      try {
        checkHumanInputSchemas(value.inputSchemas);
      } catch (error) {
        context.addIssue({
          code: 'custom',
          message: error instanceof Error ? error.message : String(error),
          path: ['inputSchemas'],
        });
      }
    }),
]);

const olderThanWindow = z.object({ olderThan: nonNegativeMilliseconds }).strict();
const retentionWindow = z.union([z.literal('forever'), olderThanWindow]);
/**
 * Operative's `ProviderName`: any name in the provider-name grammar. A stored name no loaded
 * provider carries validates and resolves as unavailable.
 */
const providerName = z.string().regex(PROVIDER_NAME_PATTERN);
/** Operative's `Effort`. */
const effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const dataPolicy = z.enum(['no-retention', 'zero-day-retention', 'standard']);
const strings = z.array(z.string()).readonly().optional();

/**
 * Operative's `UserModelConfiguration`, strictly: the planner reads these fields without checking
 * them, so a stored `allowedProviders: null` would otherwise reach it. `settings-schema.test-d.ts`
 * holds this equal to the interface.
 */
export const userModelConfigurationSchema = z
  .object({
    allowedProviders: z.array(providerName).readonly().optional(),
    deniedProviders: z.array(providerName).readonly().optional(),
    allowedModels: strings,
    deniedModels: strings,
    allowedRoutes: strings,
    deniedRoutes: strings,
    allowedRegions: strings,
    deniedRegions: strings,
    dataPolicy: dataPolicy.optional(),
    defaultEffort: effort.optional(),
    exactOverride: z
      .object({
        provider: providerName.exactOptional(),
        model: z.string().exactOptional(),
        route: z.string().exactOptional(),
        effort: effort.exactOptional(),
      })
      .strict()
      .optional(),
    costPreference: z.enum(['lowest-cost', 'balanced', 'no-preference']).optional(),
    latencyPreference: z.enum(['lowest-latency', 'balanced', 'no-preference']).optional(),
    fallbackOrder: strings,
    effortFallbackMode: z.enum(['reject', 'degrade']).optional(),
  })
  .strict();

/** Holds {@link userModelConfigurationSchema} to operative's interface, in both directions. */
export type UserModelConfigurationSchemaMatches = [
  z.infer<typeof userModelConfigurationSchema> extends UserModelConfiguration ? true : never,
  UserModelConfiguration extends z.infer<typeof userModelConfigurationSchema> ? true : never,
];
const userModelConfigurationSchemaMatches: UserModelConfigurationSchemaMatches = [true, true];
void userModelConfigurationSchemaMatches;

const invariants = z
  .object({
    deniedProviders: z.array(providerName).optional(),
    deniedModels: z.array(z.string()).optional(),
    deniedRoutes: z.array(z.string()).optional(),
    deniedRegions: z.array(z.string()).optional(),
    requireDataPolicy: dataPolicy.optional(),
  })
  .strict();

/**
 * Every setting, by dotted key. Each key is optional: a key with no value keeps its code default.
 * `bureau.settings.schema()` publishes this as JSON Schema 2020-12.
 */
export const settingsSchema = z
  .object({
    'tools.humanInput': humanInputSetting.describe(
      'Let agents ask a person a question mid-task. Tasks started from now on get the setting; a running task keeps the one it started with.',
    ),
    'tools.wakeup': z.boolean().describe('Let agents schedule themselves to continue later.'),
    'tools.decide': z
      .boolean()
      .describe(
        'Let agents ask the decision model a quick question while they work. Tasks started from now on get the setting.',
      ),
    modelPolicy: z
      .object({
        deployment: invariants.optional(),
        bureau: invariants.optional(),
        users: z.record(z.string(), userModelConfigurationSchema).optional(),
        policyRevision: z.number().int().nonnegative(),
      })
      .strict()
      .describe(
        'Which models agents may use and which to prefer. The next plan or step follows it.',
      ),
    'decisions.model': z
      .string()
      .min(1)
      .describe(
        'The model that answers yes-or-no and classification questions, apart from the models agents chat with, written as a provider and a model with a slash between them. Leave it unset to have the fallback model answer them.',
      ),
    'decisions.fallbackModel': z
      .string()
      .regex(/^[^/\s]+\/\S+$/, 'must be "<provider>/<model>"')
      .describe(
        'Used when the decision model can’t answer. Written as a provider and a model with a slash between them.',
      ),
    'decisions.maximumPerTask': positiveInteger.describe(
      'The most decision calls one task may make.',
    ),
    'context.summarizerModel': z
      .string()
      .regex(/^[^/\s]+\/\S+$/, 'must be "<provider>/<model>"')
      .describe(
        'The model that summarizes a long conversation so an agent can keep going. Unset, none does; a new choice must be a model you can use now.',
      ),
    'retention.audit': retentionWindow.describe(
      'How long audit records are kept before they are deleted.',
    ),
    'retention.runs': retentionWindow.describe(
      'How long finished runs and their steps are kept. Deleting a run removes its page; a link to it then says the run doesn’t exist.',
    ),
    'retention.chats': retentionWindow.describe(
      'How long chats are kept after their last message.',
    ),
    'retention.events': retentionWindow.describe(
      'How long recent activity is kept for the pages that follow it live. Run history has its own setting.',
    ),
    'retention.tasks': retentionWindow.describe('How long a finished task is kept.'),
    'retention.receipts': z
      .object({ olderThan: z.number().int().positive() })
      .strict()
      .describe(
        'How long the record that a run was started is kept, so the same request sent again starts no second run.',
      ),
    'retention.memory': z
      .object({ olderThan: z.number().int().positive() })
      .strict()
      .describe('Memories an agent saved. Agents can correct them.'),
    'retention.logs': z
      .object({ olderThan: z.number().int().positive() })
      .strict()
      .describe(
        'How long a finished run keeps its log lines after it last wrote one. A run that is still going keeps them.',
      ),
    'retention.notifications': z
      .object({ olderThan: z.number().int().positive() })
      .strict()
      .describe(
        'How long a notification is kept, read or not. Unset, the newest 1,000 for each person are kept.',
      ),
    'retention.hookDeliveries': z
      .object({ olderThan: z.number().int().positive() })
      .strict()
      .describe(
        'How long the record of a finished hook delivery is kept. A delivery still being tried is never removed. Unset, the records are kept until their hook is deleted.',
      ),
    'retention.checkpoints': z
      .union([
        z.literal('keep-all'),
        z
          .object({
            keepLast: positiveInteger,
            timeoutMilliseconds: nonNegativeMilliseconds.optional(),
          })
          .strict(),
      ])
      .describe('How many saved points of a running workflow are kept.'),
    'memory.embedder': z
      .string()
      .min(1)
      .describe(
        'How memories are indexed for search: the built-in index, or one a plugin adds. A change re-indexes every memory in the background while search keeps the current index, and switches once every memory is in the new one. It can’t change while the new one isn’t loaded or needs setup, or while a change is still running. A change that fails or is canceled goes back to the index in use.',
      ),
    'logs.maximumLinesPerRun': positiveInteger
      .max(MAXIMUM_WORKFLOW_LOG_LINES_PER_RUN)
      .describe(
        'How many log lines a run keeps, at most 5,000. Past it, the oldest line goes first.',
      ),
    'sessionInput.sessionBacklogLimit': positiveInteger.describe(
      'How many messages one chat can hold before its agent reads them. A chat started after a change uses the new limit; one already running keeps its own.',
    ),
    'sessionInput.principalBacklogLimit': positiveInteger.describe(
      'How many unread messages one person can have waiting across every chat.',
    ),
    'children.delegation.defaultTimeToLiveMilliseconds': positiveMilliseconds.describe(
      'How long an agent’s permission to hand work to another agent lasts.',
    ),
    'engine.retention': z
      .object({
        completed: nonNegativeMilliseconds.optional(),
        failed: nonNegativeMilliseconds.optional(),
        cancelled: nonNegativeMilliseconds.optional(),
        timedOut: nonNegativeMilliseconds.optional(),
      })
      .strict()
      .describe(
        'How long run history is kept, by how the run ended, in place of the one window `retention.runs` sets for every outcome. Recent activity has its own setting.',
      ),
    'engine.retentionSweepInterval': positiveMilliseconds.describe(
      'How often old run history is removed.',
    ),
    'engine.retentionSweepBatchSize': positiveInteger.describe(
      'The most runs one removal of old run history takes.',
    ),
    'engine.history': z
      .object({
        maxEvents: nonNegativeInteger.optional(),
        retentionWindow: nonNegativeInteger.optional(),
      })
      .strict()
      .describe('Stops a run whose history grows too long.'),
    'engine.payloadSize': z
      .object({ maxBytes: nonNegativeInteger.nullable().optional() })
      .strict()
      .describe('The largest input or result a run accepts. No limit removes the cap.'),
    'engine.checkpointSizeWarningThreshold': positiveInteger.describe(
      'The size of a saved point above which a warning is shown.',
    ),
    'engine.schedulerPollIntervalMs': positiveInteger.describe(
      'How often scheduled work that is due is looked for.',
    ),
    'engine.checkpointHistory': positiveInteger.describe(
      'How many saved points each workflow keeps.',
    ),
    'engine.maxNestingDepth': positiveInteger.describe(
      'How deeply workflows may start other workflows.',
    ),
    'engine.maxConcurrentRuns': positiveInteger.describe(
      'The most workflow runs that execute at the same time on this machine.',
    ),
    'engine.workflowClaimTtl': positiveMilliseconds.describe(
      'How long a worker’s claim on a running workflow lasts without being renewed.',
    ),
    'engine.workflowClaimRenewInterval': positiveMilliseconds.describe(
      'How often a worker renews its claim on a running workflow. Shorter intervals recover from a crashed worker sooner.',
    ),
    durable: z.boolean().describe('Whether runs pick up where they stopped after a restart.'),
    maintenance: z
      .enum(['automatic', 'manual'])
      .describe('Whether tidying up runs on its own timer or waits to be asked.'),
    'durableOwnership.ownership': z
      .enum(['none', 'workflow-lease'])
      .describe('How servers that share storage divide the work between them.'),
    workflowVersion: z.string().min(1).describe('The version recorded on new runs.'),
    'a2a.enabled': z
      .boolean()
      .describe(
        'Whether other agents and tools can call this one over the Agent2Agent protocol. Off, no remote call is answered.',
      ),
    'a2a.agents': z
      .record(z.string().min(1), z.boolean())
      .describe(
        'Which agents answer remote calls, by name. An agent named here follows its entry; an agent left out follows its own file, or the host that registered it.',
      ),
    'a2a.push.enabled': z
      .boolean()
      .describe(
        'Whether other agents can ask to be told when a task they started changes. An agent that allows it says so on its agent card.',
      ),
    'a2a.push.sweepIntervalMs': positiveInteger
      .max(2_147_483_647)
      .describe(
        'How often requests to be told about tasks that no longer exist are removed. At most about 24 days.',
      ),
  })
  .partial()
  .strict();

/** One key of {@link settingsSchema}. */
export type SettingKey = keyof z.infer<typeof settingsSchema>;

/** A value for every key that has one: the code default, or the stored value that overrides it. */
export type SettingsValues = z.infer<typeof settingsSchema>;

/** Whether a key takes effect at its next point of use (`live`) or at the next `createBureau` (`restart`). */
export type SettingApply = 'live' | 'restart';

/** How each key applies. */
export const SETTING_APPLY: Readonly<Record<SettingKey, SettingApply>> = {
  'tools.humanInput': 'live',
  'tools.wakeup': 'live',
  'tools.decide': 'live',
  modelPolicy: 'live',
  'decisions.model': 'live',
  'decisions.fallbackModel': 'live',
  'decisions.maximumPerTask': 'live',
  'context.summarizerModel': 'live',
  'retention.audit': 'live',
  'retention.runs': 'live',
  'retention.chats': 'live',
  'retention.events': 'live',
  'retention.tasks': 'live',
  'retention.receipts': 'live',
  'retention.memory': 'live',
  'retention.logs': 'live',
  'retention.notifications': 'live',
  'retention.hookDeliveries': 'live',
  'retention.checkpoints': 'live',
  'memory.embedder': 'live',
  'logs.maximumLinesPerRun': 'live',
  // Live from the next session (owner decision, COR-1710 revision 2026-10-27): a running session
  // keeps the limit its Weft mailbox was built with, which keeps Weft's backlog check atomic.
  'sessionInput.sessionBacklogLimit': 'live',
  'sessionInput.principalBacklogLimit': 'live',
  'children.delegation.defaultTimeToLiveMilliseconds': 'live',
  'engine.retention': 'live',
  'engine.retentionSweepInterval': 'live',
  'engine.retentionSweepBatchSize': 'live',
  'engine.history': 'live',
  'engine.payloadSize': 'live',
  'engine.checkpointSizeWarningThreshold': 'live',
  'engine.schedulerPollIntervalMs': 'live',
  'engine.checkpointHistory': 'restart',
  'engine.maxNestingDepth': 'restart',
  // A cap Weft's engine takes at construction: a new value applies from the next start.
  'engine.maxConcurrentRuns': 'restart',
  'engine.workflowClaimTtl': 'restart',
  'engine.workflowClaimRenewInterval': 'restart',
  durable: 'restart',
  maintenance: 'restart',
  'durableOwnership.ownership': 'restart',
  workflowVersion: 'restart',
  'a2a.enabled': 'restart',
  // Read on every A2A request, so an agent shared or withdrawn is served or refused at once.
  'a2a.agents': 'live',
  'a2a.push.enabled': 'restart',
  'a2a.push.sweepIntervalMs': 'restart',
};

/** Each live engine key and the {@link EnginePatch} field it sets. */
export const ENGINE_PATCH_FIELDS = {
  'engine.retention': 'retention',
  'engine.retentionSweepInterval': 'retentionSweepInterval',
  'engine.retentionSweepBatchSize': 'retentionSweepBatchSize',
  'engine.history': 'history',
  'engine.payloadSize': 'payloadSize',
  'engine.checkpointSizeWarningThreshold': 'checkpointSizeWarningThreshold',
  'engine.schedulerPollIntervalMs': 'schedulerPollIntervalMs',
} as const satisfies Partial<Record<SettingKey, keyof EnginePatch>>;

/** Why a key is locked: the deployment chose it, or processes sharing one store must agree on it. */
export const SETTING_LOCK_REASONS = ['deployment', 'shared-storage'] as const;

/**
 * Why a key is locked (`bureau.settings.get` reports it per key): `deployment` when the deployment's
 * code or host holds the key to its code option, `shared-storage` when several processes share one
 * store and must run the same value (a remote host's ownership and maintenance settings).
 */
export type SettingLockReason = (typeof SETTING_LOCK_REASONS)[number];

/** Every key, in the schema's order. */
export const SETTING_KEYS: readonly SettingKey[] = Object.keys(
  settingsSchema.shape,
) as SettingKey[];

/** Whether `key` names a setting. */
export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTING_APPLY, key);
}

/** The key the record is stored under in Bureau's key-value store. */
export const SETTINGS_RECORD_KEY = 'settings';

/** The stored record: the values the store overrides, and how many times it has changed. */
export interface SettingsRecord {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly values: SettingsValues;
  /** When the record last changed (ISO 8601). */
  readonly updatedAt: string;
}
