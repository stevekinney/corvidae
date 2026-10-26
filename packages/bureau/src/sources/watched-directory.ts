/**
 * A directory of files that a definition source loads, keeps current, and reports changes of
 * (COR-1524 for agent files, COR-1527 for workflow files, COR-1702 for the sources around them).
 * Everything here is format-neutral: it hands out each file's bytes and hash, and Bureau supplies
 * how one file's bytes become an agent or a workflow.
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

import { type AgentFileOperations, nodeAgentFileOperations } from './agent-file-operations';
import { type DefinitionEntry, hashDefinitionBytes } from './definition-source';

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
  readonly added: string[];
  readonly changed: string[];
  readonly removed: string[];
}

export interface WatchedDirectoryOptions {
  readonly directory: string;
  /** What the directory holds, for diagnostics: `agent directory`. */
  readonly label: string;
  /** The extension a file must end in exactly, such as `.md`. */
  readonly extension: string;
  /** The largest file read, in bytes. */
  readonly sizeLimit: number;
  /** The runtime whose timers drive the safety rescan; read when the rescan starts. */
  readonly runtime: () => RuntimeServices;
  /** Where watcher and scan failures are reported. */
  readonly diagnose: (message: string, cause: unknown) => void;
  readonly operations?: AgentFileOperations | undefined;
  /** Watch the directory. Defaults to `true`; `false` leaves reloading to `refresh()`. */
  readonly watch?: boolean | undefined;
  /** How a directory is watched. Defaults to `fs.watch` without keeping the process alive. */
  readonly openWatcher?:
    | ((path: string, listener: (event: string, filename: string | null) => void) => FSWatcher)
    | undefined;
}

export interface WatchedDirectory {
  /** Every file in the directory that is a candidate, by identifier. */
  readonly entries: () => ReadonlyMap<string, DefinitionEntry>;
  /** Rescan the directory; resolves once the entries reflect it. */
  readonly refresh: () => Promise<void>;
  /** Called after every rescan that added, changed, or removed an entry. Returns its unsubscribe. */
  readonly onChange: (listener: (change: DirectoryChange) => void) => () => void;
  /** Begin watching: arm `fs.watch` and the safety rescan. Does nothing under `watch: false`. */
  readonly startWatching: () => void;
  /** Stop watching: close the watchers and the safety rescan. A scan in flight finishes. */
  readonly stopWatching: () => void;
}

const NO_BYTES = new Uint8Array(0);

/** Whether a rescan found `after` to be a different file state than `before`. */
function sameSignature(before: DefinitionEntry, after: DefinitionEntry): boolean {
  return before.hash === after.hash && before.problem?.code === after.problem?.code;
}

export function createWatchedDirectory(options: WatchedDirectoryOptions): WatchedDirectory {
  const operations = options.operations ?? nodeAgentFileOperations;
  const { directory, extension } = options;
  const openWatcher =
    options.openWatcher ?? ((path, listener) => watch(path, { persistent: false }, listener));
  let entries = new Map<string, DefinitionEntry>();
  const listeners = new Set<(change: DirectoryChange) => void>();

  async function loadEntry(
    id: string,
    name: string,
    previous: DefinitionEntry | undefined,
  ): Promise<DefinitionEntry | undefined> {
    const path = `${directory}/${name}`;
    try {
      const size = await operations.size(path);
      if (size === undefined) return undefined;
      if (size > options.sizeLimit) {
        return {
          id,
          bytes: NO_BYTES,
          hash: '',
          problem: { code: 'file-too-large', message: `The file is ${size} bytes.`, size },
        };
      }
      const bytes = await operations.read(path);
      if (bytes === undefined) return undefined;
      const hash = hashDefinitionBytes(bytes);
      if (previous?.hash === hash) return previous;
      return { id, bytes, hash };
    } catch (error) {
      return {
        id,
        bytes: NO_BYTES,
        hash: '',
        problem: {
          code: 'unreadable',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async function scanOnce(): Promise<void> {
    const listing = await operations.listDirectory(directory);
    const next = new Map<string, DefinitionEntry>();
    for (const item of listing ?? []) {
      if (!item.isFile || item.name.startsWith('.') || !item.name.endsWith(extension)) continue;
      const id = item.name.slice(0, -extension.length);
      const entry = await loadEntry(id, item.name, entries.get(id));
      if (entry !== undefined) next.set(id, entry);
    }
    const added: string[] = [];
    const changed: string[] = [];
    const removed: string[] = [];
    for (const [id, entry] of next) {
      const before = entries.get(id);
      if (before === undefined) added.push(id);
      else if (!sameSignature(before, entry)) changed.push(id);
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
  }

  let dirty = false;
  let running: Promise<void> | undefined;
  /** Whether the directory is being watched: nothing is armed or polled until a listener asks. */
  let watching = false;
  /** The watchers that are open, by the path each watches. */
  const watchers = new Map<string, { readonly watcher: FSWatcher; readonly watches: string }>();
  let forceRearm = false;
  let pollTimer: unknown;
  let pollRuntime: RuntimeServices | undefined;

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
    if (!watching) return;
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
    if (!watching) return;
    const wanted = new Map<string, string | undefined>();
    if ((await operations.size(directory)) !== undefined) wanted.set(directory, undefined);
    const ancestor = await nearestExistingAncestor();
    // `stopWatching()` may have landed while the directory was being looked at: open nothing then.
    if (!watching) return;
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
    if (pollTimer !== undefined || !watching) return;
    pollRuntime = options.runtime();
    pollTimer = pollRuntime.timers.setInterval(trigger, DIRECTORY_POLL_INTERVAL_MILLISECONDS);
  }

  async function loop(): Promise<void> {
    startPolling();
    for (;;) {
      // Decided and cleared in one synchronous step, so a `refresh()` is either behind a scan
      // that has not started yet or starts a loop of its own, never handed a loop that is over.
      if (!dirty) {
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
    startWatching() {
      if (options.watch === false || watching) return;
      watching = true;
      trigger();
    },
    stopWatching() {
      // A scan in flight may be setting watchers up: it opens none once `watching` is cleared.
      watching = false;
      if (pollTimer !== undefined) pollRuntime?.timers.clearInterval(pollTimer);
      pollTimer = undefined;
      for (const held of watchers.values()) held.watcher.close();
      watchers.clear();
    },
  };
}
