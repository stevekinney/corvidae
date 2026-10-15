import type { ClearScope } from '../components/terminal/terminal-engine-adapter.ts';
import { buildTextExport, textSaver } from './export.ts';
import {
  RETAINED_READ_CEILING,
  SEARCH_REFRESH_DELAY_MS,
  SEARCH_TEXT_BYTE_LIMIT,
  SEARCH_TYPING_DELAY_MS,
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

export type InspectionView = {
  /** An engine is mounted and readable, so inspection can act. */
  available: boolean;
  searchOpen: boolean;
  query: string;
  search: SearchView;
  /** The export dialog (the snapshot, with Download) is open. */
  snapshotOpen: boolean;
  /** Held from capture until the dialog has fully closed, then released. */
  snapshot: SnapshotView | undefined;
  /** The last step could not select its match in the terminal. */
  selectionFailed: boolean;
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
  /** Starts a timer for `delay` milliseconds and returns what cancels it. */
  timer?: Timer;
};

export type Timer = (callback: () => void, delay: number) => () => void;

const startTimeout: Timer = (callback, delay) => {
  const handle = setTimeout(callback, delay);
  return () => clearTimeout(handle);
};

/** The clock the search waits on. Replaceable, so a test can pass time without waiting for it. */
export const inspectionTimer: { start: Timer } = { start: startTimeout };

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
  /** Recapture the same live session. `false`, announcing it, when it cannot be recaptured. */
  refreshSnapshot(): boolean;
  closeSnapshot(): void;
  /** The dialog finished closing: drop the captured text. */
  releaseSnapshot(): void;
  activateLink(url: string): void;
  /** Save the plain-text file that was taken with the snapshot, exactly as it was described. */
  downloadExport(): void;
  clear(scope: ClearScope): void;
  dispose(): void;
};

const CLEAR_ANNOUNCEMENT: Record<ClearScope, string> = {
  visible: 'Terminal screen cleared',
  retained: 'Terminal history cleared',
  reset: 'Terminal reset',
};

export function createInspection(options: InspectionOptions): Inspection {
  const timer = options.timer ?? ((callback, delay) => inspectionTimer.start(callback, delay));
  const listeners = new Set<() => void>();
  const search = createSearch();
  let searchOpen = false;
  let query = '';
  let snapshot: Snapshot | undefined;
  let snapshotOpen = false;
  let stale = false;
  let cancelPending: (() => void) | undefined;
  let cancelTyping: (() => void) | undefined;
  let selectionFailed = false;
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
      selectionFailed,
      linksEnabled: options.readActivateLink() !== undefined,
    };
  }

  function publish(): void {
    view = compute();
    for (const listener of listeners) listener();
  }
  view = compute();

  /** Keep the terminal's selection on the active match, or drop it when there is none. */
  function syncSelection(select: boolean): void {
    const source = currentSource();
    const match = search.view.match;
    if (source !== undefined && searchOpen && match !== undefined) {
      if (select) selectionFailed = !source.selectMatch(match, SEARCH_TEXT_BYTE_LIMIT);
      return;
    }
    selectionFailed = false;
    source?.clearMatchSelection();
  }

  function researchNow(): void {
    cancelPending?.();
    cancelPending = undefined;
    const source = currentSource();
    // With no query there is nothing to look for, so the retained output is not read at all.
    const projection =
      query === ''
        ? { text: '', truncated: false }
        : source?.readProjection(SEARCH_TEXT_BYTE_LIMIT);
    if (projection === undefined) search.makeUnavailable();
    else search.update(projection.text, projection.truncated);
    syncSelection(false);
  }

  function scheduleResearch(): void {
    if (cancelPending !== undefined) return;
    cancelPending = timer(() => {
      cancelPending = undefined;
      if (!searchOpen || disposed) return;
      researchNow();
      publish();
    }, SEARCH_REFRESH_DELAY_MS);
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

  /** Search the query as it stands now, without waiting for the pause. */
  function applyQuery(): void {
    cancelTyping?.();
    cancelTyping = undefined;
    search.setQuery(query);
    researchNow();
    syncSelection(false);
    reportSearch();
  }

  function step(direction: 'next' | 'previous'): void {
    if (!searchOpen) return;
    if (cancelTyping !== undefined) applyQuery();
    // Output may have arrived since the last search; step through what the reader can see now.
    if (cancelPending !== undefined) researchNow();
    if (direction === 'next') search.next();
    else search.previous();
    syncSelection(true);
    const found = search.view;
    emit({ kind: 'navigate', direction, wrapped: found.wrapped, matches: found.count });
    publish();
  }

  function captureNow(source: InspectionSource): boolean {
    const projection = source.readProjection(SNAPSHOT_BYTE_LIMIT);
    const retained = source.readProjection(RETAINED_READ_CEILING);
    if (projection === undefined || retained === undefined) return false;
    snapshot = captureSnapshot(projection, source.generation, buildTextExport(retained));
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
      cancelTyping?.();
      cancelTyping = undefined;
      syncSelection(false);
      // Nothing of the search outlives it: not the text, the matches, or the query.
      search.release();
      query = '';
      publish();
    },
    setQuery(next) {
      query = next;
      cancelTyping?.();
      cancelTyping = timer(() => {
        applyQuery();
        publish();
      }, SEARCH_TYPING_DELAY_MS);
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
      // The download is part of what opens, so its truncation is announced with the snapshot's.
      options.announce(
        taken.truncated || taken.export.truncated
          ? 'Terminal snapshot truncated'
          : 'Terminal snapshot ready',
      );
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
        options.announce('Terminal snapshot stale');
        return false;
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
      return true;
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
    downloadExport() {
      const prepared = snapshot?.export;
      if (!snapshotOpen || prepared === undefined) return;
      emit({
        kind: 'export',
        action: 'download',
        exportedBytes: prepared.exportedBytes,
        retainedBytes: prepared.retainedBytes,
        truncated: prepared.truncated,
      });
      textSaver.save(prepared.text);
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
      cancelTyping?.();
      snapshot = undefined;
      listeners.clear();
    },
  };
}
