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
  firstFoundationPath,
  NO_FILTERS,
  type CatalogueFilters,
  type CatalogueGroupId,
} from './theme-builder-catalogue.ts';
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
  context = $state<ThemePreviewContext>({ colorMode: 'light', motion: 'default' });
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
  /**
   * Set by the draft controller: a context change is evaluated against the draft there and
   * lands through `applyContext`, so the preview never shows one context's map under another.
   */
  contextChangeHandler: ((context: ThemePreviewContext) => void) | null = null;
  saveStatus = $state<SaveStatus>('saved');
  /** Actionable copy for a storage failure; `null` while persistence is healthy. */
  storageNotice = $state.raw<Pick<SaveIndicator, 'notice' | 'actions'> | null>(null);
  findingsCount = $state(0);
  preview = $state.raw<PreviewStatus>({ phase: 'loading', appliedRevision: null, error: null });

  /** Per-pane scroll offsets, kept so a pane that was hidden comes back where it was. */
  readonly scrollByPane: Record<WorkbenchPane, number> = { edit: 0, preview: 0, checks: 0 };
  /** Scroll offsets of the bounded scroll regions inside the panes, by `data-scroll-region`. */
  readonly scrollByRegion: Record<string, number> = {};

  selectToken(path: string | null): void {
    this.selectedTokenPath = path;
  }

  /** A scene change asks the preview for a new revision and leaves the selected token alone. */
  selectScene(sceneId: string): void {
    if (themePreviewSceneById(sceneId) === undefined || sceneId === this.sceneId) return;
    this.sceneId = sceneId;
    this.revision += 1;
  }

  /** A context switch is not an edit: it keeps the selection and the properties. */
  setContext(context: ThemePreviewContext): void {
    if (context.colorMode === this.context.colorMode && context.motion === this.context.motion) {
      return;
    }
    if (this.contextChangeHandler !== null) {
      this.contextChangeHandler(context);
      return;
    }
    this.context = context;
    this.revision += 1;
  }

  /** Land a context switch together with that context's committed map: one preview revision. */
  applyContext(context: ThemePreviewContext, properties: readonly ThemePreviewProperty[]): void {
    this.context = context;
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
