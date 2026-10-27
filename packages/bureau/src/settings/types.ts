/**
 * The types of `bureau.settings` (COR-1710).
 *
 * @module settings-types
 */

import type { SettingApply, SettingKey, SettingsValues } from './settings-schema.ts';

/** How one key stands: how it applies, whether the deployment locked it, and whether a stored value waits for a restart. */
export interface SettingKeyState {
  readonly apply: SettingApply;
  /** Named in {@link SettingsOptions.locked}: the store may not override the code option. */
  readonly locked: boolean;
  /** A `restart` key whose stored value differs from the value this process booted with. */
  readonly pendingRestart: boolean;
}

/** What `bureau.settings.get()` reports. */
export interface SettingsSnapshot {
  /** Each key's value: the stored value where the store has one and the key is not locked, else the code default. */
  readonly values: SettingsValues;
  /** How many times the stored record has changed; `0` before the first change. */
  readonly revision: number;
  /** Whether the record survives the process: `false` for a Bureau without persistent storage. */
  readonly persisted: boolean;
  readonly keys: Readonly<Record<SettingKey, SettingKeyState>>;
}

/** Why an update was refused. Nothing is written for any of them. */
export type SettingsRejectionReason = 'locked' | 'stale-revision' | 'unknown-key' | 'invalid-value';

/** What `bureau.settings.update()` returns. It never throws for a patch it refuses. */
export type SettingsUpdateResult =
  | {
      readonly outcome: 'applied';
      /** The record's revision after the change. */
      readonly revision: number;
      /** The `restart` keys the change set, which take effect at the next `createBureau`. */
      readonly pendingRestart: readonly SettingKey[];
    }
  | {
      readonly outcome: 'rejected';
      readonly reason: SettingsRejectionReason;
      /** The keys the refusal names: unknown, locked, or invalid ones; every patched key for `stale-revision`. */
      readonly keys: readonly string[];
      readonly message: string;
      /** The record's revision now. */
      readonly currentRevision: number;
    };

/** What `update` takes besides the patch. */
export interface SettingsUpdateOptions {
  /** The revision the patch was written against. A record that has changed since refuses it with `stale-revision`. */
  readonly expectedRevision: number;
  /** Who is changing the settings, recorded on the `settings.changed` audit record. */
  readonly principal?: string | undefined;
}

/** One change, as `subscribe` reports it: the new revision and the keys it changed. */
export interface SettingsChange {
  readonly revision: number;
  readonly keys: readonly SettingKey[];
}

/** `bureau.settings`: the deployment's runtime settings, editable while it runs. */
export interface BureauSettings {
  /** Every key's value and state, and the record's revision. */
  get(): Promise<SettingsSnapshot>;
  /** {@link settingsSchema} as JSON Schema 2020-12. */
  schema(): Record<string, unknown>;
  /**
   * Changes the keys in `patch`, all or none. A `live` key takes effect at its next point of use
   * in this process, and in another process on the same store after its next maintenance pass; a
   * `restart` key at the next `createBureau`.
   */
  update(
    patch: Readonly<Record<string, unknown>>,
    options: SettingsUpdateOptions,
  ): Promise<SettingsUpdateResult>;
  /** Calls `listener` after every change this process applies, its own or one it re-read. Returns the unsubscribe. */
  subscribe(listener: (change: SettingsChange) => void): () => void;
}

/** {@link BureauOptions.settings}: which keys the store may not override. */
export interface SettingsOptions {
  /** Keys whose code option always applies: `update` refuses them with `locked`, and a stored value is ignored. */
  readonly locked?: readonly SettingKey[];
}
