/**
 * The checks the consumers of `bureau.settings` apply, run over the values a change would put in
 * force before it is written, and over a stored record before it is applied (COR-1710).
 *
 * The schema says what a value looks like; the consumer decides what it accepts. A setting the
 * schema admits but its consumer refuses would be stored, reported applied, and then refused (or
 * at boot, thrown) where it is read. So every value also passes the validator its consumer runs:
 * Bureau's own option validators, and Weft's engine option resolution, reached through a scratch
 * `Engine` that is built, asked to `reconfigure`, and disposed without touching the Bureau's own.
 *
 * @module settings-validation
 */

import type { BackendDescriptor } from '@lostgradient/operative';
import { Engine } from '@lostgradient/weft';
import { MemoryStorage } from '@lostgradient/storage';

import { validateDecisionsOptions } from '../decisions/create-decisions.ts';
import { findCatalogRow } from '../models/create-models.ts';
import { validateHumanInputOption } from '../human-input-option.ts';
import {
  type BadRequest,
  validateAuditRetentionOption,
  validateCheckpointRetentionOption,
  validateDelegationTimeToLive,
  validateLogsMaximumLinesPerRun,
  validateLogsRetentionOption,
  validateNotificationsRetentionOption,
  validateMemoryRetentionOption,
  validateReceiptRetentionOption,
  validateRetentionWindowOption,
  validateSessionInputBacklogLimit,
} from '../option-validators.ts';
import { ENGINE_PATCH_FIELDS, type SettingKey, type SettingsValues } from './settings-schema.ts';

/** One check that failed: the keys it involves and why. */
export interface SettingsFailure {
  readonly keys: readonly SettingKey[];
  readonly message: string;
}

const refuse: BadRequest = (message) => {
  throw new Error(message);
};

/**
 * The validator `createBureau` runs on the option each key sets. A key with none here is checked
 * by the schema alone (a boolean or an enum), or by the engine below.
 */
export const OPTION_VALIDATORS: Readonly<Partial<Record<SettingKey, (value: unknown) => void>>> = {
  'tools.humanInput': (value) =>
    validateHumanInputOption(value as Parameters<typeof validateHumanInputOption>[0]),
  'decisions.fallbackModel': (value) => validateDecisionsOptions({ fallbackModel: value }, refuse),
  'decisions.maximumPerTask': (value) =>
    validateDecisionsOptions({ maximumPerTask: value }, refuse),
  'retention.audit': (value) =>
    validateAuditRetentionOption(
      value as Parameters<typeof validateAuditRetentionOption>[0],
      refuse,
    ),
  'retention.events': (value) =>
    validateRetentionWindowOption(
      value as Parameters<typeof validateRetentionWindowOption>[0],
      'retention.events',
      refuse,
    ),
  'retention.tasks': (value) =>
    validateRetentionWindowOption(
      value as Parameters<typeof validateRetentionWindowOption>[0],
      'retention.tasks',
      refuse,
    ),
  'retention.checkpoints': (value) =>
    validateCheckpointRetentionOption(
      value as Parameters<typeof validateCheckpointRetentionOption>[0],
      refuse,
    ),
  'retention.receipts': (value) => validateReceiptRetentionOption(value, refuse),
  'retention.memory': (value) => validateMemoryRetentionOption(value, refuse),
  'retention.logs': (value) => validateLogsRetentionOption(value, refuse),
  'retention.notifications': (value) => validateNotificationsRetentionOption(value, refuse),
  'logs.maximumLinesPerRun': (value) => validateLogsMaximumLinesPerRun(value, refuse),
  'sessionInput.sessionBacklogLimit': (value) =>
    validateSessionInputBacklogLimit(value as number, 'sessionBacklogLimit', refuse),
  'sessionInput.principalBacklogLimit': (value) =>
    validateSessionInputBacklogLimit(value as number, 'principalBacklogLimit', refuse),
  'children.delegation.defaultTimeToLiveMilliseconds': (value) =>
    validateDelegationTimeToLive(value, refuse),
};

/**
 * The keys whose consumer runs no check of its own beyond what the schema already says: a boolean,
 * an enum, a string, `modelPolicy` (its strict schema mirrors operative's types, and the planner
 * reads it unchecked), and the two engine options Weft takes without checking.
 * `settings-validation.test.ts` requires every key to be here, in {@link OPTION_VALIDATORS}, or
 * checked by the engine.
 */
export const SCHEMA_CHECKED_KEYS = [
  'tools.wakeup',
  'tools.decide',
  'modelPolicy',
  'durable',
  'maintenance',
  'workflowVersion',
  'engine.checkpointHistory',
  'engine.maxNestingDepth',
  'a2a.push.enabled',
  'a2a.push.sweepIntervalMs',
] as const satisfies readonly SettingKey[];

/**
 * The keys checked against state only the running Bureau holds, so no option validator can judge
 * them from the value alone: `decisions.model` against the registered decision models (in
 * {@link settingsFailures}, so a stored value this process cannot serve is dropped at read and
 * refused at write), and `context.summarizerModel` against the model catalog as it is now (at
 * write only, in {@link summarizerFailures}, because `models.replace` changes the catalog under a
 * stored value and {@link Models.summarizer} checks the row at each use).
 */
export const CONTEXT_CHECKED_KEYS = [
  'decisions.model',
  'context.summarizerModel',
] as const satisfies readonly SettingKey[];

/** The keys Weft checks together when it builds an engine: the workflow-claim timing. */
export const ENGINE_CLAIM_KEYS = [
  'engine.workflowClaimTtl',
  'engine.workflowClaimRenewInterval',
  'durableOwnership.ownership',
] as const satisfies readonly SettingKey[];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds the scratch engine with the workflow-claim options `createRunEngine` would pass for
 * `values` (`ownership` defaults to `'workflow-lease'` there), so Weft's own construction checks
 * them under the ownership mode in force.
 */
function scratchEngine(values: SettingsValues): Engine {
  const ttl = values['engine.workflowClaimTtl'];
  const renew = values['engine.workflowClaimRenewInterval'];
  return new Engine({
    storage: new MemoryStorage(),
    backgroundTasks: 'manual',
    ownership: values['durableOwnership.ownership'] ?? 'workflow-lease',
    ...(ttl === undefined ? {} : { workflowClaimTtl: ttl }),
    ...(renew === undefined ? {} : { workflowClaimRenewInterval: renew }),
  });
}

/** Each live engine key of `values`, offered to a scratch engine's `reconfigure` on its own. */
function engineFailures(values: SettingsValues): SettingsFailure[] {
  const failures: SettingsFailure[] = [];
  let engine: Engine;
  try {
    engine = scratchEngine(values);
  } catch (error) {
    failures.push({ keys: ENGINE_CLAIM_KEYS, message: messageOf(error) });
    engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
  }
  try {
    for (const [key, field] of Object.entries(ENGINE_PATCH_FIELDS)) {
      const value = values[key as SettingKey];
      if (value === undefined) continue;
      const result = engine.reconfigure({ [field]: value });
      if (result.outcome === 'rejected') {
        failures.push({ keys: [key as SettingKey], message: result.message });
      }
    }
  } finally {
    engine[Symbol.dispose]();
  }
  return failures;
}

/**
 * The check `context.summarizerModel` gets at write: it names a row of `catalog` that is not
 * `unavailable`.
 */
export function summarizerFailures(
  values: SettingsValues,
  catalog: readonly BackendDescriptor[],
): SettingsFailure[] {
  const name = values['context.summarizerModel'];
  if (name === undefined) return [];
  const row = findCatalogRow(catalog, name);
  if (row === undefined) {
    return [
      {
        keys: ['context.summarizerModel'],
        message: `The model catalog has no row "${name}"`,
      },
    ];
  }
  return row.availability === 'unavailable'
    ? [{ keys: ['context.summarizerModel'], message: `The catalog row "${name}" is unavailable` }]
    : [];
}

/**
 * Every check a consumer of `values` would fail: Bureau's option validator for each key, and
 * Weft's engine options. `values` are the settings in force, code defaults included, so a check
 * across keys sees the value each one would really have.
 */
export function settingsFailures(
  values: SettingsValues,
  decisionModels?: ReadonlySet<string>,
): SettingsFailure[] {
  const failures: SettingsFailure[] = [];
  const model = values['decisions.model'];
  if (decisionModels !== undefined && model !== undefined && !decisionModels.has(model)) {
    failures.push({
      keys: ['decisions.model'],
      message: `No decision model is registered as "${model}"; the names are ${[...decisionModels].join(', ')}`,
    });
  }
  for (const [key, validate] of Object.entries(OPTION_VALIDATORS)) {
    const value = values[key as SettingKey];
    if (value === undefined || validate === undefined) continue;
    try {
      validate(value);
    } catch (error) {
      failures.push({ keys: [key as SettingKey], message: messageOf(error) });
    }
  }
  failures.push(...engineFailures(values));
  return failures;
}
