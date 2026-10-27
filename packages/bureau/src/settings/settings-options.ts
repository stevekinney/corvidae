/**
 * Between `BureauOptions` and `bureau.settings` (COR-1710): the code options as setting defaults,
 * the `restart` keys a stored record applies at boot, and the engine keys `engine.reconfigure`
 * takes.
 *
 * @module settings-options
 */

import { type EnginePatch, resolveStorage, type Storage, textValueStore } from '@lostgradient/weft';

import { isStorageConfiguration } from '../runtime-composition.ts';

import type { AgentDefinitions } from '../agent-catalog.ts';
import type { TaskToolGrant } from '../task-registry.ts';
import type { BureauModelPolicyOptions } from '../model-policy.ts';
import type { BureauOptions } from '../types.ts';
import { effectiveSettings, readSettingsRecord, type StoredSettings } from './create-settings.ts';
import {
  ENGINE_PATCH_FIELDS,
  isSettingKey,
  type SettingKey,
  type SettingsValues,
} from './settings-schema.ts';
import { collidingSettingsToolName } from './settings-tools.ts';

/** Drops the `undefined` entries, so a key the options leave out has no default. */
function defined(values: Record<string, unknown>): SettingsValues {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

/** The code options, as settings: each key's default before the store overrides it. */
export function settingsDefaultsOf<D extends AgentDefinitions>(
  options: BureauOptions<D>,
): SettingsValues {
  return defined({
    'tools.humanInput': options.humanInput ?? {},
    'tools.wakeup': options.wakeup !== false,
    'tools.decide': options.decide !== false,
    modelPolicy: options.modelPolicy,
    'decisions.fallbackModel': options.decisions?.fallbackModel,
    'decisions.maximumPerTask': options.decisions?.maximumPerTask,
    'retention.audit': options.retention?.audit,
    'retention.events': options.retention?.events,
    'retention.tasks': options.retention?.tasks,
    'retention.receipts': options.retention?.receipts,
    'retention.checkpoints': options.retention?.checkpoints,
    'sessionInput.sessionBacklogLimit': options.sessionInput?.sessionBacklogLimit,
    'sessionInput.principalBacklogLimit': options.sessionInput?.principalBacklogLimit,
    'children.delegation.defaultTimeToLiveMilliseconds':
      options.children?.delegation?.defaultTimeToLiveMilliseconds,
    'engine.history': options.durableGuardrails?.history,
    'engine.payloadSize': options.durableGuardrails?.payloadSize,
    'engine.checkpointSizeWarningThreshold':
      options.durableGuardrails?.checkpointSizeWarningThreshold,
    'engine.checkpointHistory': options.durableGuardrails?.checkpointHistory,
    'engine.maxNestingDepth': options.durableGuardrails?.maxNestingDepth,
    'engine.workflowClaimTtl': options.durableOwnership?.workflowClaimTtlMs,
    'engine.workflowClaimRenewInterval': options.durableOwnership?.workflowClaimRenewIntervalMs,
    durable: options.durable,
    maintenance: options.maintenance,
    'durableOwnership.ownership': options.durableOwnership?.ownership,
    workflowVersion: options.workflowVersion,
  });
}

/**
 * Each `restart` key and the option it replaces at boot, as a path into `BureauOptions`.
 * `setting-owners.test.ts` holds this table's keys equal to the `restart` keys, so a key cannot be
 * declared `restart` without a boot read, and a live key cannot pass as `restart` without one.
 */
export const RESTART_OPTION_PATHS = {
  'engine.checkpointHistory': ['durableGuardrails', 'checkpointHistory'],
  'engine.maxNestingDepth': ['durableGuardrails', 'maxNestingDepth'],
  'engine.workflowClaimTtl': ['durableOwnership', 'workflowClaimTtlMs'],
  'engine.workflowClaimRenewInterval': ['durableOwnership', 'workflowClaimRenewIntervalMs'],
  'durableOwnership.ownership': ['durableOwnership', 'ownership'],
  durable: ['durable'],
  maintenance: ['maintenance'],
  workflowVersion: ['workflowVersion'],
} as const satisfies Partial<Record<SettingKey, readonly [string] | readonly [string, string]>>;

/**
 * `options` with the `restart` keys of `values` in place of the matching options, so everything
 * built at construction reads the value the store holds.
 */
export function withRestartSettings<D extends AgentDefinitions, O extends BureauOptions<D>>(
  options: O,
  values: SettingsValues,
): O {
  const next: Record<string, unknown> = { ...(options as Record<string, unknown>) };
  for (const [key, path] of Object.entries(RESTART_OPTION_PATHS)) {
    const value = values[key as SettingKey];
    if (value === undefined) continue;
    const [head, field] = path;
    next[head] =
      field === undefined
        ? value
        : { ...(next[head] as Record<string, unknown> | undefined), [field]: value };
  }
  return next as O;
}

/** The {@link EnginePatch} that sets the engine keys among `keys` to their value in `values`, if any. */
export function enginePatchOf(
  values: SettingsValues,
  keys: readonly SettingKey[],
): EnginePatch | undefined {
  const patch: Record<string, unknown> = {};
  for (const key of keys) {
    if (!Object.hasOwn(ENGINE_PATCH_FIELDS, key)) continue;
    const value = values[key];
    if (value !== undefined) {
      patch[ENGINE_PATCH_FIELDS[key as keyof typeof ENGINE_PATCH_FIELDS]] = value;
    }
  }
  return Object.keys(patch).length === 0 ? undefined : patch;
}

/**
 * Refuses a `settings.locked` entry that names no setting, and a host tool named like a settings
 * tool, which Bureau adds to the tool catalog itself. Returns the locked keys.
 */
export function validateSettingsOptions<D extends AgentDefinitions>(
  options: Pick<BureauOptions<D>, 'settings' | 'agentSource'>,
  badRequest: (message: string) => never,
): ReadonlySet<SettingKey> {
  const colliding = collidingSettingsToolName(options.agentSource?.tools);
  if (colliding !== undefined) {
    badRequest(
      `"options.agentSource.tools" names a tool "${colliding}", which Bureau provides itself`,
    );
  }
  const { settings } = options;
  if (settings === undefined) return new Set();
  if (typeof settings !== 'object' || settings === null) {
    badRequest('"options.settings" must be an object');
  }
  const locked: unknown = settings.locked;
  if (locked === undefined) return new Set();
  if (!Array.isArray(locked)) {
    badRequest('"options.settings.locked" must be an array of setting keys');
  }
  for (const key of locked as unknown[]) {
    if (typeof key !== 'string' || !isSettingKey(key)) {
      badRequest(`"options.settings.locked" names "${String(key)}", which is not a setting`);
    }
  }
  return new Set(locked as SettingKey[]);
}

/**
 * The stored `modelPolicy` as the policy the selector composes against. The schema checks its
 * shape and revision; the per-user configurations are checked by the selector when it composes.
 */
export function modelPolicyOf(values: SettingsValues): BureauModelPolicyOptions | undefined {
  return values.modelPolicy as BureauModelPolicyOptions | undefined;
}

/** The tools a task starting now is granted: `tools.*` of `values`. */
export function toolGrantOf(values: SettingsValues): TaskToolGrant {
  const humanInput = values['tools.humanInput'] ?? {};
  return {
    humanInput:
      humanInput === false
        ? false
        : humanInput.inputSchemas === undefined
          ? {}
          : { inputSchemas: humanInput.inputSchemas },
    wakeup: values['tools.wakeup'] ?? true,
    decide: values['tools.decide'] ?? true,
  };
}

/** What {@link bootSettings} read and resolved before the engine exists. */
export interface BootSettings<O> {
  /** `options` with a storage configuration resolved and the stored `restart` keys in place. */
  readonly options: O;
  /** Whether the storage was resolved here, so the runtime composition owns and disposes it. */
  readonly ownsStorage: boolean;
  /** Whether the record survives the process. */
  readonly persisted: boolean;
  /** The record as read. */
  readonly stored: StoredSettings;
}

/**
 * Reads the settings record before anything is built from `options`, so a stored `restart` key
 * (`durable`, `maintenance`, the engine's construction options) is in force for everything built
 * after. A storage configuration is resolved here, once, and handed on with its ownership, because
 * resolving it twice would open a second store.
 */
export async function bootSettings<D extends AgentDefinitions, O extends BureauOptions<D>>(
  options: O,
  defaults: SettingsValues,
  locked: ReadonlySet<SettingKey>,
  diagnose: (message: string) => void,
): Promise<BootSettings<O>> {
  const configured = options.storage;
  const ownsStorage = configured !== undefined && isStorageConfiguration(configured);
  const storage: Storage | undefined = ownsStorage ? await resolveStorage(configured) : configured;
  const stored =
    storage === undefined
      ? { record: undefined, storedValues: {}, raw: null }
      : await readSettingsRecord(
          textValueStore(storage, { disposeUnderlyingStorage: false }),
          { defaults, locked },
          diagnose,
        );
  return {
    options: withRestartSettings(
      { ...options, ...(storage === undefined ? {} : { storage }) },
      effectiveSettings(defaults, stored.record?.values, locked),
    ),
    ownsStorage,
    persisted:
      storage !== undefined && ['local', 'remote'].includes(storage.capabilities().persistence),
    stored,
  };
}
