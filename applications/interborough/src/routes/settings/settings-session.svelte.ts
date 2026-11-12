/**
 * What a section of Settings that saves each setting as it is left needs around its rows: the
 * controls the schema calls for, the form over them, the autosave, Revert and its Undo, and the
 * restart flow the restart notice draws. The General and A2A sections build the same set inline;
 * a section that has nothing of its own to add builds it here, by calling `new SettingsSession(...)`
 * while its component initialises, since it registers effects and teardown.
 */
import { validateSchemaFormValue } from '@lostgradient/cinder';
import type { QueryClient } from '@tanstack/svelte-query';
import { onDestroy, untrack } from 'svelte';

import { SETTINGS_COPY } from '../../app/copy/settings.ts';
import { HostRestartFlow } from '../../app/restart/host-restart-flow.svelte.ts';
import { dismissToast, showToast } from '../../app/toast-host.svelte';
import {
  getSettings,
  updateSettings,
  type SettingKeyState,
  type SettingsSchema,
  type SettingsSnapshot,
} from '../../lib/bureau-settings.ts';
import { queryKeys } from '../../lib/query.ts';
import { SettingsAutosave } from './settings-autosave.svelte.ts';
import { controlFor, type Control } from './settings-controls.ts';
import { formSchemaOf, numbersCommitted } from './settings-form-schema.ts';
import { SettingsForm } from './settings-form.svelte.ts';
import { SettingsRevert } from './settings-revert.svelte.ts';

/** What a key without a state from the Bureau is: a live key nothing holds. */
const UNKNOWN_STATE: SettingKeyState = { apply: 'live', locked: false, pendingRestart: false };

/** A check a section adds to the schema's own: the problem with a value, or `undefined` when it holds. */
export type SettingsExtraCheck = (key: string, value: unknown) => string | undefined;

/** The settings machinery of one section of Settings. */
export class SettingsSession {
  /** The control of each setting, by the shape of its schema node. */
  readonly controls: ReadonlyMap<string, Control>;
  /** The draft of every setting. */
  readonly form: SettingsForm;
  /** Saves each setting as it is left. */
  readonly autosave: SettingsAutosave;
  /** The restart notice's Revert, and its Undo. */
  readonly revert: SettingsRevert;
  /** The restart: its phases, its refusal and its progress. */
  readonly restartFlow: HostRestartFlow<SettingsSnapshot>;
  readonly #schema: SettingsSchema;
  readonly #snapshot: () => SettingsSnapshot;

  /**
   * Builds the session over the schema and the snapshot the page holds now (read through
   * `snapshot`, so a read again is taken in). `extraCheck` is a check the section adds to the
   * schema's own, such as the days a window may name.
   */
  constructor(options: {
    readonly schema: SettingsSchema;
    readonly snapshot: () => SettingsSnapshot;
    readonly queryClient: QueryClient;
    readonly extraCheck?: SettingsExtraCheck;
  }) {
    const { schema, snapshot, queryClient, extraCheck } = options;
    this.#schema = schema;
    this.#snapshot = snapshot;
    const controls = new Map<string, Control>(
      Object.entries(schema).map(([key, node]) => [key, controlFor(key, node)]),
    );
    this.controls = controls;

    const validate = async (key: string, value: unknown): Promise<string | undefined> => {
      const node = schema[key];
      if (node === undefined) return undefined;
      const result = await validateSchemaFormValue(formSchemaOf(key, node), value);
      if (!result.valid) return result.issues[0]?.message ?? SETTINGS_COPY.invalidValue;
      return extraCheck?.(key, value);
    };
    const committed = (key: string, value: unknown): boolean => {
      const node = schema[key];
      return node === undefined || numbersCommitted(formSchemaOf(key, node), value);
    };
    this.form = new SettingsForm(controls, (key) => this.stateOf(key).locked, validate, committed);
    untrack(() => this.form.load(snapshot()));

    const read = (): Promise<SettingsSnapshot> =>
      queryClient.fetchQuery({
        queryKey: queryKeys.settings.snapshot(),
        queryFn: ({ signal }) => getSettings({ signal }),
        staleTime: 0,
      });
    const update = (patch: Record<string, unknown>, expectedRevision: number) =>
      updateSettings(patch, expectedRevision);
    this.autosave = new SettingsAutosave({ form: this.form, update, read });
    this.revert = new SettingsRevert({
      form: this.form,
      update,
      read,
      showUndo: (message, undo) => showToast(message, { undo }),
      dismiss: dismissToast,
      fail: (message) => void showToast(message, { variant: 'danger' }),
    });
    onDestroy(() => this.revert.dispose());

    // The settings were read again: every setting not being edited takes them. A save in flight
    // reads them again itself and takes them when it is done, so this waits for it.
    $effect(() => {
      const latest = snapshot();
      if (this.autosave.busy) return;
      untrack(() => {
        if (latest.revision !== this.form.revision) this.form.rebase(latest);
      });
    });

    this.restartFlow = new HostRestartFlow<SettingsSnapshot>({
      read: () => getSettings(),
      waiting: (current) => Object.values(current.keys).some((key) => key.pendingRestart),
    });
    onDestroy(() => this.restartFlow.dispose());
    $effect(() => {
      if (this.restartFlow.phase !== 'back') return;
      untrack(() => void queryClient.invalidateQueries());
    });
  }

  /** What the Bureau says of a key: how it applies, whether it is locked, and whether a restart waits on it. */
  stateOf(key: string): SettingKeyState {
    return this.#snapshot().keys[key] ?? UNKNOWN_STATE;
  }

  /** The settings that wait for a restart, in the schema's order. */
  get restartKeys(): readonly string[] {
    return Object.keys(this.#schema).filter((key) => this.stateOf(key).pendingRestart);
  }
}
