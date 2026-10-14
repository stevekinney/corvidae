/**
 * The theme builder controller (COR-490): the draft core plus the local library (create,
 * rename, duplicate, switch, delete to Trash, restore, permanently delete), startup from
 * storage, and the multi-tab conflict flow. Every operation returns a result whose message is
 * ready to show next to the control that asked.
 */

import { cinderThemeBase } from './theme-builder-base.ts';
import {
  ThemeBuilderCore,
  type ConflictState,
  type ControllerDeps,
} from './theme-builder-core.svelte.ts';
import { downloadText } from './theme-download.ts';
import type { StorageProblem } from './theme-draft-storage.ts';
import {
  decideRemoteRevision,
  reloadDiscardCopy,
  type RevisionAnnouncement,
} from './theme-draft-sync.ts';
import type { ThemeEnvelope } from './theme-draft-types.ts';
import { envelopeDownload } from './theme-envelope.ts';
import {
  activeThemes,
  createTheme,
  deleteTheme,
  duplicateTheme,
  importThemeCopy,
  permanentDeleteCopy,
  permanentlyDeleteTheme,
  renameTheme,
  restoreTheme,
  saveDraftAsCopy,
  switchTheme,
  type LibraryProblem,
  type LibraryResult,
  type ThemeEntry,
} from './theme-library.ts';
import { MAX_THEME_NAME_LENGTH } from './theme-names.ts';

export type OperationResult = { ok: true; id: string } | { ok: false; message: string };

const MESSAGES: Record<LibraryProblem, string> = {
  'name-empty': 'Enter a name.',
  'name-too-long': `Use ${MAX_THEME_NAME_LENGTH} characters or fewer.`,
  'name-conflict': 'Another theme already uses that name. Choose a different name.',
  'theme-limit': 'The library is full. Permanently delete a theme or download it first.',
  limits: 'That theme is over the supported size limits.',
  'not-found': 'That theme no longer exists.',
  'not-in-trash': 'Only a theme in Trash can be deleted permanently.',
  'in-trash': 'That theme is in Trash. Restore it first.',
};

export const DEFAULT_THEME_NAME = 'Cinder default';

export class ThemeBuilderController extends ThemeBuilderCore {
  /** Unreadable stored records this tab has downloaded, which unlocks their permanent delete. */
  downloadedProblemIds = $state.raw<readonly string[]>([]);
  #stopListening: (() => void) | null = null;
  readonly #newId: () => string;
  readonly #now: () => string;

  constructor(deps: ControllerDeps & { newId?: () => string; now?: () => string }) {
    super(deps);
    this.#newId = deps.newId ?? (() => crypto.randomUUID());
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.workbench.contextChangeHandler = (context) => void this.switchContext(context);
  }

  get problems(): StorageProblem[] {
    return this.persistence?.problems ?? [];
  }

  get activeThemes(): ThemeEntry[] {
    return activeThemes(this.library);
  }

  /** Load the library, restore the active theme, and start listening to other tabs. */
  async start(): Promise<void> {
    const loaded = await this.persistence?.open();
    if (loaded !== null && loaded !== undefined) {
      const first = activeThemes(loaded.library)[0]?.draft.envelope.id ?? null;
      this.library = {
        ...loaded.library,
        activeId: loaded.library.activeId ?? first,
      };
    }
    if (this.library.activeId === null) {
      this.library = this.#withDefault();
      this.persistSoon(0);
    }
    this.#stopListening =
      this.persistence?.listen((message) => void this.#onRemote(message)) ?? null;
    this.syncStatus();
    this.ready = true;
    await this.render();
    this.announcement = 'Theme builder';
  }

  stop(): void {
    this.#stopListening?.();
    this.#stopListening = null;
    this.workbench.contextChangeHandler = null;
  }

  #withDefault() {
    const taken = this.library;
    const result = createTheme(taken, this.#newId(), DEFAULT_THEME_NAME, cinderThemeBase());
    if (result.ok) return result.library;
    return taken;
  }

  #adopt(result: LibraryResult): OperationResult {
    if (!result.ok) return { ok: false, message: MESSAGES[result.reason] };
    this.library = result.library;
    return { ok: true, id: result.id };
  }

  async #afterActiveChange(id: string, message: string): Promise<void> {
    this.gate.invalidate();
    this.rejection = null;
    this.conflict = null;
    this.persistSoon(0, id);
    void this.persistence?.setActive(this.library.activeId);
    this.syncStatus();
    this.announcement = message;
    await this.render();
  }

  async createTheme(name: string): Promise<OperationResult> {
    const result = this.#adopt(createTheme(this.library, this.#newId(), name, cinderThemeBase()));
    if (result.ok) await this.#afterActiveChange(result.id, `Created ${this.#nameOf(result.id)}`);
    return result;
  }

  renameTheme(id: string, name: string): OperationResult {
    const result = this.#adopt(renameTheme(this.library, id, name));
    if (result.ok) {
      this.persistSoon(0, id);
      this.syncStatus();
      this.announcement = `Renamed to ${this.#nameOf(id)}`;
    }
    return result;
  }

  async duplicateTheme(id: string): Promise<OperationResult> {
    const result = this.#adopt(duplicateTheme(this.library, id, this.#newId()));
    if (result.ok)
      await this.#afterActiveChange(result.id, `Duplicated as ${this.#nameOf(result.id)}`);
    return result;
  }

  /** Import an already-validated envelope as a new theme; a taken name gets a numeric suffix. */
  async importAsCopy(envelope: ThemeEnvelope): Promise<OperationResult> {
    const result = this.#adopt(importThemeCopy(this.library, envelope, this.#newId()));
    if (result.ok) await this.#afterActiveChange(result.id, `Imported as ${this.#nameOf(result.id)}`);
    return result;
  }

  async switchTheme(id: string): Promise<OperationResult> {
    if (id === this.library.activeId) return { ok: true, id };
    const result = this.#adopt(switchTheme(this.library, id));
    if (result.ok) await this.#afterActiveChange(id, `Switched to ${this.#nameOf(id)}`);
    return result;
  }

  /** Move to Trash. The theme stays restorable; the next theme (or a new default) opens. */
  async deleteTheme(id: string): Promise<OperationResult> {
    const name = this.#nameOf(id);
    const result = this.#adopt(deleteTheme(this.library, id, this.#now()));
    if (!result.ok) return result;
    this.persistSoon(0, id);
    if (this.library.activeId === null) {
      this.library = this.#withDefault();
    }
    const next = this.library.activeId;
    if (next !== null) await this.#afterActiveChange(next, `Moved ${name} to Trash`);
    return result;
  }

  async restoreTheme(id: string): Promise<OperationResult> {
    const result = this.#adopt(restoreTheme(this.library, id));
    if (result.ok) await this.#afterActiveChange(id, `Restored ${this.#nameOf(id)}`);
    return result;
  }

  async permanentlyDeleteTheme(id: string): Promise<OperationResult> {
    const entry = this.library.entries[id];
    const name = this.#nameOf(id);
    const result = this.#adopt(permanentlyDeleteTheme(this.library, id));
    if (!result.ok || entry === undefined) return result;
    await this.persistence?.removePermanently(id, entry.draft.revision);
    this.announcement = `Permanently deleted ${name}`;
    return result;
  }

  #nameOf(id: string): string {
    return this.library.entries[id]?.draft.envelope.name ?? 'theme';
  }

  permanentDeleteCopy(id: string): string {
    return permanentDeleteCopy(this.#nameOf(id));
  }

  reloadDiscardCopy(id: string): string {
    return reloadDiscardCopy(this.#nameOf(id));
  }

  // --- downloads ----------------------------------------------------------------------

  /** Download the active theme's lossless envelope (the recovery action for storage states). */
  downloadActive(): void {
    const envelope = this.draft?.envelope;
    if (envelope !== undefined) downloadText(envelopeDownload(envelope));
  }

  downloadProblem(problem: StorageProblem): void {
    downloadText(problem.download);
    if (!this.downloadedProblemIds.includes(problem.id)) {
      this.downloadedProblemIds = [...this.downloadedProblemIds, problem.id];
    }
  }

  /** A newer-version record can be deleted for good only after this tab downloaded it. */
  canDeleteProblem(problem: StorageProblem): boolean {
    return problem.kind === 'future-version' && this.downloadedProblemIds.includes(problem.id);
  }

  async deleteFutureVersionProblem(problem: StorageProblem): Promise<OperationResult> {
    if (!this.canDeleteProblem(problem)) {
      return { ok: false, message: 'Download the stored theme before deleting it permanently.' };
    }
    const result = await this.persistence?.removeFutureVersionRecord(problem);
    if (result === null || result === undefined) {
      return { ok: false, message: 'Theme storage is unavailable, so nothing was deleted.' };
    }
    if (!result.ok) return { ok: false, message: result.failure.message };
    this.downloadedProblemIds = this.downloadedProblemIds.filter((id) => id !== problem.id);
    return { ok: true, id: problem.id };
  }

  // --- other tabs ---------------------------------------------------------------------

  protected override onSaveConflict(id: string, storedRevision: number | null): void {
    if (storedRevision === null) return;
    void this.#onRemote({ type: 'revision', themeId: id, revision: storedRevision, sender: '' });
  }

  async #onRemote(message: RevisionAnnouncement): Promise<void> {
    const stored = await this.persistence?.read(message.themeId);
    const entry = this.library.entries[message.themeId];
    if (stored === undefined) return;
    if (!stored.ok) {
      this.#remoteRemoved(message.themeId, stored.failure.kind === 'conflict');
      return;
    }
    if (entry === undefined) {
      this.setEntry(stored.entry);
      return;
    }
    // Partial input that was autosaved is still the user's unfinished work in this tab, and the
    // newer stored record does not carry it: treat it as unsaved so it is never replaced silently.
    const holdsInput = Object.keys(entry.draft.inputBuffer).length > 0;
    const decision = decideRemoteRevision(
      holdsInput ? { ...entry.draft, unsavedInput: true } : entry.draft,
      stored.entry.draft.revision,
    );
    if (decision.kind === 'ignore') return;
    if (decision.kind === 'auto-reload') {
      await this.#takeStored(stored.entry, decision.announcement);
      return;
    }
    const conflict: ConflictState = { id: message.themeId, message: decision.message };
    this.conflict = conflict;
    this.announcement = 'Another tab changed this draft.';
  }

  /** Another tab permanently deleted a theme this tab holds. */
  #remoteRemoved(id: string, gone: boolean): void {
    const entry = this.library.entries[id];
    if (!gone || entry === undefined || entry.trashed === null) return;
    const entries = { ...this.library.entries };
    delete entries[id];
    this.library = { ...this.library, entries };
  }

  async #takeStored(stored: ThemeEntry, announcement: string): Promise<void> {
    const id = stored.draft.envelope.id;
    this.setEntry(stored);
    if (this.library.activeId === id && stored.trashed !== null) {
      const next = activeThemes(this.library)[0]?.draft.envelope.id ?? null;
      this.library = { ...this.library, activeId: next };
      if (next === null) this.library = this.#withDefault();
    }
    this.conflict = null;
    this.syncStatus();
    this.announcement = announcement;
    await this.render();
  }

  /** "Reload stored version": the caller has already confirmed the discard. */
  async reloadStoredVersion(): Promise<void> {
    const conflict = this.conflict;
    if (conflict === null) return;
    const stored = await this.persistence?.read(conflict.id);
    if (stored === undefined || !stored.ok) return;
    await this.#takeStored(
      stored.entry,
      `Reloaded the stored version of ${this.#nameOf(conflict.id)}.`,
    );
  }

  /** "Save as copy": the unsaved content becomes a new theme; the original reloads from storage. */
  async saveConflictAsCopy(): Promise<OperationResult> {
    const conflict = this.conflict;
    if (conflict === null) return { ok: false, message: 'Nothing to save.' };
    const stored = await this.persistence?.read(conflict.id);
    const result = this.#adopt(saveDraftAsCopy(this.library, conflict.id, this.#newId()));
    if (!result.ok) return result;
    if (stored !== undefined && stored.ok) this.setEntry(stored.entry);
    await this.#afterActiveChange(result.id, `Saved your draft as ${this.#nameOf(result.id)}`);
    return result;
  }
}
