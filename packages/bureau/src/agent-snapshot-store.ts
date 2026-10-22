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
 *   list. The stored definition is validated on read (`agentFileDefinitionSchema`).
 * - `bureau-agent-run:v1:<runId>` holds an {@link AgentRunReference}, the reference that keeps a
 *   snapshot alive until its run's retention ends.
 *   It also names the definition revision the run started at (COR-1584), because a snapshot is
 *   keyed by content and cannot.
 *
 * ## Starting a run
 *
 * A start is a ticket ({@link AgentSnapshotStore.begin}): the snapshot is written first, so a
 * recovery record that names its hash can always be resumed, and the reference only when the run
 * is known to be this execution's ({@link AgentStartTicket.hold}). A start that loses its claim or
 * fails abandons the ticket, which removes a snapshot nothing holds and touches no reference. A
 * snapshot with a start in flight is never removed by a release or a prune.
 *
 * ## Retention
 *
 * A snapshot is kept while any reference to it remains. A reference leaves when its run is
 * deleted ({@link AgentSnapshotStore.releaseRun}, from `run.removed`), when it has been settled
 * for longer than the task retention window ({@link AgentSnapshotStore.pruneSettledBefore}), or
 * when the maintenance pass finds its run never started. The second path is what releases a
 * `bureau.run()` run, which leaves the run store the moment it settles and is never deleted. A
 * run that has not settled keeps its snapshot: it may still be resumed.
 *
 * ## What is not guaranteed
 *
 * Writes, holds, and prunes are serialized in this process only. Pruning is not atomic across
 * Bureau instances that share a store: one instance can list the references, another can record
 * a new run on the same definition, and the first can then delete the snapshot. Agent files
 * support one Bureau per store (Interborough is one process), so no cross-instance check is made;
 * a topology with several Bureaus over one store would need a conditional delete.
 *
 * That limit is the snapshots' and the run references' only. The revision record of a file agent
 * (`agent-revision-store.ts`, `bureau-agent-revision:v1:<id>`) is written with a conditional
 * batch, so it is safe across processes: two Bureaus on one store that see the same change
 * produce one increment and report the same revision (COR-1584).
 *
 * @module agent-snapshot-store
 */

import { MemoryStorage, textValueStore, type TextValueStore } from '@lostgradient/weft';

import {
  AgentSnapshotError,
  agentFileDefinitionSchema,
  type AgentFileDefinition,
} from './agent-file';

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
  /**
   * The definition revision (`agent-revision-store.ts`) the run started at (COR-1584). A snapshot
   * is keyed by content, so one snapshot can have been several revisions, and a session's
   * metadata names only its latest run's: the run's own reference is where its revision lives.
   * Absent on a reference written before the field existed, which resumes on the session's
   * metadata instead. Filled when the reference is written, or by a later hold only if the field is
   * absent (or was invalid and dropped on read), and never changed once recorded. The reference
   * stays at `schemaVersion` 1, as the field is additive.
   */
  readonly definitionRevision?: number;
}

/** What a start stores: the file agent as it stood when the run started. */
export interface AgentSnapshotSource {
  readonly id: string;
  readonly hash: string;
  readonly definition: AgentFileDefinition;
  /** The definition revision the run starts at, kept on its reference. Not part of the snapshot. */
  readonly definitionRevision?: number | undefined;
}

/** One entry of `revisions(id)`. */
export interface AgentRevision {
  readonly id: string;
  readonly hash: string;
  readonly firstRunAt: string;
  readonly lastRunAt: string;
  readonly definition: AgentFileDefinition;
}

/** A run's reference with the run it belongs to. */
export interface AgentRunReferenceEntry extends AgentRunReference {
  readonly runId: string;
}

/** A start in progress: the snapshot is stored, and the run is not yet known to be this one's. */
export interface AgentStartTicket {
  /** The run is this execution's: tie it to the snapshot. Ends the ticket. */
  hold(runId: string): Promise<void>;
  /** The run will not exist: drop the snapshot if nothing holds it. Ends the ticket; idempotent. */
  abandon(): Promise<void>;
}

export interface AgentSnapshotStore {
  /** Store the snapshot if it is absent and return the ticket for a run that may use it. */
  begin(source: AgentSnapshotSource): Promise<AgentStartTicket>;
  /** `begin`, then `hold`: for a run whose identifier no other execution can claim. */
  recordRun(source: AgentSnapshotSource, runId: string): Promise<void>;
  /** Stamp the run's reference settled, now or at `at`. A no-op for a run with none, or one already settled. */
  settleRun(runId: string, at?: string): Promise<void>;
  /** Drop the run's reference, then its snapshot if no other reference or start holds it. */
  releaseRun(runId: string): Promise<void>;
  /** The run's reference, or `undefined`. */
  reference(runId: string): Promise<AgentRunReference | undefined>;
  /** Every reference that has not settled. */
  unsettledReferences(): Promise<readonly AgentRunReferenceEntry[]>;
  /**
   * The snapshot for `id` at `hash`, or `undefined` when there is none. A stored snapshot whose
   * definition is not valid throws `AgentSnapshotError` (`snapshot-unresolvable`).
   */
  load(id: string, hash: string): Promise<AgentSnapshot | undefined>;
  /** The snapshots that have run for `id`, most recently run first. One that is not valid is skipped. */
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

type ParsedSnapshot =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'ok'; readonly snapshot: AgentSnapshot };

/** A stored snapshot, with its definition checked and its defaults filled in. */
function parseSnapshot(text: string | null): ParsedSnapshot {
  if (text === null) return { kind: 'absent' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // A record that is not JSON is not a snapshot.
    return { kind: 'absent' };
  }
  if (
    !isRecord(value) ||
    value['schemaVersion'] !== 1 ||
    typeof value['id'] !== 'string' ||
    typeof value['hash'] !== 'string' ||
    typeof value['firstRunAt'] !== 'string' ||
    typeof value['lastRunAt'] !== 'string'
  ) {
    return { kind: 'absent' };
  }
  const definition = agentFileDefinitionSchema.safeParse(value['definition']);
  if (!definition.success) return { kind: 'invalid' };
  return {
    kind: 'ok',
    snapshot: {
      schemaVersion: 1,
      id: value['id'],
      hash: value['hash'],
      firstRunAt: value['firstRunAt'],
      lastRunAt: value['lastRunAt'],
      definition: definition.data as AgentFileDefinition,
    },
  };
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
      // A revision that is not a positive safe integer is no revision: the reference still reads.
      const { definitionRevision, ...rest } = value;
      return (typeof definitionRevision === 'number' &&
      Number.isSafeInteger(definitionRevision) &&
      definitionRevision >= 1
        ? { ...rest, definitionRevision }
        : rest) as unknown as AgentRunReference;
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
  /** Starts that have stored a snapshot and not yet held or abandoned it, by snapshot key. */
  const inFlight = new Map<string, number>();
  const adjustInFlight = (key: string, change: 1 | -1): void => {
    const next = (inFlight.get(key) ?? 0) + change;
    if (next <= 0) inFlight.delete(key);
    else inFlight.set(key, next);
  };

  async function referencedKeys(): Promise<Set<string>> {
    const referenced = new Set<string>();
    for (const key of await store.list(AGENT_RUN_REFERENCE_KEY_PREFIX)) {
      const reference = parseReference(await store.get(key));
      if (reference !== undefined) referenced.add(snapshotKey(reference.id, reference.hash));
    }
    return referenced;
  }

  async function deleteSnapshotIfUnheld(key: string): Promise<boolean> {
    if (inFlight.has(key)) return false;
    const referenced = await referencedKeys();
    if (referenced.has(key)) return false;
    await store.delete(key);
    return true;
  }

  async function begin(source: AgentSnapshotSource): Promise<AgentStartTicket> {
    const key = snapshotKey(source.id, source.hash);
    await exclusive(async () => {
      adjustInFlight(key, 1);
      try {
        if (parseSnapshot(await store.get(key)).kind === 'ok') return;
        const now = options.nowISO();
        await store.set(
          key,
          JSON.stringify({
            schemaVersion: 1,
            id: source.id,
            hash: source.hash,
            firstRunAt: now,
            lastRunAt: now,
            definition: source.definition,
          } satisfies AgentSnapshot),
        );
      } catch (error) {
        adjustInFlight(key, -1);
        throw error;
      }
    });
    let ended = false;
    return {
      hold(runId) {
        return exclusive(async () => {
          if (ended) throw new Error('This agent start has already been held or abandoned.');
          ended = true;
          try {
            const now = options.nowISO();
            const existing = parseReference(await store.get(referenceKey(runId)));
            // The reference first: a prune that lists references between the two writes sees it.
            if (existing?.id !== source.id || existing.hash !== source.hash) {
              await store.set(
                referenceKey(runId),
                JSON.stringify({
                  schemaVersion: 1,
                  id: source.id,
                  hash: source.hash,
                  startedAt: now,
                  ...(source.definitionRevision === undefined
                    ? {}
                    : { definitionRevision: source.definitionRevision }),
                } satisfies AgentRunReference),
              );
            } else if (
              source.definitionRevision !== undefined &&
              existing.definitionRevision === undefined
            ) {
              // A reference written before revisions, or one whose value was invalid and dropped on
              // read, gains the revision and keeps its start and its settlement. A revision that is
              // recorded is the run's own and is never changed by a later hold.
              await store.set(
                referenceKey(runId),
                JSON.stringify({ ...existing, definitionRevision: source.definitionRevision }),
              );
            }
            const current = parseSnapshot(await store.get(key));
            const snapshot: AgentSnapshot = {
              schemaVersion: 1,
              id: source.id,
              hash: source.hash,
              firstRunAt: current.kind === 'ok' ? current.snapshot.firstRunAt : now,
              lastRunAt: now,
              definition: source.definition,
            };
            await store.set(key, JSON.stringify(snapshot));
          } finally {
            adjustInFlight(key, -1);
          }
        });
      },
      abandon() {
        return exclusive(async () => {
          if (ended) return;
          ended = true;
          adjustInFlight(key, -1);
          await deleteSnapshotIfUnheld(key);
        });
      },
    };
  }

  return {
    begin,

    async recordRun(source, runId) {
      const ticket = await begin(source);
      try {
        await ticket.hold(runId);
      } catch (error) {
        await ticket.abandon();
        throw error;
      }
    },

    settleRun(runId, at) {
      return exclusive(async () => {
        const reference = parseReference(await store.get(referenceKey(runId)));
        if (reference === undefined || reference.settledAt !== undefined) return;
        await store.set(
          referenceKey(runId),
          JSON.stringify({ ...reference, settledAt: at ?? options.nowISO() }),
        );
      });
    },

    releaseRun(runId) {
      return exclusive(async () => {
        const reference = parseReference(await store.get(referenceKey(runId)));
        if (reference === undefined) return;
        await store.delete(referenceKey(runId));
        await deleteSnapshotIfUnheld(snapshotKey(reference.id, reference.hash));
      });
    },

    async reference(runId) {
      return parseReference(await store.get(referenceKey(runId)));
    },

    async unsettledReferences() {
      const open: AgentRunReferenceEntry[] = [];
      for (const key of await store.list(AGENT_RUN_REFERENCE_KEY_PREFIX)) {
        const reference = parseReference(await store.get(key));
        if (reference === undefined || reference.settledAt !== undefined) continue;
        open.push({ ...reference, runId: key.slice(AGENT_RUN_REFERENCE_KEY_PREFIX.length) });
      }
      return open;
    },

    async load(id, hash) {
      const parsed = parseSnapshot(await store.get(snapshotKey(id, hash)));
      if (parsed.kind === 'invalid') {
        throw new AgentSnapshotError(
          'snapshot-unresolvable',
          id,
          hash,
          `The stored snapshot of agent "${id}" at ${hash} is not a valid definition.`,
        );
      }
      return parsed.kind === 'ok' ? parsed.snapshot : undefined;
    },

    async revisions(id) {
      const found: AgentRevision[] = [];
      for (const key of await store.list(`${AGENT_SNAPSHOT_KEY_PREFIX}${id}:`)) {
        const parsed = parseSnapshot(await store.get(key));
        if (parsed.kind !== 'ok') continue;
        const { snapshot } = parsed;
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
          if (await deleteSnapshotIfUnheld(key)) removed += 1;
        }
        return removed;
      });
    },
  };
}
