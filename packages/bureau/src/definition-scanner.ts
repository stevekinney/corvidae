/**
 * The scan-and-diff layer between a {@link DefinitionSource} and a catalog (COR-1702). The source
 * hands over bytes and hashes; this layer evaluates each definition into the catalog's entry,
 * reuses an entry whose bytes and deployment revision did not change, compares the scan with the
 * previous one, and tells listeners what was added, changed, or removed. It has no file-system
 * imports, so the agent and workflow catalogs, and Bureau's main entry, stay free of Node's `fs`.
 *
 * One single-flight loop rescans until nothing is dirty: a source's `watch` report, a `refresh()`,
 * and a write-through reload all just mark the set dirty, and because a rescan is idempotent it
 * makes no difference which of them arrived first or how many.
 *
 * @module definition-scanner
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';

import type { DefinitionEntry, DefinitionSource } from './sources/definition-source';

/** What changed in one rescan, by identifier. */
export interface DefinitionChange {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
}

/** What every entry a catalog holds carries, so a rescan can tell whether a definition changed. */
export interface ScannedEntry {
  readonly id: string;
  /** The SHA-256 of the definition's bytes, or `undefined` when they could not be read. */
  readonly hash: string | undefined;
  /** The deployment state the entry was evaluated against; a different value re-evaluates it. */
  readonly revision: number;
}

export interface DefinitionScannerOptions<TEntry extends ScannedEntry> {
  readonly source: DefinitionSource;
  /** What the source holds, for diagnostics: `agent directory`. */
  readonly label: string;
  readonly runtime: RuntimeServices;
  /** Where watcher and scan failures are reported. */
  readonly diagnose: (message: string, cause: unknown) => void;
  /** The current deployment revision; an entry evaluated against another is evaluated again. */
  readonly revision: () => number;
  /** Turn one definition's bytes into an entry. */
  readonly evaluate: (id: string, bytes: Uint8Array, hash: string, revision: number) => TEntry;
  /** The entry for a definition larger than the source's limit. */
  readonly tooLarge: (id: string, size: number, revision: number) => TEntry;
  /** The entry for a definition that could not be read. */
  readonly unreadable: (id: string, error: unknown, revision: number) => TEntry;
  /**
   * Runs after a scan has loaded every entry and before the scan's entries replace the previous
   * ones, so before `refresh()` resolves and before any listener is told (COR-1584). It resolves
   * the entries to keep, which the scan then compares with the previous ones: a catalog whose
   * entries need an async step (a persisted revision) completes them here. It must not reject; a
   * rejection fails the scan, which keeps the previous entries. `previous` is the entries the last
   * scan kept. The scan waits for it: a step that never settles stalls the scan, every `refresh()`
   * behind it, and `close()`.
   */
  readonly settle?:
    | ((
        loaded: ReadonlyMap<string, TEntry>,
        previous: ReadonlyMap<string, TEntry>,
      ) => Promise<ReadonlyMap<string, TEntry>>)
    | undefined;
  /**
   * Called after every rescan, whether or not it found a change, once the listeners have been
   * told. A catalog whose work on a change can fail uses it to try again on the next rescan.
   */
  readonly afterScan?: (() => void) | undefined;
  /** Whether a rescan found `after` to be a different definition state than `before`. */
  readonly sameSignature: (before: TEntry, after: TEntry) => boolean;
}

export interface DefinitionScanner<TEntry extends ScannedEntry> {
  /** Every definition the source holds, by identifier, as of the last scan. */
  readonly entries: () => ReadonlyMap<string, TEntry>;
  /** Rescan the source; resolves once the entries reflect a scan that began after this call. */
  readonly refresh: () => Promise<void>;
  /** Called after every rescan that added, changed, or removed an entry. Returns its unsubscribe. */
  readonly onChange: (listener: (change: DefinitionChange) => void) => () => void;
  /** Stop listening to the source and wait for a scan in flight. */
  readonly close: () => Promise<void>;
}

export function createDefinitionScanner<TEntry extends ScannedEntry>(
  options: DefinitionScannerOptions<TEntry>,
): DefinitionScanner<TEntry> {
  const { source } = options;
  source.attach?.({ runtime: options.runtime, diagnose: options.diagnose });
  let entries = new Map<string, TEntry>();
  const listeners = new Set<(change: DefinitionChange) => void>();

  function entryOf(raw: DefinitionEntry, revision: number): TEntry {
    const { id } = raw;
    try {
      if (raw.problem?.code === 'file-too-large') {
        return options.tooLarge(id, raw.problem.size ?? 0, revision);
      }
      if (raw.problem !== undefined) {
        return options.unreadable(id, new Error(raw.problem.message), revision);
      }
      const previous = entries.get(id);
      if (previous?.hash === raw.hash && previous.revision === revision) return previous;
      return options.evaluate(id, raw.bytes, raw.hash, revision);
    } catch (error) {
      return options.unreadable(id, error, revision);
    }
  }

  async function scanOnce(): Promise<void> {
    const loaded = await source.load();
    const revision = options.revision();
    const scanned = new Map<string, TEntry>();
    for (const raw of loaded) {
      scanned.set(raw.id, entryOf(raw, revision));
    }
    const next = options.settle === undefined ? scanned : await options.settle(scanned, entries);
    const added: string[] = [];
    const changed: string[] = [];
    const removed: string[] = [];
    for (const [id, entry] of next) {
      const before = entries.get(id);
      if (before === undefined) added.push(id);
      else if (!options.sameSignature(before, entry)) changed.push(id);
    }
    for (const id of entries.keys()) if (!next.has(id)) removed.push(id);
    entries = new Map(next);
    if (added.length + changed.length + removed.length > 0) {
      for (const listener of listeners) {
        try {
          listener({ added, changed, removed });
        } catch (error) {
          options.diagnose(`A ${options.label} change listener threw.`, error);
        }
      }
    }
    options.afterScan?.();
  }

  let dirty = false;
  let running: Promise<void> | undefined;
  let closed = false;
  let unwatch: (() => void) | undefined;

  async function loop(): Promise<void> {
    // Listening starts with the first scan, never at construction: a catalog nobody has
    // refreshed holds no watcher. It starts before the scan so a change after the scan reads
    // the source is not missed.
    unwatch ??= source.watch(() => trigger());
    for (;;) {
      // Decided and cleared in one synchronous step, so a `refresh()` is either behind a scan
      // that has not started yet or starts a loop of its own, never handed a loop that is over.
      if (!dirty || closed) {
        running = undefined;
        return;
      }
      dirty = false;
      try {
        await scanOnce();
      } catch (error) {
        options.diagnose(`The ${options.label} could not be scanned.`, error);
      }
    }
  }

  function trigger(): void {
    if (closed) return;
    dirty = true;
    running ??= loop();
  }

  return {
    entries: () => entries,
    refresh() {
      trigger();
      return running ?? Promise.resolve();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      closed = true;
      unwatch?.();
      unwatch = undefined;
      listeners.clear();
      await running;
    },
  };
}
