/**
 * The workbench's shared state: the seam the draft/history model (COR-490) and the token
 * editors (COR-489, COR-263, COR-488) plug into.
 *
 * What the shell owns is deliberately small: which token is selected, which concrete
 * context is active, which preview scene is showing, the preview revision, and the
 * mobile pane. Everything else a later issue adds (draft values, history, findings)
 * reaches the shell through `setProperties` (the committed variable map the preview
 * renders) and the status fields. Selecting a scene, switching a pane, or changing the
 * context never touches `selectedTokenPath`; only `selectToken` does.
 */

import {
  catalogueRowByPath,
  firstFoundationPath,
  NO_FILTERS,
  type CatalogueFilters,
  type CatalogueGroupId,
} from './theme-builder-catalogue.ts';
import type { ExportReadiness } from './theme-check-types.ts';
import type { ThemePreviewContext, ThemePreviewProperty } from './theme-preview-message.ts';
import { DEFAULT_THEME_PREVIEW_SCENE_ID, themePreviewSceneById } from './theme-preview-scenes.ts';
import type { SaveIndicator } from './theme-save-status.ts';

export type WorkbenchPane = 'edit' | 'preview' | 'checks';
export const WORKBENCH_PANES: readonly WorkbenchPane[] = ['edit', 'preview', 'checks'];

export type PreviewPhase = 'loading' | 'ready' | 'error';

export type PreviewStatus = {
  phase: PreviewPhase;
  /** The revision the frame last acknowledged, or `null` before any. */
  appliedRevision: number | null;
  /** The named error of the latest rejected message; the last-valid preview stays. */
  error: { code: string; message: string } | null;
};

export type SaveStatus = 'saved' | 'unsaved';

export class ThemeWorkbenchState {
  themeName = $state('Cinder default');
  selectedTokenPath = $state<string | null>(firstFoundationPath());
  /** The context the preview shows: the last one whose map has landed. */
  context = $state<ThemePreviewContext>({ colorMode: 'light', motion: 'default' });
  /**
   * A context change that was asked for and has not landed yet. The runtime evaluates off the
   * main thread, so a change lands a moment after it is made; the controls read the
   * requested context so a second change builds on the first instead of undoing it.
   */
  pendingContext = $state.raw<ThemePreviewContext | null>(null);
  sceneId = $state(DEFAULT_THEME_PREVIEW_SCENE_ID);
  /** The latest revision requested of the preview; it only ever grows. */
  revision = $state(0);
  /** The committed variable map the preview renders. */
  properties = $state.raw<readonly ThemePreviewProperty[]>([]);
  pane = $state<WorkbenchPane>('edit');
  groupId = $state<CatalogueGroupId>('foundations');
  filter = $state('');
  /** The changed, alias, and recipe filters; each active one must hold. */
  filters = $state.raw<CatalogueFilters>(NO_FILTERS);
  /** True while the invalid-input buffer diverges from the last-valid revision (COR-490). */
  previewIsLastValid = $state(false);
  /** True while the preview shows an uncommitted palette proposal (COR-263). */
  proposalPreview = $state(false);
  /**
   * Set by the draft controller: a context change is evaluated against the draft there and
   * lands through `applyContext`, so the preview never shows one context's map under another.
   */
  contextChangeHandler: ((context: ThemePreviewContext) => void) | null = null;
  saveStatus = $state<SaveStatus>('saved');
  /** Actionable copy for a storage failure; `null` while persistence is healthy. */
  storageNotice = $state.raw<Pick<SaveIndicator, 'notice' | 'actions'> | null>(null);
  /** Outstanding findings: accessibility errors, items to review and invalid source. */
  findingsCount = $state(0);
  /** What the checks say about exporting the committed revision (COR-259). */
  exportReadiness = $state<ExportReadiness>('checking');
  preview = $state.raw<PreviewStatus>({ phase: 'loading', appliedRevision: null, error: null });

  /** Per-pane scroll offsets, kept so a pane that was hidden comes back where it was. */
  readonly scrollByPane: Record<WorkbenchPane, number> = { edit: 0, preview: 0, checks: 0 };
  /** Scroll offsets of the bounded scroll regions inside the panes, by `data-scroll-region`. */
  readonly scrollByRegion: Record<string, number> = {};

  /** Whether the Source and dependencies disclosure is open; it stays open as the selection moves. */
  sourceDisclosureOpen = $state(false);
  /** The token a followed dependent or recipe input was reached from (COR-488), or `null`. */
  originTokenPath = $state<string | null>(null);

  selectToken(path: string | null): void {
    this.selectedTokenPath = path;
    this.originTokenPath = null;
  }

  /**
   * Select a dependent or recipe input through the catalogue, remembering where the author
   * came from. A chain of follows returns to the first token, the originating one. The
   * concrete context is not touched.
   */
  followToken(path: string, from: string): void {
    const row = catalogueRowByPath(path);
    if (row === undefined) return;
    this.originTokenPath ??= from;
    this.selectedTokenPath = path;
    this.groupId = row.group;
  }

  /** Back to originating token: select it again and forget the trail. */
  returnToOrigin(): string | null {
    const origin = this.originTokenPath;
    if (origin === null) return null;
    this.originTokenPath = null;
    this.selectedTokenPath = origin;
    const row = catalogueRowByPath(origin);
    if (row !== undefined) this.groupId = row.group;
    return origin;
  }

  /** A scene change asks the preview for a new revision and leaves the selected token alone. */
  selectScene(sceneId: string): void {
    if (themePreviewSceneById(sceneId) === undefined || sceneId === this.sceneId) return;
    this.sceneId = sceneId;
    this.revision += 1;
  }

  /** The context the controls show: the pending change if there is one, else the applied one. */
  get requestedContext(): ThemePreviewContext {
    return this.pendingContext ?? this.context;
  }

  /** A context switch is not an edit: it keeps the selection and the properties. */
  setContext(context: ThemePreviewContext): void {
    const requested = this.requestedContext;
    if (context.colorMode === requested.colorMode && context.motion === requested.motion) {
      return;
    }
    if (this.contextChangeHandler !== null) {
      this.pendingContext = context;
      this.contextChangeHandler(context);
      return;
    }
    this.context = context;
    this.revision += 1;
  }

  /** The controller could not land the requested context; the controls show the applied one. */
  dropPendingContext(context: ThemePreviewContext): void {
    const pending = this.pendingContext;
    if (pending?.colorMode === context.colorMode && pending.motion === context.motion) {
      this.pendingContext = null;
    }
  }

  /** Land a context switch together with that context's committed map: one preview revision. */
  applyContext(context: ThemePreviewContext, properties: readonly ThemePreviewProperty[]): void {
    this.context = context;
    this.dropPendingContext(context);
    this.properties = properties;
    this.revision += 1;
  }

  /** Replace the committed variable map; the preview re-renders from the new revision. */
  setProperties(properties: readonly ThemePreviewProperty[]): void {
    this.properties = properties;
    this.revision += 1;
  }

  /** Mirror the draft's persistence state (COR-490) into the toolbar's save status. */
  setPersistence(indicator: SaveIndicator): void {
    this.saveStatus = indicator.label === 'Saved locally' ? 'saved' : 'unsaved';
    this.storageNotice =
      indicator.notice === null ? null : { notice: indicator.notice, actions: indicator.actions };
  }

  /** Mirror the checks panel's result into the toolbar. */
  setChecks(summary: { findings: number; readiness: ExportReadiness }): void {
    this.findingsCount = summary.findings;
    this.exportReadiness = summary.readiness;
  }

  setPane(pane: WorkbenchPane): void {
    this.pane = pane;
  }

  selectGroup(groupId: CatalogueGroupId): void {
    this.groupId = groupId;
  }

  setFilter(filter: string): void {
    this.filter = filter;
  }

  setFilters(filters: CatalogueFilters): void {
    this.filters = filters;
  }

  noteFrameLoading(): void {
    this.preview = { phase: 'loading', appliedRevision: null, error: null };
  }

  noteApplied(revision: number): void {
    this.preview = { phase: 'ready', appliedRevision: revision, error: null };
  }

  /** A rejection keeps the last-valid preview and names the error. */
  noteRejected(error: { code: string; message: string }): void {
    this.preview = { ...this.preview, phase: 'error', error };
  }

  /** True while the frame has not yet acknowledged the latest revision. */
  get previewIsStale(): boolean {
    return this.preview.appliedRevision !== this.revision;
  }
}
