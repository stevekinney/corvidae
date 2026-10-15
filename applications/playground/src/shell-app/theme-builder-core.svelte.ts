/**
 * The draft controller's core (COR-490, COR-261): the active theme's committed state, the
 * path from an edit to the preview, history, reset, and local autosave. An edit is validated
 * by the token runtime before it commits, so an invalid value never reaches history, storage
 * or the preview; the last-valid revision's map for the active context is what the preview
 * renders. Library operations and cross-tab handling extend this in `theme-builder-controller`.
 */

import { catalogueRowByPath } from './theme-builder-catalogue.ts';
import type { ThemeBuilderPersistence } from './theme-builder-persistence.svelte.ts';
import { EvaluationGate, type ThemeEvaluator } from './theme-draft-evaluation.ts';
import {
  contextId,
  editableState,
  isDirty,
  previewIsStale,
  type EditableState,
  type InputBufferEntry,
  type ThemeContextId,
  type ThemeDraft,
  type ThemeEnvelope,
} from './theme-draft-types.ts';
import {
  applyEdit,
  clearInput,
  commitInput,
  commitState,
  markSaved,
  resetState,
  restoreState,
  setInput,
  type DraftEdit,
  type ResetScope,
} from './theme-draft.ts';
import { createEnvelope } from './theme-envelope.ts';
import {
  beginGesture,
  canRedo,
  canUndo,
  commitTransaction,
  currentState,
  dismissLimitNotice,
  endGesture,
  redo,
  redoLabel,
  undo,
  undoLabel,
  type ThemeHistory,
  type TransactionKind,
} from './theme-history.ts';
import type { ThemeEntry, ThemeLibrary } from './theme-library.ts';
import { emptyLibrary } from './theme-library.ts';
import { overriddenPaths } from './theme-override-tree.ts';
import type { ThemePreviewContext } from './theme-preview-message.ts';
import { saveIndicator } from './theme-save-status.ts';
import type { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

export type Rejection = { message: string; path: string | null };
export type CommitOutcome =
  { ok: true; changed: boolean } | { ok: false; message: string; path: string | null };
export type ConflictState = { id: string; message: string };

export type ControllerDeps = {
  workbench: ThemeWorkbenchState;
  evaluator: ThemeEvaluator;
  /** `null` runs the builder in memory only. */
  persistence: ThemeBuilderPersistence | null;
};

const SAVE_DEBOUNCE_MS = 300;

export class ThemeBuilderCore {
  library = $state.raw<ThemeLibrary>(emptyLibrary());
  ready = $state(false);
  /** The text for the builder's polite live region. */
  announcement = $state('');
  /** The last rejected commit's reason, shown at the field that caused it. */
  rejection = $state.raw<Rejection | null>(null);
  /** Active-context CSS values of the last-valid revision, by CSS property. */
  draftValues = $state.raw<ReadonlyMap<string, string>>(new Map());
  /** Active-context CSS values of the shipped base, by CSS property. */
  shippedValues = $state.raw<ReadonlyMap<string, string>>(new Map());
  /** Why the last-valid revision could not be evaluated (a stored draft the runtime rejects). */
  evaluationError = $state.raw<string | null>(null);
  conflict = $state.raw<ConflictState | null>(null);

  protected readonly workbench: ThemeWorkbenchState;
  protected readonly evaluator: ThemeEvaluator;
  readonly persistence: ThemeBuilderPersistence | null;
  protected readonly gate = new EvaluationGate();
  readonly #shipped = new WeakMap<object, ThemeEnvelope>();
  #commitQueue: Promise<unknown> = Promise.resolve();
  #saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: ControllerDeps) {
    this.workbench = deps.workbench;
    this.evaluator = deps.evaluator;
    this.persistence = deps.persistence;
  }

  get active(): ThemeEntry | null {
    const id = this.library.activeId;
    return id === null ? null : (this.library.entries[id] ?? null);
  }

  get draft(): ThemeDraft | null {
    return this.active?.draft ?? null;
  }

  get history(): ThemeHistory | null {
    return this.active?.history ?? null;
  }

  get canUndo(): boolean {
    return this.history !== null && canUndo(this.history);
  }

  get canRedo(): boolean {
    return this.history !== null && canRedo(this.history);
  }

  get undoLabel(): string | null {
    return this.history === null ? null : undoLabel(this.history);
  }

  get redoLabel(): string | null {
    return this.history === null ? null : redoLabel(this.history);
  }

  /** True while partial input diverges from the committed revision the preview renders. */
  get previewIsStale(): boolean {
    return this.draft !== null && previewIsStale(this.draft);
  }

  /** Token paths with an override in the draft, for the Changed filter. */
  get changedPaths(): ReadonlySet<string> {
    const envelope = this.draft?.envelope;
    return envelope === undefined ? new Set() : overriddenPaths(envelope);
  }

  /** Token paths the author locked; presets and the foundation editors leave them alone. */
  get lockedPaths(): ReadonlySet<string> {
    return new Set(this.draft?.envelope.locked ?? []);
  }

  /** Lock or unlock one token as an undoable transaction. */
  setLocked(path: string, locked: boolean): Promise<CommitOutcome> {
    const name = this.nameOf(path);
    return this.commit({
      kind: 'edit',
      label: `${locked ? 'Lock' : 'Unlock'} ${name}`,
      edit: { kind: 'set-locked', path, locked },
    });
  }

  protected setEntry(entry: ThemeEntry): void {
    const id = entry.draft.envelope.id;
    this.library = { ...this.library, entries: { ...this.library.entries, [id]: entry } };
  }

  /** Mirror the active draft's persistence state into the toolbar. */
  protected syncStatus(): void {
    const draft = this.draft;
    if (draft === null) return;
    this.workbench.themeName = draft.envelope.name;
    this.workbench.previewIsLastValid = previewIsStale(draft);
    this.workbench.setPersistence(saveIndicator(draft, this.persistence?.failure ?? null));
  }

  // --- evaluation and the preview ---------------------------------------------------

  protected get context(): ThemeContextId {
    return contextId(this.workbench.context);
  }

  async #valuesFor(
    envelope: ThemeEnvelope,
    revision: number,
    context: ThemePreviewContext,
  ): Promise<
    | { ok: true; map: Map<string, string>; list: Array<{ name: string; value: string }> }
    | { ok: false; message: string; path: string | null }
  > {
    const id = contextId(context);
    const result = await this.gate.request(this.evaluator, envelope.id, envelope, revision, id);
    if (result === null) return { ok: false, message: 'Superseded by a newer edit.', path: null };
    if (!result.ok) {
      const first = result.diagnostics[0];
      return {
        ok: false,
        message: first?.message ?? 'The theme is invalid.',
        path: first?.path ?? null,
      };
    }
    const list = result.properties.map(({ name, value }) => ({ name, value }));
    return { ok: true, map: new Map(list.map(({ name, value }) => [name, value])), list };
  }

  /** Render the committed revision of `entry` for the active context. */
  protected async render(entry: ThemeEntry | null = this.active): Promise<void> {
    if (entry === null) return;
    const { envelope, revision } = entry.draft;
    const values = await this.#valuesFor(envelope, revision, this.workbench.context);
    if (this.active !== entry && this.active?.draft.envelope.id !== envelope.id) return;
    if (!values.ok) {
      if (values.path !== null || values.message !== 'Superseded by a newer edit.') {
        this.evaluationError = values.message;
      }
      return;
    }
    this.evaluationError = null;
    this.draftValues = values.map;
    this.workbench.setProperties(values.list);
    this.workbench.proposalPreview = false;
    this.syncStatus();
    void this.#renderShipped(envelope);
  }

  async #renderShipped(envelope: ThemeEnvelope): Promise<void> {
    const context = this.workbench.context;
    let base = this.#shipped.get(envelope.base);
    if (base === undefined) {
      base = createEnvelope('shipped', 'Cinder default', envelope.base);
      this.#shipped.set(envelope.base, base);
    }
    const result = await this.evaluator.evaluate(base, 0, contextId(context));
    if (!result.ok) return;
    if (contextId(this.workbench.context) !== contextId(context)) return;
    this.shippedValues = new Map(result.properties.map(({ name, value }) => [name, value]));
  }

  /** A context switch renders the draft's map for the new context in one preview revision. */
  async switchContext(context: ThemePreviewContext): Promise<void> {
    const entry = this.active;
    if (entry === null) {
      this.workbench.applyContext(context, []);
      return;
    }
    const values = await this.#valuesFor(entry.draft.envelope, entry.draft.revision, context);
    if (!values.ok) {
      // A superseded request is answered by the newer one; a real failure ends the request.
      if (values.path !== null || values.message !== 'Superseded by a newer edit.') {
        this.workbench.dropPendingContext(context);
      }
      return;
    }
    this.draftValues = values.map;
    this.workbench.proposalPreview = false;
    this.workbench.applyContext(context, values.list);
    this.announcement = `${context.colorMode} color mode, ${context.motion} motion`;
    void this.#renderShipped(entry.draft.envelope);
  }

  /**
   * Show an uncommitted editable state in the active context without committing it (a palette
   * proposal). `null` returns the preview to the committed revision. It never changes the
   * draft, history or storage; a real commit or a context switch ends it.
   */
  async previewState(state: EditableState | null): Promise<boolean> {
    const entry = this.active;
    if (entry === null) return false;
    if (state === null) {
      await this.render(entry);
      return true;
    }
    const { draft } = entry;
    const envelope = {
      ...draft.envelope,
      overrides: state.overrides,
      cssOverrides: state.cssOverrides,
    };
    const values = await this.#valuesFor(envelope, draft.revision, this.workbench.context);
    if (!values.ok) return false;
    this.workbench.setProperties(values.list);
    this.workbench.proposalPreview = true;
    return true;
  }

  // --- commits ------------------------------------------------------------------------

  #serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#commitQueue.then(work);
    this.#commitQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * Validate and commit one transaction. `edit` builds the next editable state from the
   * current draft; the runtime evaluates the candidate before anything changes, so a
   * rejected edit leaves draft, history, storage and preview exactly as they were.
   */
  commit(spec: {
    kind: TransactionKind;
    label: string;
    edit?: DraftEdit;
    state?: EditableState;
    inputKey?: string;
  }): Promise<CommitOutcome> {
    return this.#serialized(async () => {
      const entry = this.active;
      if (entry === null) return { ok: false, message: 'No theme is open.', path: null };
      const { draft } = entry;
      let result;
      if (spec.edit !== undefined) {
        result =
          spec.inputKey === undefined
            ? applyEdit(draft, spec.edit)
            : commitInput(draft, spec.inputKey, spec.edit);
      } else if (spec.state !== undefined) result = commitState(draft, spec.state);
      else return { ok: false, message: 'Nothing to commit.', path: null };
      if (!result.ok) {
        const message = `The theme exceeds the ${result.violations[0]?.code ?? 'data'} limit.`;
        this.rejection = { message, path: null };
        return { ok: false, message, path: null };
      }
      if (!result.changed) {
        if (spec.inputKey !== undefined)
          this.#replaceDraft(entry, clearInput(draft, spec.inputKey));
        return { ok: true, changed: false };
      }
      const history = commitTransaction(
        entry.history,
        spec.kind,
        spec.label,
        editableState(result.draft.envelope),
      );
      return this.#install(entry, result.draft, history, spec.label);
    });
  }

  async #install(
    entry: ThemeEntry,
    draft: ThemeDraft,
    history: ThemeHistory,
    label: string,
  ): Promise<CommitOutcome> {
    const values = await this.#valuesFor(draft.envelope, draft.revision, this.workbench.context);
    if (!values.ok) {
      this.rejection = { message: values.message, path: values.path };
      return { ok: false, message: values.message, path: values.path };
    }
    this.rejection = null;
    this.evaluationError = null;
    this.setEntry({ ...entry, draft, history });
    this.draftValues = values.map;
    this.workbench.setProperties(values.list);
    this.workbench.proposalPreview = false;
    this.announcement = label;
    this.syncStatus();
    this.persistSoon(0);
    return { ok: true, changed: true };
  }

  #replaceDraft(entry: ThemeEntry, draft: ThemeDraft): void {
    this.setEntry({ ...entry, draft });
    this.syncStatus();
    this.persistSoon(SAVE_DEBOUNCE_MS);
  }

  // --- partial input ----------------------------------------------------------------------

  /** Keep partial text apart from the committed revision; the preview keeps the last valid. */
  setInputBuffer(key: string, entry: InputBufferEntry): void {
    const active = this.active;
    if (active === null) return;
    this.#replaceDraft(active, setInput(active.draft, key, entry));
  }

  clearInputBuffer(key: string): void {
    const active = this.active;
    if (active === null) return;
    this.#replaceDraft(active, clearInput(active.draft, key));
  }

  // --- history ------------------------------------------------------------------------------

  beginGesture(kind: TransactionKind, label: string): void {
    const active = this.active;
    if (active !== null)
      this.setEntry({ ...active, history: beginGesture(active.history, kind, label) });
  }

  endGesture(): void {
    const active = this.active;
    if (active !== null) this.setEntry({ ...active, history: endGesture(active.history) });
  }

  dismissHistoryNotice(): void {
    const active = this.active;
    if (active !== null) this.setEntry({ ...active, history: dismissLimitNotice(active.history) });
  }

  #travel(direction: 'undo' | 'redo'): Promise<CommitOutcome> {
    return this.#serialized(async () => {
      const entry = this.active;
      if (entry === null) return { ok: false, message: 'No theme is open.', path: null };
      const before = direction === 'undo' ? this.undoLabel : this.redoLabel;
      const history = direction === 'undo' ? undo(entry.history) : redo(entry.history);
      if (history.cursor === entry.history.cursor) return { ok: true, changed: false };
      const draft = restoreState(entry.draft, currentState(history));
      const verb = direction === 'undo' ? 'Undid' : 'Redid';
      return this.#install(entry, draft, history, `${verb} ${before ?? 'edit'}`);
    });
  }

  undo(): Promise<CommitOutcome> {
    return this.#travel('undo');
  }

  redo(): Promise<CommitOutcome> {
    return this.#travel('redo');
  }

  /** Reset overrides at one scope as a single undoable transaction. */
  reset(scope: ResetScope, label: string): Promise<CommitOutcome> {
    const draft = this.draft;
    if (draft === null)
      return Promise.resolve({ ok: false, message: 'No theme is open.', path: null });
    return this.commit({
      kind: 'reset',
      label,
      state: resetState(editableState(draft.envelope), scope),
    });
  }

  /** The catalogue row's friendly name, for announcements. */
  protected nameOf(path: string): string {
    return catalogueRowByPath(path)?.name ?? path;
  }

  // --- autosave -----------------------------------------------------------------------------

  protected persistSoon(delay: number, id: string | null = this.library.activeId): void {
    if (this.persistence === null || id === null) return;
    clearTimeout(this.#saveTimer);
    if (delay === 0) void this.persistNow(id);
    else this.#saveTimer = setTimeout(() => void this.persistNow(id), delay);
  }

  /** Save one theme with compare-and-set; edits made while the write ran save again after it. */
  protected async persistNow(id: string): Promise<void> {
    const persistence = this.persistence;
    if (persistence === null) return;
    await persistence.save(
      () => this.library.entries[id] ?? null,
      (result, saved) => {
        if (result.ok) {
          const current = this.library.entries[id];
          if (current === undefined) return;
          const draft = markSaved(current.draft, saved.draft);
          this.setEntry({ ...current, draft });
          if (isDirty(draft)) this.persistSoon(SAVE_DEBOUNCE_MS, id);
        } else if (result.failure.kind === 'conflict') {
          this.onSaveConflict(id, result.failure.storedRevision ?? null);
        }
      },
    );
    this.syncStatus();
  }

  /** A write found a newer stored revision; the cross-tab layer decides what to offer. */
  protected onSaveConflict(_id: string, _storedRevision: number | null): void {}

  /** Flush a pending debounced save, then wait for the queue. Tests and unload use it. */
  async flush(): Promise<void> {
    clearTimeout(this.#saveTimer);
    const id = this.library.activeId;
    if (id !== null && this.persistence !== null) await this.persistNow(id);
    await this.persistence?.settled();
  }
}
