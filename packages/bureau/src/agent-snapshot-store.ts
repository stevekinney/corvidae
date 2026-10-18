/**
 * The snapshots of file-based agent definitions (COR-1524) and the references that keep them.
 *
 * A run of a file agent uses the definition it started with. When it starts, Bureau stores that
 * definition here, keyed by the identifier and the SHA-256 of the file's bytes, and a reference
 * ties the run to it. A resumed run builds its agent from the snapshot, never from the file, so
 * editing or deleting the file mid-run, or across a restart, cannot change a run that began.
 *
 * ## Keys
 *
 * - `bureau-agent-snapshot:v1:<id>:<hash>` holds an {@link AgentSnapshot}. An identifier cannot
 *   hold `:` and a hash is hex, so the key needs no encoding and `revisions(id)` is one prefix
 *   list.
 * - `bureau-agent-run:v1:<runId>` holds an {@link AgentRunReference}, the reference that keeps a
 *   snapshot alive until its run's retention ends.
 *
 * ## Retention
 *
 * A snapshot is kept while any reference to it remains. A reference leaves when its run is
 * deleted ({@link AgentSnapshotStore.releaseRun}, from `run.removed`) or when it has been settled
 * for longer than the task retention window ({@link AgentSnapshotStore.pruneSettledBefore}). The
 * second path is what releases a `bureau.run()` run, which leaves the run store the moment it
 * settles and is never deleted. A run that has not settled keeps its snapshot indefinitely: it may
 * still be resumed.
 *
 * Writes and prunes are serialized in this process. A different process pruning the same store
 * in the instant between a run's reference and its snapshot is not excluded; `recordRun` checks
 * for that and rewrites the snapshot.
 *
 * @module agent-snapshot-store
 */

import { MemoryStorage, textValueStore, type TextValueStore } from '@lostgradient/weft';

import type { AgentFileDefinition } from './agent-file';

export const AGENT_SNAPSHOT_KEY_PREFIX = 'bureau-agent-snapshot:v1:';
export const AGENT_RUN_REFERENCE_KEY_PREFIX = 'bureau-agent-run:v1:';

/** A definition as a run started with it. */
export interface AgentSnapshot {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly hash: string;
  readonly firstRunAt: string;
  readonly lastRunAt: string;
  readonly definition: AgentFileDefinition;
}

/** The tie between one run and the snapshot it started on. */
export interface AgentRunReference {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly hash: string;
  readonly startedAt: string;
  readonly settledAt?: string;
}

/** What `recordRun` stores: the file agent as it stood when the run started. */
export interface AgentSnapshotSource {
  readonly id: string;
  readonly hash: string;
  readonly definition: AgentFileDefinition;
}

/** One entry of `revisions(id)`. */
export interface AgentRevision {
  readonly id: string;
  readonly hash: string;
  readonly firstRunAt: string;
  readonly lastRunAt: string;
  readonly definition: AgentFileDefinition;
}

export interface AgentSnapshotStore {
  /** Store the snapshot if it is absent (else note this run on it) and tie `runId` to it. */
  recordRun(source: AgentSnapshotSource, runId: string): Promise<void>;
  /** Stamp the run's reference as settled. A no-op for a run with no reference. */
  settleRun(runId: string): Promise<void>;
  /** Drop the run's reference, then its snapshot if no other reference holds it. */
  releaseRun(runId: string): Promise<void>;
  /** The snapshot for `id` at `hash`, or `undefined` when there is none. */
  load(id: string, hash: string): Promise<AgentSnapshot | undefined>;
  /** The snapshots that have run for `id`, most recently run first. */
  revisions(id: string): Promise<readonly AgentRevision[]>;
  /**
   * Drop every reference settled before `cutoff` (epoch milliseconds), then every snapshot left
   * with none. Resolves how many snapshots it removed.
   */
  pruneSettledBefore(cutoff: number): Promise<number>;
}

export interface AgentSnapshotStoreOptions {
  /** Where the records live. Omit for a store that lasts as long as the process. */
  readonly store?: TextValueStore | undefined;
  readonly nowISO: () => string;
}

function snapshotKey(id: string, hash: string): string {
  return `${AGENT_SNAPSHOT_KEY_PREFIX}${id}:${hash}`;
}

function referenceKey(runId: string): string {
  return `${AGENT_RUN_REFERENCE_KEY_PREFIX}${runId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSnapshot(text: string | null): AgentSnapshot | undefined {
  if (text === null) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (
      isRecord(value) &&
      value['schemaVersion'] === 1 &&
      typeof value['id'] === 'string' &&
      typeof value['hash'] === 'string' &&
      typeof value['firstRunAt'] === 'string' &&
      typeof value['lastRunAt'] === 'string' &&
      isRecord(value['definition'])
    ) {
      return value as unknown as AgentSnapshot;
    }
  } catch {
    // A record that is not JSON is not a snapshot.
  }
  return undefined;
}

function parseReference(text: string | null): AgentRunReference | undefined {
  if (text === null) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (
      isRecord(value) &&
      value['schemaVersion'] === 1 &&
      typeof value['id'] === 'string' &&
      typeof value['hash'] === 'string' &&
      typeof value['startedAt'] === 'string' &&
      (value['settledAt'] === undefined || typeof value['settledAt'] === 'string')
    ) {
      return value as unknown as AgentRunReference;
    }
  } catch {
    // A record that is not JSON is not a reference.
  }
  return undefined;
}

export function createAgentSnapshotStore(options: AgentSnapshotStoreOptions): AgentSnapshotStore {
  const store = options.store ?? textValueStore(new MemoryStorage());
  let tail: Promise<unknown> = Promise.resolve();
  /** One at a time in this process, so a prune never races a start. */
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  }

  async function referencedHashes(): Promise<Set<string>> {
    const referenced = new Set<string>();
    for (const key of await store.list(AGENT_RUN_REFERENCE_KEY_PREFIX)) {
      const reference = parseReference(await store.get(key));
      if (reference !== undefined) referenced.add(snapshotKey(reference.id, reference.hash));
    }
    return referenced;
  }

  async function deleteSnapshotIfUnreferenced(key: string): Promise<boolean> {
    const referenced = await referencedHashes();
    if (referenced.has(key)) return false;
    await store.delete(key);
    return true;
  }

  return {
    recordRun(source, runId) {
      return exclusive(async () => {
        const now = options.nowISO();
        const key = snapshotKey(source.id, source.hash);
        // The reference first: a prune that lists references between the two writes then sees it.
        await store.set(
          referenceKey(runId),
          JSON.stringify({
            schemaVersion: 1,
            id: source.id,
            hash: source.hash,
            startedAt: now,
          } satisfies AgentRunReference),
        );
        const existing = parseSnapshot(await store.get(key));
        const snapshot: AgentSnapshot = {
          schemaVersion: 1,
          id: source.id,
          hash: source.hash,
          firstRunAt: existing?.firstRunAt ?? now,
          lastRunAt: now,
          definition: existing?.definition ?? source.definition,
        };
        await store.set(key, JSON.stringify(snapshot));
        // Another process may have pruned the snapshot between the reference and this write.
        if ((await store.get(key)) === null) await store.set(key, JSON.stringify(snapshot));
      });
    },

    settleRun(runId) {
      return exclusive(async () => {
        const reference = parseReference(await store.get(referenceKey(runId)));
        if (reference === undefined || reference.settledAt !== undefined) return;
        await store.set(
          referenceKey(runId),
          JSON.stringify({ ...reference, settledAt: options.nowISO() }),
        );
      });
    },

    releaseRun(runId) {
      return exclusive(async () => {
        const reference = parseReference(await store.get(referenceKey(runId)));
        if (reference === undefined) return;
        await store.delete(referenceKey(runId));
        await deleteSnapshotIfUnreferenced(snapshotKey(reference.id, reference.hash));
      });
    },

    async load(id, hash) {
      return parseSnapshot(await store.get(snapshotKey(id, hash)));
    },

    async revisions(id) {
      const found: AgentRevision[] = [];
      for (const key of await store.list(`${AGENT_SNAPSHOT_KEY_PREFIX}${id}:`)) {
        const snapshot = parseSnapshot(await store.get(key));
        if (snapshot === undefined) continue;
        found.push({
          id: snapshot.id,
          hash: snapshot.hash,
          firstRunAt: snapshot.firstRunAt,
          lastRunAt: snapshot.lastRunAt,
          definition: snapshot.definition,
        });
      }
      return found.toSorted(
        (left, right) =>
          right.lastRunAt.localeCompare(left.lastRunAt) ||
          right.firstRunAt.localeCompare(left.firstRunAt) ||
          right.hash.localeCompare(left.hash),
      );
    },

    pruneSettledBefore(cutoff) {
      return exclusive(async () => {
        const touched = new Set<string>();
        for (const key of await store.list(AGENT_RUN_REFERENCE_KEY_PREFIX)) {
          const reference = parseReference(await store.get(key));
          if (reference?.settledAt === undefined) continue;
          if (!(Date.parse(reference.settledAt) < cutoff)) continue;
          await store.delete(key);
          touched.add(snapshotKey(reference.id, reference.hash));
        }
        let removed = 0;
        for (const key of touched) {
          if (await deleteSnapshotIfUnreferenced(key)) removed += 1;
        }
        return removed;
      });
    },
  };
}
