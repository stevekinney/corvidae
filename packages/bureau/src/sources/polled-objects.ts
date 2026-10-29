/**
 * The objects under one key prefix that an S3 definition source loads, keeps current, and reports
 * changes of (COR-1762). It is the poll-only counterpart of `watched-directory.ts`: an object
 * store has no change feed, so a rescan on the runtime's timer is the whole watch.
 *
 * ## Scanning
 *
 * A scan lists every key under the prefix, following continuation tokens. Only keys directly
 * under the prefix that end in the extension are definitions. A listed object whose ETag is the
 * one the last scan read is not read again, so a poll that finds nothing changed costs the
 * listing alone; an object over the size limit is listed as a `file-too-large` problem without
 * being read. Scans run one at a time, and a timer tick that arrives during a scan is dropped.
 * Every poll tells the listeners, with empty lists when nothing changed, because Bureau's catalogs
 * depend on state outside the bytes (`definition-source.ts` `watch`).
 *
 * The ETag is a change detector only. A definition's `hash` is always the SHA-256 of its bytes.
 *
 * @module polled-objects
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';

import { type DefinitionEntry, hashDefinitionBytes } from './definition-source';
import type { ObjectStoreOperations } from './object-operations';

/**
 * How often an object prefix rescans on its own, in milliseconds, unless the source is given its
 * own interval. The same period as the directory sources' safety rescan.
 */
export const OBJECT_POLL_INTERVAL_MILLISECONDS = 1000;

/** What changed in one scan, by identifier. */
export interface ObjectChange {
  readonly added: string[];
  readonly changed: string[];
  readonly removed: string[];
}

export interface PolledObjectsOptions {
  readonly operations: ObjectStoreOperations;
  /** The key prefix, empty or ending in `/`. */
  readonly prefix: string;
  /** What the prefix holds, for diagnostics: `agent object source`. */
  readonly label: string;
  /** The extension a key must end in exactly, such as `.md`. */
  readonly extension: string;
  /** The largest object read, in bytes. */
  readonly sizeLimit: number;
  readonly pollIntervalMilliseconds: number;
  /** The runtime whose timers drive the poll; read when polling starts. */
  readonly runtime: () => RuntimeServices;
  /** Where poll failures are reported. */
  readonly diagnose: (message: string, cause: unknown) => void;
  /** Poll. Defaults to `true`; `false` leaves reloading to `refresh()`. */
  readonly watch?: boolean | undefined;
}

export interface PolledObjects {
  /** Every definition under the prefix, by identifier. */
  readonly entries: () => ReadonlyMap<string, DefinitionEntry>;
  /** Rescan; resolves once the entries reflect the store, and rejects if the listing failed. */
  readonly refresh: () => Promise<void>;
  /** Called after every scan that changed an entry, and after every poll. Returns its unsubscribe. */
  readonly onChange: (listener: (change: ObjectChange) => void) => () => void;
  /** Begin polling. Does nothing under `watch: false`. */
  readonly startWatching: () => void;
  /** Stop polling. A scan in flight finishes and tells no one new about the timer. */
  readonly stopWatching: () => void;
}

const NO_BYTES = new Uint8Array(0);

interface Held {
  readonly entry: DefinitionEntry;
  /** The ETag the entry was built from; `undefined` for an entry that must be read again. */
  readonly etag: string | undefined;
}

function sameSignature(before: DefinitionEntry, after: DefinitionEntry): boolean {
  return before.hash === after.hash && before.problem?.code === after.problem?.code;
}

function tooLarge(id: string, size: number): DefinitionEntry {
  return {
    id,
    bytes: NO_BYTES,
    hash: '',
    problem: { code: 'file-too-large', message: `The object is ${size} bytes.`, size },
  };
}

export function createPolledObjects(options: PolledObjectsOptions): PolledObjects {
  const { operations, prefix, extension } = options;
  let held = new Map<string, Held>();
  const listeners = new Set<(change: ObjectChange) => void>();

  async function loadEntry(
    id: string,
    key: string,
    listed: { readonly etag: string; readonly size: number },
    previous: Held | undefined,
  ): Promise<Held | undefined> {
    if (listed.etag !== '' && previous?.etag === listed.etag) return previous;
    if (listed.size > options.sizeLimit) {
      return { entry: tooLarge(id, listed.size), etag: listed.etag };
    }
    try {
      const read = await operations.read(key);
      if (read === undefined) return undefined;
      if (read.bytes.byteLength > options.sizeLimit) {
        return { entry: tooLarge(id, read.bytes.byteLength), etag: read.etag };
      }
      const hash = hashDefinitionBytes(read.bytes);
      if (previous?.entry.hash === hash) return { entry: previous.entry, etag: read.etag };
      return { entry: { id, bytes: read.bytes, hash }, etag: read.etag };
    } catch (error) {
      return {
        entry: {
          id,
          bytes: NO_BYTES,
          hash: '',
          problem: {
            code: 'unreadable',
            message: error instanceof Error ? error.message : String(error),
          },
        },
        // Not remembered, so the next scan reads the object again.
        etag: undefined,
      };
    }
  }

  async function scanOnce(heartbeat: boolean): Promise<void> {
    const next = new Map<string, Held>();
    let token: string | undefined;
    do {
      const page = await operations.list(prefix, token);
      for (const listed of page.objects) {
        if (!listed.key.startsWith(prefix) || !listed.key.endsWith(extension)) continue;
        const name = listed.key.slice(prefix.length);
        const id = name.slice(0, -extension.length);
        if (id === '' || name.includes('/') || name.startsWith('.')) continue;
        const loaded = await loadEntry(id, listed.key, listed, held.get(id));
        if (loaded !== undefined) next.set(id, loaded);
      }
      token = page.nextContinuationToken;
    } while (token !== undefined && token !== '');
    const added: string[] = [];
    const changed: string[] = [];
    const removed: string[] = [];
    for (const [id, now] of next) {
      const before = held.get(id);
      if (before === undefined) added.push(id);
      else if (!sameSignature(before.entry, now.entry)) changed.push(id);
    }
    for (const id of held.keys()) if (!next.has(id)) removed.push(id);
    held = next;
    if (heartbeat || added.length + changed.length + removed.length > 0) {
      for (const listener of listeners) {
        try {
          listener({ added, changed, removed });
        } catch (error) {
          options.diagnose(`A ${options.label} change listener threw.`, error);
        }
      }
    }
  }

  /** The end of the queue of scans, which run one at a time. */
  let tail: Promise<void> = Promise.resolve();
  function enqueue(heartbeat: boolean): Promise<void> {
    const run = tail.then(() => scanOnce(heartbeat));
    tail = run.catch(() => undefined);
    return run;
  }

  let timer: unknown;
  let timerRuntime: RuntimeServices | undefined;
  let polling = false;

  /** A scan nobody awaits: a failure is reported, and the previous entries stay. */
  function scanInBackground(heartbeat: boolean): void {
    enqueue(heartbeat).catch((error: unknown) => {
      options.diagnose(`The ${options.label} could not be scanned.`, error);
    });
  }

  return {
    entries: () => new Map([...held].map(([id, value]) => [id, value.entry])),
    refresh: () => enqueue(false),
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    startWatching() {
      if (options.watch === false || timer !== undefined) return;
      timerRuntime = options.runtime();
      timer = timerRuntime.timers.setInterval(() => {
        // A tick that arrives while the last poll is still scanning is dropped, not queued.
        if (polling) return;
        polling = true;
        enqueue(true)
          .finally(() => {
            polling = false;
          })
          .catch((error: unknown) => {
            options.diagnose(`The ${options.label} could not be scanned.`, error);
          });
      }, options.pollIntervalMilliseconds);
      scanInBackground(false);
    },
    stopWatching() {
      if (timer !== undefined) timerRuntime?.timers.clearInterval(timer);
      timer = undefined;
    },
  };
}
