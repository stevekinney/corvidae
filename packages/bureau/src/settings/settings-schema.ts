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

import { checkHumanInputSchemas } from '@lostgradient/operative';
import { z } from 'zod';

const positiveInteger = z.number().int().positive();
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
const invariants = z
  .object({
    deniedProviders: z.array(z.string()).optional(),
    deniedModels: z.array(z.string()).optional(),
    deniedRoutes: z.array(z.string()).optional(),
    deniedRegions: z.array(z.string()).optional(),
    requireDataPolicy: z.enum(['no-retention', 'zero-day-retention', 'standard']).optional(),
  })
  .strict();

/**
 * Every setting, by dotted key. Each key is optional: a key with no value keeps its code default.
 * `bureau.settings.schema()` publishes this as JSON Schema 2020-12.
 */
export const settingsSchema = z
  .object({
    'tools.humanInput': humanInputSetting.describe(
      '`false` withholds `requestHumanInput` from tasks started from now on; an object offers it, with optional answer schemas per signal. A started task keeps the grant it started with.',
    ),
    'tools.wakeup': z
      .boolean()
      .describe('Whether tasks started from now on are offered `scheduleWakeup`.'),
    'tools.decide': z.boolean().describe('Whether tasks started from now on are offered `decide`.'),
    modelPolicy: z
      .object({
        deployment: invariants.optional(),
        bureau: invariants.optional(),
        users: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
        policyRevision: z.number().int().nonnegative(),
      })
      .strict()
      .describe('The model policy the next plan or step is selected under.'),
    'decisions.fallbackModel': z
      .string()
      .regex(/^[^/\s]+\/\S+$/, 'must be "<provider>/<model>"')
      .describe(
        'The model-catalog row, `<provider>/<model>`, that answers a decision no decision model serves.',
      ),
    'decisions.maximumPerTask': positiveInteger.describe(
      'How many decisions one task may make through the `decide` tool.',
    ),
    'retention.audit': retentionWindow.describe(
      'How long audit records are kept, swept by the next maintenance pass.',
    ),
    'retention.events': retentionWindow.describe(
      "How long Bureau's fleet event feed keeps events. Independent of `engine.retention`, Weft's workflow-history policy.",
    ),
    'retention.tasks': retentionWindow.describe('How long a settled task is kept.'),
    'retention.receipts': z
      .object({ olderThan: z.number().int().positive() })
      .strict()
      .describe('How long a run-creation receipt is kept.'),
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
      .describe('How many checkpoints of a durable run are kept.'),
    'sessionInput.sessionBacklogLimit': positiveInteger.describe(
      'How many undelivered inputs one context may hold, checked at the next admission.',
    ),
    'sessionInput.principalBacklogLimit': positiveInteger.describe(
      'How many undelivered inputs one principal may hold across contexts, checked at the next admission.',
    ),
    'children.delegation.defaultTimeToLiveMilliseconds': positiveMilliseconds.describe(
      'How long a delegation token minted at the next dispatch lives.',
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
        "Weft's workflow-history retention, by terminal status, in milliseconds. Independent of `retention.events`.",
      ),
    'engine.retentionSweepInterval': positiveMilliseconds.describe(
      "How often Weft's retention sweep runs, in milliseconds.",
    ),
    'engine.retentionSweepBatchSize': positiveInteger.describe(
      'How many workflows one Weft retention sweep removes at most.',
    ),
    'engine.history': z
      .object({
        maxEvents: positiveInteger.optional(),
        retentionWindow: positiveInteger.optional(),
      })
      .strict()
      .describe("Weft's per-workflow history circuit breaker."),
    'engine.payloadSize': z
      .object({ maxBytes: positiveInteger.nullable().optional() })
      .strict()
      .describe('The largest payload Weft accepts, in bytes; `null` removes the cap.'),
    'engine.checkpointSizeWarningThreshold': positiveInteger.describe(
      'The checkpoint size, in bytes, above which Weft warns.',
    ),
    'engine.schedulerPollIntervalMs': positiveMilliseconds.describe(
      "How often Weft's scheduler polls for due work, in milliseconds.",
    ),
    'engine.checkpointHistory': positiveInteger.describe(
      'How many checkpoints Weft keeps per workflow. Applies at restart.',
    ),
    'engine.maxNestingDepth': positiveInteger.describe(
      'How deeply workflows may nest. Applies at restart.',
    ),
    'engine.workflowClaimTtl': positiveMilliseconds.describe(
      'How long a workflow claim lasts without renewal, in milliseconds. Applies at restart.',
    ),
    'engine.workflowClaimRenewInterval': positiveMilliseconds.describe(
      'How often a workflow claim is renewed, in milliseconds. Applies at restart.',
    ),
    durable: z.boolean().describe('Whether the Bureau runs a durable engine. Applies at restart.'),
    maintenance: z
      .enum(['automatic', 'manual'])
      .describe('Who drives maintenance: Bureau on a timer, or the host. Applies at restart.'),
    'durableOwnership.ownership': z
      .enum(['none', 'workflow-lease'])
      .describe('How processes on one store share workflows. Applies at restart.'),
    workflowVersion: z
      .string()
      .min(1)
      .describe('The version recorded on new durable runs. Applies at restart.'),
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
  'decisions.fallbackModel': 'live',
  'decisions.maximumPerTask': 'live',
  'retention.audit': 'live',
  'retention.events': 'live',
  'retention.tasks': 'live',
  'retention.receipts': 'live',
  'retention.checkpoints': 'live',
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
  'engine.workflowClaimTtl': 'restart',
  'engine.workflowClaimRenewInterval': 'restart',
  durable: 'restart',
  maintenance: 'restart',
  'durableOwnership.ownership': 'restart',
  workflowVersion: 'restart',
};

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
