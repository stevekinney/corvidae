/**
 * Revert and its Undo on Settings › General (board SettingsShell, "More states"): the restart
 * banner's "Revert N changes" puts every saved setting that waits for a restart back to the value
 * the host runs now, in one `bureau.settings.update`. Each of those rows then reads "Reverted, in
 * effect now", and an Undo toast offers to put the saved values back. The toast stays until it is
 * acted on or the page is left ({@link SettingsRevert.dispose}).
 *
 * The value the host runs is the snapshot's `running` entry; a key nothing set at boot has none,
 * and is reverted by clearing its stored value (`null`). Undo writes back what was saved, or clears
 * a key that had no saved value. A write the Bureau refuses as stale reads the settings again and
 * goes once more, as a row's own save does.
 */
import { SvelteSet } from 'svelte/reactivity';

import { SETTINGS_COPY } from '../../app/copy/settings.ts';
import {
  settingsFaultOf,
  type SettingsSnapshot,
  type SettingsUpdateReceipt,
} from '../../lib/bureau-settings.ts';
import type { SettingsForm } from './settings-form.svelte.ts';

/** What Revert and Undo need from the page. */
export interface SettingsRevertDependencies {
  readonly form: SettingsForm;
  /** Sends a patch against a revision (`bureau.settings.update`). */
  readonly update: (
    patch: Record<string, unknown>,
    expectedRevision: number,
  ) => Promise<SettingsUpdateReceipt>;
  /** Reads the settings again. */
  readonly read: () => Promise<SettingsSnapshot>;
  /** Shows the Undo toast, which calls `undo` when pressed, and returns its id. */
  readonly showUndo: (message: string, undo: () => void) => string | undefined;
  /** Removes a toast this page showed. */
  readonly dismiss: (id: string) => void;
  /** Says that Revert or Undo did not go through. */
  readonly fail: (message: string) => void;
}

/** The patch that puts each of `keys` to its `source` entry, or clears it where `source` has none. */
function patchOf(keys: readonly string[], source: Readonly<Record<string, unknown>>) {
  return Object.fromEntries(
    keys.map((key) => [key, Object.hasOwn(source, key) ? source[key] : null]),
  );
}

/** Reverts the settings that wait for a restart, and undoes it. */
export class SettingsRevert {
  readonly #dependencies: SettingsRevertDependencies;
  readonly #reverted = new SvelteSet<string>();
  #toast: string | undefined;
  /** Whether a Revert or an Undo is being written. */
  busy = $state(false);

  constructor(dependencies: SettingsRevertDependencies) {
    this.#dependencies = dependencies;
  }

  /** Whether `key` was put back to its running value by the last Revert, and not changed since. */
  isReverted(key: string): boolean {
    return this.#reverted.has(key);
  }

  /** Forgets that `key` was reverted, as when the person changes it again. */
  forget(key: string): void {
    this.#reverted.delete(key);
  }

  /** Puts each of `keys` back to the value `snapshot` says the host runs, and offers Undo. */
  async revert(keys: readonly string[], snapshot: SettingsSnapshot): Promise<void> {
    if (keys.length === 0 || this.busy) return;
    const saved = patchOf(keys, snapshot.values);
    if (!(await this.#write(patchOf(keys, snapshot.running), keys))) {
      this.#dependencies.fail(SETTINGS_COPY.general.reverted.revertFailed);
      return;
    }
    this.#dismissToast();
    this.#reverted.clear();
    for (const key of keys) this.#reverted.add(key);
    this.#toast = this.#dependencies.showUndo(
      SETTINGS_COPY.general.reverted.toast(keys.length),
      () => {
        this.#toast = undefined;
        void this.#undo(saved, keys);
      },
    );
  }

  /** Removes the Undo toast, for when the page is left. */
  dispose(): void {
    this.#dismissToast();
  }

  async #undo(saved: Record<string, unknown>, keys: readonly string[]): Promise<void> {
    if (!(await this.#write(saved, keys))) {
      this.#dependencies.fail(SETTINGS_COPY.general.reverted.undoFailed);
      return;
    }
    for (const key of keys) this.#reverted.delete(key);
  }

  /** Writes `patch` against the page's revision, reading again once when it is stale. */
  async #write(patch: Record<string, unknown>, keys: readonly string[]): Promise<boolean> {
    const { form, update, read } = this.#dependencies;
    this.busy = true;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await update(patch, form.revision);
          form.rebase(await read(), keys);
          return true;
        } catch (error) {
          if (settingsFaultOf(error).kind !== 'stale' || attempt > 0) return false;
          form.rebase(await read());
        }
      }
      return false;
    } catch {
      return false;
    } finally {
      this.busy = false;
    }
  }

  #dismissToast(): void {
    if (this.#toast === undefined) return;
    this.#dependencies.dismiss(this.#toast);
    this.#toast = undefined;
  }
}
