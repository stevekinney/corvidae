import type { ClearScope } from '../components/terminal/terminal-engine-adapter.ts';
import { scheduleFitOnNextFrame, type FitScheduler } from '../components/terminal/terminal-fit.ts';
import { buildTextExport, textSaver, type TextExport } from './export.ts';
import {
  RETAINED_READ_CEILING,
  SEARCH_TEXT_BYTE_LIMIT,
  SNAPSHOT_BYTE_LIMIT,
  type InspectionEvent,
  type InspectionEventListener,
  type InspectionSource,
} from './inspection-types.ts';
import { createSearch, type SearchView } from './search.ts';
import { captureSnapshot, type Snapshot } from './snapshot.ts';

export type SnapshotView = {
  snapshot: Snapshot;
  /** Output arrived, or the buffer was cleared, since the capture. */
  stale: boolean;
  /** The session it was read from was replaced. */
  replaced: boolean;
  /** Whether Refresh can recapture: the same live session, with an engine. */
  refreshable: boolean;
  /** Whether a listed address can be activated now. */
  linksActive: boolean;
};

export type ExportView = {
  result: TextExport;
};

export type InspectionView = {
  /** An engine is mounted and readable, so inspection can act. */
  available: boolean;
  searchOpen: boolean;
  query: string;
  search: SearchView;
  /** The accessible output dialog is open. */
  snapshotOpen: boolean;
  /** Held from capture until the dialog has fully closed, then released. */
  snapshot: SnapshotView | undefined;
  exportOpen: boolean;
  export: ExportView | undefined;
  /** The host enabled links, so the snapshot lists addresses. */
  linksEnabled: boolean;
};

export type InspectionOptions = {
  readSource: () => InspectionSource | undefined;
  /** The host's link handler, when it opted in. */
  readActivateLink: () => ((url: string) => void) | undefined;
  readOnEvent: () => InspectionEventListener | undefined;
  /** Say something politely. Never given output, only fixed words and counts. */
  announce: (message: string) => void;
  /** Coalesces re-searching while output arrives. */
  schedule?: FitScheduler;
};

export type Inspection = {
  readonly view: InspectionView;
  subscribe(listener: () => void): () => void;
  /** The mounted source changed or went away. */
  sourceChanged(): void;
  /** The retained content changed. */
  contentChanged(): void;
  openSearch(): void;
  closeSearch(): void;
  setQuery(query: string): void;
  next(): void;
  previous(): void;
  openSnapshot(): void;
  refreshSnapshot(): void;
  closeSnapshot(): void;
  /** The dialog finished closing: drop the captured text. */
  releaseSnapshot(): void;
  activateLink(url: string): void;
  prepareExport(): void;
  downloadExport(): void;
  cancelExport(): void;
  releaseExport(): void;
  clear(scope: ClearScope): void;
  dispose(): void;
};

const CLEAR_ANNOUNCEMENT: Record<ClearScope, string> = {
  visible: 'Terminal screen cleared',
  retained: 'Terminal history cleared',
  reset: 'Terminal reset',
};

export function createInspection(options: InspectionOptions): Inspection {
  const schedule = options.schedule ?? scheduleFitOnNextFrame;
  const listeners = new Set<() => void>();
  const search = createSearch();
  let searchOpen = false;
  let query = '';
  let snapshot: Snapshot | undefined;
  let snapshotOpen = false;
  let stale = false;
  let exported: TextExport | undefined;
  let exportOpen = false;
  let cancelPending: (() => void) | undefined;
  let disposed = false;
  let view: InspectionView;

  /** Host hooks run behind a guard: whatever they do, inspection and the session carry on. */
  function emit(event: InspectionEvent): void {
    try {
      options.readOnEvent()?.(event);
    } catch {
      // A failing observer must not affect the session, so its failure is dropped.
    }
  }

  function currentSource(): InspectionSource | undefined {
    return disposed ? undefined : options.readSource();
  }

  function snapshotView(): SnapshotView | undefined {
    if (snapshot === undefined) return undefined;
    const source = currentSource();
    const sameSession = source !== undefined && source.generation === snapshot.generation;
    return {
      snapshot,
      stale,
      replaced: !sameSession,
      refreshable: sameSession,
      linksActive: sameSession && options.readActivateLink() !== undefined,
    };
  }

  function compute(): InspectionView {
    return {
      available: currentSource() !== undefined,
      searchOpen,
      query,
      search: search.view,
      snapshotOpen,
      snapshot: snapshotView(),
      exportOpen,
      export: exported === undefined ? undefined : { result: exported },
      linksEnabled: options.readActivateLink() !== undefined,
    };
  }

  function publish(): void {
    view = compute();
    for (const listener of listeners) listener();
  }
  view = compute();

  function researchNow(): void {
    cancelPending?.();
    cancelPending = undefined;
    const source = currentSource();
    const projection = source?.readProjection(SEARCH_TEXT_BYTE_LIMIT);
    if (projection === undefined) search.makeUnavailable();
    else search.update(projection.text, projection.truncated);
  }

  function scheduleResearch(): void {
    if (cancelPending !== undefined) return;
    cancelPending = schedule(() => {
      cancelPending = undefined;
      if (!searchOpen || disposed) return;
      researchNow();
      publish();
    });
  }

  function cancelResearch(): void {
    cancelPending?.();
    cancelPending = undefined;
  }

  function reportSearch(): void {
    const found = search.view;
    emit({
      kind: 'search',
      matches: found.count,
      capped: found.capped,
      truncated: found.truncated,
    });
  }

  function step(direction: 'next' | 'previous'): void {
    if (!searchOpen) return;
    // Output may have arrived since the last search; step through what the reader can see now.
    if (cancelPending !== undefined) researchNow();
    if (direction === 'next') search.next();
    else search.previous();
    const found = search.view;
    emit({ kind: 'navigate', direction, wrapped: found.wrapped, matches: found.count });
    publish();
  }

  function captureNow(source: InspectionSource): boolean {
    const projection = source.readProjection(SNAPSHOT_BYTE_LIMIT);
    if (projection === undefined) return false;
    snapshot = captureSnapshot(projection, source.generation);
    stale = false;
    return true;
  }

  return {
    get view() {
      return view;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sourceChanged() {
      if (searchOpen) {
        researchNow();
      }
      publish();
    },
    contentChanged() {
      const becameStale = snapshot !== undefined && !stale;
      if (snapshot !== undefined) stale = true;
      if (searchOpen) scheduleResearch();
      // Every chunk after the first changes nothing the view shows, so it is not republished.
      if (becameStale) publish();
    },
    openSearch() {
      if (currentSource() === undefined) return;
      searchOpen = true;
      researchNow();
      publish();
    },
    closeSearch() {
      searchOpen = false;
      cancelResearch();
      publish();
    },
    setQuery(next) {
      query = next;
      search.setQuery(next);
      researchNow();
      reportSearch();
      publish();
    },
    next: () => step('next'),
    previous: () => step('previous'),
    openSnapshot() {
      const source = currentSource();
      if (source === undefined || !captureNow(source)) return;
      snapshotOpen = true;
      const taken = snapshot!;
      emit({
        kind: 'snapshot',
        action: 'open',
        bytes: taken.bytes,
        truncated: taken.truncated,
        stale: false,
      });
      options.announce(taken.truncated ? 'Terminal snapshot truncated' : 'Terminal snapshot ready');
      publish();
    },
    refreshSnapshot() {
      const source = currentSource();
      if (
        snapshot === undefined ||
        source === undefined ||
        source.generation !== snapshot.generation ||
        !captureNow(source)
      ) {
        return;
      }
      const taken = snapshot;
      emit({
        kind: 'snapshot',
        action: 'refresh',
        bytes: taken.bytes,
        truncated: taken.truncated,
        stale: false,
      });
      options.announce('Terminal snapshot refreshed');
      publish();
    },
    closeSnapshot() {
      if (!snapshotOpen) return;
      snapshotOpen = false;
      emit({
        kind: 'snapshot',
        action: 'close',
        bytes: snapshot?.bytes ?? 0,
        truncated: snapshot?.truncated ?? false,
        stale,
      });
      publish();
    },
    releaseSnapshot() {
      if (snapshotOpen) return;
      snapshot = undefined;
      stale = false;
      publish();
    },
    activateLink(url) {
      const shown = snapshotView();
      const activate = options.readActivateLink();
      if (
        shown === undefined ||
        !shown.linksActive ||
        activate === undefined ||
        !shown.snapshot.links.includes(url)
      ) {
        emit({ kind: 'link', action: 'refuse' });
        return;
      }
      emit({ kind: 'link', action: 'activate' });
      try {
        activate(url);
      } catch {
        // The host's handler failing is the host's; the session and the dialog are unaffected.
      }
    },
    prepareExport() {
      const projection = currentSource()?.readProjection(RETAINED_READ_CEILING);
      if (projection === undefined) return;
      exported = buildTextExport(projection);
      exportOpen = true;
      emit({
        kind: 'export',
        action: 'prepare',
        exportedBytes: exported.exportedBytes,
        retainedBytes: exported.retainedBytes,
        truncated: exported.truncated,
      });
      options.announce(
        exported.truncated ? 'Terminal snapshot truncated' : 'Terminal snapshot ready',
      );
      publish();
    },
    downloadExport() {
      const prepared = exported;
      if (!exportOpen || prepared === undefined) return;
      exportOpen = false;
      emit({
        kind: 'export',
        action: 'download',
        exportedBytes: prepared.exportedBytes,
        retainedBytes: prepared.retainedBytes,
        truncated: prepared.truncated,
      });
      publish();
      textSaver.save(prepared.text);
    },
    cancelExport() {
      const prepared = exported;
      if (!exportOpen || prepared === undefined) return;
      exportOpen = false;
      emit({
        kind: 'export',
        action: 'cancel',
        exportedBytes: prepared.exportedBytes,
        retainedBytes: prepared.retainedBytes,
        truncated: prepared.truncated,
      });
      publish();
    },
    releaseExport() {
      if (exportOpen) return;
      exported = undefined;
      publish();
    },
    clear(scope) {
      const source = currentSource();
      if (source === undefined) return;
      source.clear(scope, () => {
        emit({ kind: 'clear', scope });
        options.announce(CLEAR_ANNOUNCEMENT[scope]);
        if (snapshot !== undefined) stale = true;
        if (searchOpen) researchNow();
        publish();
      });
    },
    dispose() {
      disposed = true;
      cancelResearch();
      snapshot = undefined;
      exported = undefined;
      listeners.clear();
    },
  };
}
