/**
 * A directory of files that a Bureau subsystem loads, keeps current, and reports changes of
 * (COR-1524 for agent files, COR-1527 for workflow files). Everything here is format-neutral: the
 * subsystem supplies how one file's bytes become an entry.
 *
 * ## Watching
 *
 * `fs.watch` is only a trigger. Any event marks the directory dirty, and one single-flight loop
 * rescans the whole directory until nothing is dirty: bursts coalesce, and because a rescan is
 * idempotent it makes no difference whether a change arrived as an edit, a rename into place, a
 * delete, or the directory itself disappearing. There is no debounce interval. Because `fs.watch`
 * can drop an event, a once-a-second rescan ({@link DIRECTORY_POLL_INTERVAL_MILLISECONDS}) backs it
 * up; it reports nothing when nothing changed. A directory that does not exist is empty, watched
 * through its nearest existing ancestor until it appears.
 *
 * @module watched-directory
 */

import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

import type { RuntimeServices } from '@lostgradient/lifecycle';

import { hashAgentFileBytes } from './agent-file';
import { type AgentFileOperations, nodeAgentFileOperations } from './agent-file-operations';

/**
 * How often a directory rescans on its own, in milliseconds. `fs.watch` is the primary signal, but
 * it is lossy: on macOS a directory's creation went unreported in about one of two hundred runs of
 * a test that makes the directory and a file in it back to back. A rescan is idempotent and finds
 * nothing to report when nothing changed, so this safety net costs a directory read and the files'
 * bytes once a second, and bounds how long a change the watcher missed can go unseen.
 */
export const DIRECTORY_POLL_INTERVAL_MILLISECONDS = 1000;

/** What changed in one rescan, by identifier. */
export interface DirectoryChange {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
}

/** What every entry a directory holds carries, so a rescan can tell whether a file changed. */
export interface DirectoryEntry {
  readonly id: string;
  /** The SHA-256 of the file's bytes, or `undefined` when they could not be read. */
  readonly hash: string | undefined;
  /** The deployment state the entry was evaluated against; a different value re-evaluates it. */
  readonly revision: number;
}

export interface WatchedDirectoryOptions<TEntry extends DirectoryEntry> {
  readonly directory: string;
  /** What the directory holds, for diagnostics: `agent directory`. */
  readonly label: string;
  /** The extension a file must end in exactly, such as `.md`. */
  readonly extension: string;
  /** The largest file read, in bytes. */
  readonly sizeLimit: number;
  readonly runtime: RuntimeServices;
  /** Where watcher and scan failures are reported. */
  readonly diagnose: (message: string, cause: unknown) => void;
  readonly operations?: AgentFileOperations | undefined;
  /** Watch the directory. Defaults to `true`; `false` leaves reloading to `refresh()`. */
  readonly watch?: boolean | undefined;
  /** How a directory is watched. Defaults to `fs.watch` without keeping the process alive. */
  readonly openWatcher?:
    | ((path: string, listener: (event: string, filename: string | null) => void) => FSWatcher)
    | undefined;
  /** The current deployment revision; an entry evaluated against another is evaluated again. */
  readonly revision: () => number;
  /** Turn one file's bytes into an entry. */
  readonly evaluate: (id: string, bytes: Uint8Array, hash: string, revision: number) => TEntry;
  /** The entry for a file larger than the limit. */
  readonly tooLarge: (id: string, size: number, revision: number) => TEntry;
  /** The entry for a file that could not be read. */
  readonly unreadable: (id: string, error: unknown, revision: number) => TEntry;
  /**
   * Called after every rescan, whether or not it found a change, once the listeners have been
   * told. A subsystem whose work on a change can fail uses it to try again on the next rescan.
   */
  readonly afterScan?: (() => void) | undefined;
  /** Whether a rescan found `after` to be a different file state than `before`. */
  readonly sameSignature: (before: TEntry, after: TEntry) => boolean;
}

export interface WatchedDirectory<TEntry extends DirectoryEntry> {
  /** Every file in the directory that is a candidate, by identifier. */
  readonly entries: () => ReadonlyMap<string, TEntry>;
  /** Rescan the directory; resolves once the entries reflect it. */
  readonly refresh: () => Promise<void>;
  /** Called after every rescan that added, changed, or removed an entry. Returns its unsubscribe. */
  readonly onChange: (listener: (change: DirectoryChange) => void) => () => void;
  /** Stop watching and wait for a scan in flight. */
  readonly close: () => Promise<void>;
}

export function createWatchedDirectory<TEntry extends DirectoryEntry>(
  options: WatchedDirectoryOptions<TEntry>,
): WatchedDirectory<TEntry> {
  const operations = options.operations ?? nodeAgentFileOperations;
  const { directory, extension } = options;
  const openWatcher =
    options.openWatcher ?? ((path, listener) => watch(path, { persistent: false }, listener));
  let entries = new Map<string, TEntry>();
  const listeners = new Set<(change: DirectoryChange) => void>();

  async function loadEntry(
    id: string,
    name: string,
    revision: number,
    previous: TEntry | undefined,
  ): Promise<TEntry | undefined> {
    const path = `${directory}/${name}`;
    try {
      const size = await operations.size(path);
      if (size === undefined) return undefined;
      if (size > options.sizeLimit) return options.tooLarge(id, size, revision);
      const bytes = await operations.read(path);
      if (bytes === undefined) return undefined;
      const hash = hashAgentFileBytes(bytes);
      if (previous?.hash === hash && previous.revision === revision) return previous;
      return options.evaluate(id, bytes, hash, revision);
    } catch (error) {
      return options.unreadable(id, error, revision);
    }
  }

  async function scanOnce(): Promise<void> {
    const listing = await operations.listDirectory(directory);
    const revision = options.revision();
    const next = new Map<string, TEntry>();
    for (const item of listing ?? []) {
      if (!item.isFile || item.name.startsWith('.') || !item.name.endsWith(extension)) continue;
      const id = item.name.slice(0, -extension.length);
      const entry = await loadEntry(id, item.name, revision, entries.get(id));
      if (entry !== undefined) next.set(id, entry);
    }
    const added: string[] = [];
    const changed: string[] = [];
    const removed: string[] = [];
    for (const [id, entry] of next) {
      const before = entries.get(id);
      if (before === undefined) added.push(id);
      else if (!options.sameSignature(before, entry)) changed.push(id);
    }
    for (const id of entries.keys()) if (!next.has(id)) removed.push(id);
    entries = next;
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
  /** The watchers that are open, by the path each watches. */
  const watchers = new Map<string, { readonly watcher: FSWatcher; readonly watches: string }>();
  let forceRearm = false;
  let pollTimer: unknown;

  /**
   * The nearest existing ancestor of the directory, and the name of the entry under it that leads
   * to the directory. Deleting a watched directory raises no event on the directory itself, so
   * the entry that holds it is watched too.
   */
  async function nearestExistingAncestor(): Promise<
    { readonly path: string; readonly entry: string } | undefined
  > {
    let child = directory;
    for (;;) {
      const parent = dirname(child);
      if (parent === child) return undefined;
      if ((await operations.size(parent)) !== undefined) {
        return { path: parent, entry: basename(child) };
      }
      child = parent;
    }
  }

  function open(path: string, entry: string | undefined): void {
    if (closed) return;
    try {
      const opened = openWatcher(path, (event, filename) => {
        const name = filename ?? null;
        if (entry !== undefined && name !== null && name !== entry) return;
        if (entry === undefined && event === 'rename' && name === null) forceRearm = true;
        trigger();
      });
      opened.on('error', (error) => {
        options.diagnose(`The ${options.label} watcher failed.`, error);
        forceRearm = true;
        trigger();
      });
      watchers.set(path, { watcher: opened, watches: entry ?? '' });
    } catch (error) {
      options.diagnose(`The ${options.label} could not be watched.`, error);
    }
  }

  async function arm(): Promise<void> {
    if (closed || options.watch === false) return;
    const wanted = new Map<string, string | undefined>();
    if ((await operations.size(directory)) !== undefined) wanted.set(directory, undefined);
    const ancestor = await nearestExistingAncestor();
    // `close()` may have landed while the directory was being looked at: open nothing then.
    if (closed) return;
    if (ancestor !== undefined) wanted.set(ancestor.path, ancestor.entry);
    for (const [path, held] of watchers) {
      const entry = wanted.get(path);
      if (
        !wanted.has(path) ||
        (entry ?? '') !== held.watches ||
        (forceRearm && path === directory)
      ) {
        held.watcher.close();
        watchers.delete(path);
      }
    }
    forceRearm = false;
    for (const [path, entry] of wanted) if (!watchers.has(path)) open(path, entry);
  }

  function startPolling(): void {
    if (pollTimer !== undefined || closed || options.watch === false) return;
    pollTimer = options.runtime.timers.setInterval(trigger, DIRECTORY_POLL_INTERVAL_MILLISECONDS);
  }

  async function loop(): Promise<void> {
    startPolling();
    for (;;) {
      // Decided and cleared in one synchronous step, so a `refresh()` is either behind a scan
      // that has not started yet or starts a loop of its own, never handed a loop that is over.
      if (!dirty || closed) {
        running = undefined;
        return;
      }
      dirty = false;
      // Armed before the scan, so a change after the scan reads the directory is not missed.
      try {
        await arm();
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

  function refresh(): Promise<void> {
    trigger();
    return running ?? Promise.resolve();
  }

  return {
    entries: () => entries,
    refresh,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      closed = true;
      if (pollTimer !== undefined) options.runtime.timers.clearInterval(pollTimer);
      pollTimer = undefined;
      listeners.clear();
      // A scan in flight may be setting watchers up: it opens none once `closed` is set, and the
      // watchers it opened before are closed here, after it has stopped.
      await running;
      for (const held of watchers.values()) held.watcher.close();
      watchers.clear();
    },
  };
}
