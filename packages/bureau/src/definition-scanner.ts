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
  /** Of `added` and `changed`, the identifiers whose definition is invalid now and cannot run. */
  readonly rejected: readonly string[];
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
  /**
   * Turn one definition's bytes into an entry. `plugin` is the plugin whose read-only layer holds
   * it (COR-1873), or `undefined` for an owner's definition.
   */
  readonly evaluate: (
    id: string,
    bytes: Uint8Array,
    hash: string,
    revision: number,
    plugin: string | undefined,
  ) => TEntry;
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
  /** Whether an entry is a definition that cannot run; a change reports these as `rejected`. */
  readonly isRejected: (entry: TEntry) => boolean;
}

/**
 * What a scanner has recorded about its own scans, for a diagnostics read that cannot wait on the
 * source (COR-1731). Counts, a time, and an error message only: never an error's stack, a
 * definition's bytes, or a path the source did not put in the message itself.
 */
export interface DefinitionScannerHealth {
  /**
   * The runtime clock's reading, in epoch milliseconds, when the last scan finished, whether it
   * succeeded or failed. `undefined` until the first scan finishes (a scanner nobody has
   * refreshed has not scanned).
   */
  readonly lastScanAt: number | undefined;
  /**
   * The message of the error the last scan failed with. `undefined` when the last scan succeeded
   * and before any scan finished; the next successful scan clears it.
   */
  readonly lastScanError: string | undefined;
}

export interface DefinitionScanner<TEntry extends ScannedEntry> {
  /** Every definition the source holds, by identifier, as of the last scan. */
  readonly entries: () => ReadonlyMap<string, TEntry>;
  /** When the last scan finished and the message of its error, recorded as scans happen. */
  readonly health: () => DefinitionScannerHealth;
  /** Rescan the source; resolves once the entries reflect a scan that began after this call. */
  readonly refresh: () => Promise<void>;
  /**
   * Rescan after a write the source already made durable. Like {@link refresh}, but it rejects
   * when the scan that follows fails, saying the write is durable, so a write-through caller does
   * not report success over a catalog that does not show it. A failed scan also schedules a
   * rescan of its own, so the catalog catches up without waiting for the source to report.
   */
  readonly reload: () => Promise<void>;
  /** Called after every rescan that added, changed, or removed an entry. Returns its unsubscribe. */
  readonly onChange: (listener: (change: DefinitionChange) => void) => () => void;
  /** Stop listening to the source and wait for a scan in flight. */
  readonly close: () => Promise<void>;
}

/**
 * How long after a failed scan the next attempt runs, in milliseconds. A scan that fails leaves the
 * catalog behind a source that may have changed; this bounds how long it stays behind when the
 * source reports nothing.
 */
export const REPAIR_RESCAN_MILLISECONDS = 1000;

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
      return options.evaluate(id, raw.bytes, raw.hash, revision, raw.plugin);
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
    const rejected = [...added, ...changed].filter((id) => {
      const entry = next.get(id);
      return entry !== undefined && options.isRejected(entry);
    });
    entries = new Map(next);
    if (added.length + changed.length + removed.length > 0) {
      for (const listener of listeners) {
        try {
          listener({ added, changed, removed, rejected });
        } catch (error) {
          options.diagnose(`A ${options.label} change listener threw.`, error);
        }
      }
    }
    failure = undefined;
    lastScanAt = options.runtime.clock.now();
    lastScanError = undefined;
    options.afterScan?.();
  }

  let dirty = false;
  /** The error of the last scan when it failed, until a scan succeeds. */
  let failure: { readonly error: unknown } | undefined;
  /** COR-1731: the finish time and failure message of the last scan, read by `health()`. */
  let lastScanAt: number | undefined;
  let lastScanError: string | undefined;
  let repairTimer: unknown;
  /** True while `source.watch` runs: a listener it calls at once only marks the set dirty. */
  let subscribing = false;
  let running: Promise<void> | undefined;
  let closed = false;
  let unwatch: (() => void) | undefined;

  async function loop(): Promise<void> {
    // Listening starts with the first scan, never at construction: a catalog nobody has
    // refreshed holds no watcher. It starts before the scan so a change after the scan reads
    // the source is not missed.
    if (unwatch === undefined) {
      subscribing = true;
      try {
        unwatch = source.watch(() => trigger());
      } finally {
        subscribing = false;
      }
    }
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
        failure = { error };
        lastScanAt = options.runtime.clock.now();
        lastScanError = error instanceof Error ? error.message : String(error);
        options.diagnose(`The ${options.label} could not be scanned.`, error);
        scheduleRepair();
      }
    }
  }

  function trigger(): void {
    if (closed) return;
    dirty = true;
    if (subscribing) return;
    running ??= loop();
  }

  /** One rescan later, so a scan that failed is tried again whether or not the source reports. */
  function scheduleRepair(): void {
    if (closed || repairTimer !== undefined) return;
    repairTimer = options.runtime.timers.setTimeout(() => {
      repairTimer = undefined;
      trigger();
    }, REPAIR_RESCAN_MILLISECONDS);
  }

  return {
    entries: () => entries,
    health: () => ({ lastScanAt, lastScanError }),
    refresh() {
      trigger();
      return running ?? Promise.resolve();
    },
    async reload() {
      trigger();
      await running;
      if (failure === undefined) return;
      const { error } = failure;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `The ${options.label} was written and the change is durable, but reading it back failed: ${reason}. The catalog is behind the ${options.label} until a later rescan succeeds, which has been scheduled.`,
        { cause: error },
      );
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      closed = true;
      if (repairTimer !== undefined) options.runtime.timers.clearTimeout(repairTimer);
      repairTimer = undefined;
      unwatch?.();
      unwatch = undefined;
      listeners.clear();
      await running;
    },
  };
}
