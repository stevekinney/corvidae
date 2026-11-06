/**
 * The one save model of Settings (design rows 47i to 47p): a setting saves when the person leaves
 * its field, and its own row says what became of it: saving, saved, the error. There is no
 * page-level Save.
 *
 * Each save is one `bureau.settings.update` with the one key, against the revision the page last
 * read. Saves run one after another, so the revision each names is the one the save before it
 * produced, and a change to one row never waits on or throws away another's. A save the Bureau
 * refuses as stale (the settings changed elsewhere in between) reads the settings again and goes
 * once more. A value that fails its own check is never sent; a save that does not go through keeps
 * the typed value in its field, says so on its row, and can be tried again.
 */
import { SvelteMap } from 'svelte/reactivity';

import {
  settingsFaultOf,
  type SettingsFault,
  type SettingsSnapshot,
  type SettingsUpdateReceipt,
} from '../../lib/bureau-settings.ts';
import { sameValue, type SettingsForm } from './settings-form.svelte.ts';

/** Where one setting's own save has got to. */
export type SaveState =
  | { readonly phase: 'saving' }
  | { readonly phase: 'saved' }
  /** The value failed its own check when the field was left, so nothing was sent. */
  | { readonly phase: 'invalid' }
  /** The Bureau did not take the value, or did not answer. The typed value is still in the field. */
  | { readonly phase: 'failed'; readonly fault: Exclude<SettingsFault, { kind: 'stale' }> };

/** What the saves need from the page. */
export interface SettingsAutosaveDependencies {
  readonly form: SettingsForm;
  /** Sends a patch against a revision (`bureau.settings.update`). */
  readonly update: (
    patch: Record<string, unknown>,
    expectedRevision: number,
  ) => Promise<SettingsUpdateReceipt>;
  /** Reads the settings again. */
  readonly read: () => Promise<SettingsSnapshot>;
}

/** Saves each setting as it is left, and holds what became of each. */
export class SettingsAutosave {
  readonly #states = new SvelteMap<string, SaveState>();
  readonly #dependencies: SettingsAutosaveDependencies;
  #queue: Promise<unknown> = Promise.resolve();
  /** Keys changed again while their save was in flight, which the page saves once it has finished. */
  readonly #again = new Set<string>();

  constructor(dependencies: SettingsAutosaveDependencies) {
    this.#dependencies = dependencies;
  }

  /** Where the save of `key` has got to, or `undefined` for a setting at rest. */
  stateOf(key: string): SaveState | undefined {
    return this.#states.get(key);
  }

  /** Whether any save is in flight or waiting its turn. */
  get busy(): boolean {
    return [...this.#states.values()].some((state) => state.phase === 'saving');
  }

  /** Whether any setting's save has finished and says so, which a page header words as "Saved just now". */
  get anySaved(): boolean {
    return [...this.#states.values()].some((state) => state.phase === 'saved');
  }

  /**
   * The field of `key` was left (or a switch or select changed): checks the value and, when it
   * holds, saves it. A key that is not changed saves nothing.
   */
  commit(key: string): Promise<void> {
    const { form } = this.#dependencies;
    if (this.#states.get(key)?.phase === 'saving') {
      // The value being sent is not what the field holds now; send that once this save is done.
      this.#again.add(key);
      return this.settled();
    }
    if (!form.isDirty(key)) {
      // Leaving a field that was changed and put back leaves nothing to say.
      if (this.#states.get(key)?.phase === 'invalid') this.#states.delete(key);
      return Promise.resolve();
    }
    this.#states.set(key, { phase: 'saving' });
    const turn = this.#queue.then(() => this.#save(key));
    this.#queue = turn.catch(() => undefined);
    return turn;
  }

  /** Sends the value of a key whose save failed once more. */
  retry(key: string): Promise<void> {
    return this.commit(key);
  }

  /** Forgets what became of `key`, as when the person starts changing it again. */
  clear(key: string): void {
    const state = this.#states.get(key);
    if (state !== undefined && state.phase !== 'saving') this.#states.delete(key);
  }

  /** Resolves when every save asked for so far has finished. */
  async settled(): Promise<void> {
    let queue: Promise<unknown>;
    do {
      queue = this.#queue;
      await queue;
    } while (queue !== this.#queue);
  }

  /** Saves what a key holds now when it was changed again while its save was in flight. */
  #sendAgain(key: string): void {
    if (!this.#again.delete(key)) return;
    this.#states.delete(key);
    void this.commit(key);
  }

  async #save(key: string): Promise<void> {
    const { form, update, read } = this.#dependencies;
    // An edit made a moment ago may still be checked against its schema.
    await form.settled();
    if (!form.isDirty(key)) {
      this.#states.delete(key);
      return;
    }
    if (form.error(key) !== undefined) {
      this.#states.set(key, { phase: 'invalid' });
      return;
    }
    // A field still being typed in, or a list holding text not yet added, is not a value yet.
    if (!form.canSaveKey(key)) {
      this.#states.delete(key);
      return;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const sent = form.draft(key);
        // A key put back to unset has no value to send; `null` is how the Bureau is told to clear it.
        await update({ [key]: sent === undefined ? null : sent }, form.revision);
        const fresh = await read();
        // A value typed while the save was in flight is the field's, not the one that was sent.
        const unchanged = sameValue(form.draft(key), sent);
        form.rebase(fresh, unchanged ? [key] : [], unchanged ? [] : [key]);
        this.#states.set(key, { phase: 'saved' });
        this.#sendAgain(key);
        return;
      } catch (error) {
        const fault = settingsFaultOf(error);
        if (fault.kind === 'stale' && attempt === 0) {
          // The settings moved on: read them again and send the same value against the new revision.
          try {
            form.rebase(await read());
          } catch {
            this.#states.set(key, {
              phase: 'failed',
              fault: { kind: 'other', message: 'The settings could not be read again.' },
            });
            return;
          }
          continue;
        }
        this.#states.set(key, {
          phase: 'failed',
          fault:
            fault.kind === 'stale' ? { kind: 'other', message: 'The settings changed.' } : fault,
        });
        return;
      }
    }
  }
}
