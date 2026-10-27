/**
 * `bureau.settings` (COR-1710): the revisioned `settings` record in Bureau's key-value store, the
 * values in force in this process, and the changes another process made, re-read on each
 * maintenance pass.
 *
 * Code options are the defaults; a stored value overrides one unless the key is locked. A stored
 * key the schema no longer has, or whose value fails validation, is dropped with a
 * `scope: 'settings'` diagnostic and the default applies. `update` is a compare-and-swap on the
 * record's text, so two processes on one store cannot both write over the same revision: one
 * applies, the other is refused `stale-revision`.
 *
 * @module create-settings
 */

import { type ConditionalTextValueStore, MemoryStorage, textValueStore } from '@lostgradient/weft';
import { z } from 'zod';

import {
  isSettingKey,
  SETTING_APPLY,
  SETTING_KEYS,
  type SettingKey,
  SETTINGS_RECORD_KEY,
  type SettingsRecord,
  settingsSchema,
  type SettingsValues,
} from './settings-schema.ts';
import { settingsFailures } from './settings-validation.ts';
import type {
  BureauSettings,
  SettingKeyState,
  SettingsChange,
  SettingsUpdateResult,
} from './types.ts';

/** The audit record type for one applied change. It carries keys and the new revision, never values. */
export const SETTINGS_CHANGED_AUDIT_TYPE = 'settings.changed';

/** The audit trail's resource name for settings records. */
export const SETTINGS_AUDIT_RESOURCE = 'settings';

/**
 * The stored record as it was read: its parsed form, holding only the values this build applies;
 * every value as stored, which an update writes back untouched; and the exact text a
 * compare-and-swap expects.
 */
export interface StoredSettings {
  readonly record: SettingsRecord | undefined;
  /**
   * The record's `values` as stored, including keys this build does not know or refuses. Another
   * process on the same store may run a build that reads them, so an update keeps them.
   */
  readonly storedValues: Readonly<Record<string, unknown>>;
  readonly raw: string | null;
}

/** What a stored value is judged against: the code defaults it overrides, and the locked keys. */
export interface SettingsContext {
  readonly defaults: SettingsValues;
  readonly locked: ReadonlySet<SettingKey>;
}

/** A stored key this build does not apply, and why. */
export interface DroppedSetting {
  readonly key: string;
  readonly message: string;
}

/**
 * The stored values this build applies, and the ones it drops: a key the schema does not have, a
 * value the schema refuses, and a value a consumer refuses given the others in force (Weft's
 * workflow-claim timing, for one). A check across keys drops only the stored keys it involves, so
 * one bad value never takes an unrelated one with it and a code default is never dropped.
 */
export function admissibleSettings(
  stored: Readonly<Record<string, unknown>>,
  context: SettingsContext,
): { readonly values: SettingsValues; readonly dropped: readonly DroppedSetting[] } {
  const values: Record<string, unknown> = {};
  const dropped: DroppedSetting[] = [];
  for (const [key, value] of Object.entries(stored)) {
    if (!isSettingKey(key)) {
      dropped.push({ key, message: 'no such setting' });
      continue;
    }
    const checked = parseValue(key, value);
    if (checked.ok) values[key] = checked.value;
    else dropped.push({ key, message: checked.message });
  }
  for (;;) {
    const failures = settingsFailures(effectiveSettings(context.defaults, values, context.locked));
    const offending = failures.flatMap((failure) =>
      failure.keys
        .filter((key) => Object.hasOwn(values, key) && !context.locked.has(key))
        .map((key) => ({ key, message: failure.message })),
    );
    if (offending.length === 0) break;
    for (const { key, message } of offending) {
      if (!Object.hasOwn(values, key)) continue;
      delete values[key];
      dropped.push({ key, message });
    }
  }
  return { values, dropped };
}

/** Writes JSON with object keys sorted, so two equal values always compare equal as text. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === 'object' && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).toSorted(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : inner,
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

/** Validates `value` as the value of `key`, returning the parsed value or the validation message. */
function parseValue(
  key: SettingKey,
  value: unknown,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string } {
  const result = settingsSchema.shape[key].safeParse(value);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, message: z.prettifyError(result.error) };
}

/**
 * Reads the stored record, keeping only the values this build applies ({@link admissibleSettings}).
 * Every dropped key, and a record that is not a settings record at all, is reported through
 * `diagnose`.
 */
export async function readSettingsRecord(
  store: ConditionalTextValueStore,
  context: SettingsContext,
  diagnose: (message: string) => void,
): Promise<StoredSettings> {
  return parseSettingsRecord(await store.get(SETTINGS_RECORD_KEY), context, diagnose);
}

/** {@link readSettingsRecord}'s parse, over text already read. */
export function parseSettingsRecord(
  raw: string | null,
  context: SettingsContext,
  diagnose: (message: string) => void,
): StoredSettings {
  if (raw === null) return { record: undefined, storedValues: {}, raw };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    diagnose('[bureau] The stored settings record is not JSON; every key keeps its code default.');
    return { record: undefined, storedValues: {}, raw };
  }
  const candidate = parsed as Partial<SettingsRecord> | null;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    candidate.schemaVersion !== 1 ||
    typeof candidate.revision !== 'number' ||
    !Number.isSafeInteger(candidate.revision) ||
    typeof candidate.values !== 'object' ||
    candidate.values === null
  ) {
    diagnose(
      '[bureau] The stored settings record is not a schemaVersion 1 record; every key keeps its code default.',
    );
    return { record: undefined, storedValues: {}, raw };
  }
  const storedValues = candidate.values as Readonly<Record<string, unknown>>;
  const { values, dropped } = admissibleSettings(storedValues, context);
  for (const { key, message } of dropped) {
    diagnose(`[bureau] Dropped the stored setting "${key}": ${message}`);
  }
  return {
    storedValues,
    record: {
      schemaVersion: 1,
      revision: candidate.revision,
      values,
      updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : '',
    },
    raw,
  };
}

/** The values in force for `stored` over `defaults`, leaving `locked` keys at their default. */
export function effectiveSettings(
  defaults: SettingsValues,
  stored: SettingsValues | undefined,
  locked: ReadonlySet<SettingKey>,
): SettingsValues {
  const values: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(stored ?? {})) {
    if (isSettingKey(key) && !locked.has(key) && value !== undefined) values[key] = value;
  }
  return values;
}

/** What {@link createSettings} composes `bureau.settings` from. */
export interface SettingsDependencies {
  /** Bureau's key-value store, or `undefined` for a Bureau without storage, which keeps the record in memory. */
  readonly store: ConditionalTextValueStore | undefined;
  /** Whether {@link SettingsDependencies.store} survives the process. */
  readonly persisted: boolean;
  /** The code options, as settings. */
  readonly defaults: SettingsValues;
  readonly locked: ReadonlySet<SettingKey>;
  /** The record as `createBureau` read it at boot, before it applied the `restart` keys. */
  readonly boot: StoredSettings;
  readonly nowISO: () => string;
  /** Reports a `scope: 'settings'` diagnostic. */
  readonly diagnose: (message: string, cause?: unknown) => void;
  /** Appends to the audit trail, when the Bureau keeps one. */
  readonly audit: (entry: {
    readonly runId: string;
    readonly type: string;
    readonly detail: Readonly<Record<string, string | number | boolean>>;
    readonly principal?: string;
  }) => Promise<void>;
  /**
   * Applies the live keys of `values` that changed, named in `keys`, to whatever reads them at a
   * point of use it does not reach on its own: the durable engine's `reconfigure`.
   */
  readonly applyLive?: (values: SettingsValues, keys: readonly SettingKey[]) => void;
}

/** `bureau.settings` and what the rest of the Bureau reads from it. */
export interface SettingsComposition {
  readonly settings: BureauSettings;
  /** The values in force in this process: a `restart` key keeps the value it booted with. */
  current(): SettingsValues;
  /** Re-reads the record and applies what another process changed. Called by every maintenance pass. */
  reload(): Promise<void>;
}

/** Builds `bureau.settings`. */
export function createSettings(dependencies: SettingsDependencies): SettingsComposition {
  const store =
    dependencies.store ?? textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: true });
  const { defaults, locked } = dependencies;
  const context: SettingsContext = { defaults, locked };
  const bootValues = effectiveSettings(defaults, dependencies.boot.record?.values, locked);
  let stored: StoredSettings = dependencies.boot;
  let configured = bootValues;
  let inForce = bootValues;
  const listeners = new Set<(change: SettingsChange) => void>();
  let queue: Promise<unknown> = Promise.resolve();

  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const revisionOf = (state: StoredSettings): number => state.record?.revision ?? 0;

  const inForceOf = (values: SettingsValues): SettingsValues => {
    const next: Record<string, unknown> = { ...values };
    for (const key of SETTING_KEYS) {
      if (SETTING_APPLY[key] !== 'restart') continue;
      if (bootValues[key] === undefined) delete next[key];
      else next[key] = bootValues[key];
    }
    return next;
  };

  const pendingRestartOf = (values: SettingsValues): SettingKey[] =>
    SETTING_KEYS.filter(
      (key) => SETTING_APPLY[key] === 'restart' && !sameValue(values[key], bootValues[key]),
    );

  /** Adopts `next`, applies the live keys that changed, and tells every listener. */
  const adopt = (next: StoredSettings, keys: readonly SettingKey[]): void => {
    const previous = inForce;
    stored = next;
    configured = effectiveSettings(defaults, next.record?.values, locked);
    inForce = inForceOf(configured);
    const changedLive = SETTING_KEYS.filter(
      (key) => SETTING_APPLY[key] === 'live' && !sameValue(previous[key], inForce[key]),
    );
    if (changedLive.length > 0) {
      try {
        dependencies.applyLive?.(inForce, changedLive);
      } catch (error) {
        dependencies.diagnose(
          `[bureau] Applying the settings at revision ${revisionOf(next)} failed: ${String(error)}`,
          error,
        );
      }
    }
    const change: SettingsChange = { revision: revisionOf(next), keys };
    for (const listener of listeners) {
      try {
        listener(change);
      } catch (error) {
        dependencies.diagnose('[bureau] A settings listener threw.', error);
      }
    }
  };

  const reject = (
    reason: Extract<SettingsUpdateResult, { outcome: 'rejected' }>['reason'],
    keys: readonly string[],
    message: string,
    currentRevision: number,
  ): SettingsUpdateResult => ({ outcome: 'rejected', reason, keys, message, currentRevision });

  const settings: BureauSettings = {
    get: () =>
      Promise.resolve({
        values: configured,
        revision: revisionOf(stored),
        persisted: dependencies.persisted,
        keys: Object.fromEntries(
          SETTING_KEYS.map((key): [SettingKey, SettingKeyState] => [
            key,
            {
              apply: SETTING_APPLY[key],
              locked: locked.has(key),
              pendingRestart:
                SETTING_APPLY[key] === 'restart' && !sameValue(configured[key], bootValues[key]),
            },
          ]),
        ) as Record<SettingKey, SettingKeyState>,
      }),
    schema: () => z.toJSONSchema(settingsSchema, { io: 'input' }),
    update: (patch, options) =>
      serialized(async () => {
        const patchKeys = Object.keys(patch);
        const known = revisionOf(stored);
        const unknownKeys = patchKeys.filter((key) => !isSettingKey(key));
        if (unknownKeys.length > 0) {
          return reject(
            'unknown-key',
            unknownKeys,
            `No such setting: ${unknownKeys.join(', ')}`,
            known,
          );
        }
        const keys = patchKeys as SettingKey[];
        if (keys.length === 0) {
          return reject('invalid-value', [], 'The patch changes no setting', known);
        }
        const lockedKeys = keys.filter((key) => locked.has(key));
        if (lockedKeys.length > 0) {
          return reject(
            'locked',
            lockedKeys,
            `The deployment locks ${lockedKeys.join(', ')}; the code option applies`,
            known,
          );
        }
        const values: Record<string, unknown> = {};
        const invalid: string[] = [];
        const messages: string[] = [];
        for (const key of keys) {
          const checked = parseValue(key, patch[key]);
          if (checked.ok) values[key] = checked.value;
          else {
            invalid.push(key);
            messages.push(`${key}: ${checked.message}`);
          }
        }
        if (invalid.length > 0) {
          return reject('invalid-value', invalid, messages.join('; '), known);
        }
        const current = await readSettingsRecord(store, context, (message) =>
          dependencies.diagnose(message),
        );
        const currentRevision = revisionOf(current);
        if (currentRevision !== options.expectedRevision) {
          return reject(
            'stale-revision',
            keys,
            `The settings are at revision ${currentRevision}, not ${options.expectedRevision}`,
            currentRevision,
          );
        }
        // Merged over the values as stored, so a key this build drops (another build's, or one it
        // refuses) is written back as it was; it is still never applied here.
        const merged: Record<string, unknown> = { ...current.storedValues, ...values };
        const refused = admissibleSettings(merged, context).dropped.filter(({ key }) =>
          keys.includes(key as SettingKey),
        );
        if (refused.length > 0) {
          return reject(
            'invalid-value',
            [...new Set(refused.map(({ key }) => key))],
            refused.map(({ key, message }) => `${key}: ${message}`).join('; '),
            currentRevision,
          );
        }
        const record: SettingsRecord = {
          schemaVersion: 1,
          revision: currentRevision + 1,
          // The record's type names the keys this build knows; the text keeps the others too.
          values: merged,
          updatedAt: dependencies.nowISO(),
        };
        const text = JSON.stringify(record);
        const committed = await store.conditionalBatch(
          [{ key: SETTINGS_RECORD_KEY, expectedValue: current.raw }],
          [{ type: 'set', key: SETTINGS_RECORD_KEY, value: text }],
        );
        if (!committed) {
          const now = await readSettingsRecord(store, context, (message) =>
            dependencies.diagnose(message),
          );
          return reject(
            'stale-revision',
            keys,
            'The settings changed while this update was written',
            revisionOf(now),
          );
        }
        adopt(
          parseSettingsRecord(text, context, () => undefined),
          keys,
        );
        try {
          await dependencies.audit({
            runId: SETTINGS_AUDIT_RESOURCE,
            type: SETTINGS_CHANGED_AUDIT_TYPE,
            detail: { keys: keys.join(','), revision: record.revision },
            ...(options.principal === undefined ? {} : { principal: options.principal }),
          });
        } catch (error) {
          dependencies.diagnose(
            `[bureau] The settings.changed audit record for revision ${record.revision} failed to append.`,
            error,
          );
        }
        return {
          outcome: 'applied',
          revision: record.revision,
          pendingRestart: pendingRestartOf(configured).filter((key) => keys.includes(key)),
        };
      }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  if (dependencies.applyLive !== undefined) {
    const live = SETTING_KEYS.filter(
      (key) => SETTING_APPLY[key] === 'live' && inForce[key] !== undefined,
    );
    if (live.length > 0) dependencies.applyLive(inForce, live);
  }

  return {
    settings,
    current: () => inForce,
    reload: () =>
      serialized(async () => {
        const raw = await store.get(SETTINGS_RECORD_KEY);
        if (raw === stored.raw) return;
        const next = parseSettingsRecord(raw, context, (message) => dependencies.diagnose(message));
        const before = configured;
        const after = effectiveSettings(defaults, next.record?.values, locked);
        adopt(
          next,
          SETTING_KEYS.filter((key) => !sameValue(before[key], after[key])),
        );
      }),
  };
}
