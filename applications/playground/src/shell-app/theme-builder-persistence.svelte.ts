/**
 * The workbench's side of local persistence (COR-490): opens the store, loads the library,
 * serializes writes so a tab never conflicts with itself, and announces saved revisions to
 * other tabs. It owns the failure the status area shows. Theme values go only to the local
 * database; the channel carries ids and revision numbers.
 */

import {
  ThemeDraftStorage,
  failure as storageFailure,
  type LoadResult,
  type SaveResult,
  type StorageFailure,
  type StorageProblem,
} from './theme-draft-storage.ts';
import { classifyStorageError, type ThemeStore } from './theme-draft-store.ts';
import {
  announceRevision,
  listenForRevisions,
  type ChannelLike,
  type RevisionAnnouncement,
} from './theme-draft-sync.ts';
import type { ThemeEntry } from './theme-library.ts';

export type PersistenceDeps = {
  openStore: () => Promise<ThemeStore>;
  channel: ChannelLike | null;
  /** Identifies this tab in announcements so it ignores its own. */
  tabId: string;
};

export class ThemeBuilderPersistence {
  /** The failure the status area names; `null` while storage is healthy. */
  failure = $state.raw<StorageFailure | null>(null);
  /** Stored records that could not be read, each with its unchanged download. */
  problems = $state.raw<StorageProblem[]>([]);

  readonly #deps: PersistenceDeps;
  #storage: ThemeDraftStorage | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: PersistenceDeps) {
    this.#deps = deps;
  }

  /** Open the store and read the library. Returns `null` when storage is unavailable. */
  async open(): Promise<Extract<LoadResult, { ok: true }> | null> {
    try {
      this.#storage = new ThemeDraftStorage(await this.#deps.openStore());
    } catch (error) {
      this.failure = storageFailure(classifyStorageError(error));
      return null;
    }
    const loaded = await this.#storage.load();
    if (!loaded.ok) {
      this.failure = loaded.failure;
      return null;
    }
    this.problems = loaded.problems;
    return loaded;
  }

  get available(): boolean {
    return this.#storage !== null;
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Save the entry `latest` returns when the write's turn comes, so a write queued behind
   * another always compares against the revision that one just stored.
   */
  save(
    latest: () => ThemeEntry | null,
    settle: (result: SaveResult, saved: ThemeEntry) => void,
  ): Promise<void> {
    return this.#serial(async () => {
      const entry = latest();
      if (entry === null || this.#storage === null) return;
      const result = await this.#storage.save(entry);
      if (result.ok) {
        this.failure = null;
        announceRevision(
          this.#deps.channel,
          this.#deps.tabId,
          entry.draft.envelope.id,
          result.revision,
        );
      } else {
        this.failure = result.failure;
      }
      // Inside the queue turn, so the next write sees the revision this one stored.
      settle(result, entry);
    });
  }

  /** Read one theme as stored, for the cross-tab decision and "Reload stored version". */
  async read(id: string): ReturnType<ThemeDraftStorage['read']> {
    if (this.#storage === null) return { ok: false, failure: storageFailure('storage-error') };
    return this.#storage.read(id);
  }

  removePermanently(id: string, revision: number): Promise<SaveResult | null> {
    return this.#serial(async () => {
      if (this.#storage === null) return null;
      const result = await this.#storage.removePermanently(id, revision);
      if (result.ok) {
        this.failure = null;
        announceRevision(this.#deps.channel, this.#deps.tabId, id, revision + 1);
      } else this.failure = result.failure;
      return result;
    });
  }

  /** Permanently delete a newer-version record the user downloaded; see the storage method. */
  removeFutureVersionRecord(problem: StorageProblem): Promise<SaveResult | null> {
    return this.#serial(async () => {
      if (this.#storage === null) return null;
      const result = await this.#storage.removeFutureVersionRecord(
        problem.id,
        problem.download.text,
      );
      if (result.ok) {
        this.problems = this.problems.filter((candidate) => candidate.id !== problem.id);
      } else this.failure = result.failure;
      return result;
    });
  }

  setActive(id: string | null): Promise<void> {
    return this.#serial(async () => {
      await this.#storage?.setActive(id);
    });
  }

  /** Listen for other tabs' announcements; returns the unsubscribe. */
  listen(onAnnouncement: (announcement: RevisionAnnouncement) => void): () => void {
    const channel = this.#deps.channel;
    if (channel === null) return () => undefined;
    return listenForRevisions(channel, this.#deps.tabId, onAnnouncement);
  }

  /** Wait for every queued write; tests and teardown use it. */
  async settled(): Promise<void> {
    await this.#queue;
  }
}
