/**
 * The stored revisions of workflow files (COR-1527). A workflow file is edited and deleted while
 * instances of it wait in a `sleep` or an `await-signal`, and after a restart each of those must
 * resume on the document it began on. The engine can only load a revision Bureau registers, so
 * Bureau keeps every revision it registered, and registers the ones that still have an instance in
 * flight before the engine recovers.
 *
 * ## Keys
 *
 * `bureau-workflow-snapshot:v1:<identifier>:<workflowVersion>` holds a {@link WorkflowSnapshot}. A
 * plugin's identifier holds a colon (`linear:sync`), so `bureau-workflow-snapshot:v1:linear:` is a
 * prefix of `linear:sync`'s keys too: a read by prefix keeps only the keys whose identifier, split
 * before the version's `sha256:`, is the one asked for.
 *
 * The record is content addressed: `document` is exactly what Weft was handed (the file without
 * `agent` and `paused`), so its recomputed version must equal the key's, and a record whose
 * document is not valid or does not hash to its key is refused when read.
 *
 * ## No per-run references
 *
 * Agent snapshots keep a reference per run, because Bureau starts those runs. Bureau does not start
 * a workflow instance: a schedule fire goes straight to Weft, and so does Weft's own start. Weft
 * stamps every instance with the `workflowVersion` it began on, so the engine is asked which
 * versions have instances in flight (see `workflow-runtime.ts`), and nothing here records a run.
 * The only per-run fact kept is when a revision first and last ran, which `.revisions` reports.
 *
 * ## Retention
 *
 * A snapshot is written when a revision is about to be registered, never later, so no revision is
 * in the engine without one. It is deleted by {@link WorkflowSnapshotStore.pruneUnheld}, which the
 * maintenance pass calls under `retention.tasks`.
 *
 * @module workflow-snapshot-store
 */

import { MemoryStorage, textValueStore, type TextValueStore } from '@lostgradient/storage';
import { type WorkflowDocument, workflowDocumentSchema } from '@lostgradient/weft';

import { fromWeftDocument, toWeftDocumentInput } from './workflow-document-handlers';
import { workflowVersionOf } from './workflow-file';

export const WORKFLOW_SNAPSHOT_KEY_PREFIX = 'bureau-workflow-snapshot:v1:';
export const WORKFLOW_CANCELLATION_KEY_PREFIX = 'bureau-workflow-cancelled-run:v1:';

/**
 * Why Bureau cancelled an instance it could not register before the engine recovered (see
 * `workflow-runtime.ts`). Weft's cancellation carries no reason, so the reason is kept here and
 * read back by `bureau.workflows.runs.get`, which is how an operator learns what happened.
 */
export interface WorkflowRunCancellation {
  readonly schemaVersion: 1;
  /**
   * Present when the instance was cancelled because a contributed activity its revision pins is
   * not loaded (COR-1874): the same verdict the versioned catalog gives a resolution.
   */
  readonly pin?: WorkflowRunPinProblem;
  readonly runId: string;
  /** The workflow's identifier. */
  readonly id: string;
  readonly workflowVersion: string;
  readonly reason: string;
  readonly cancelledAt: string;
}

/**
 * Why a revision's pinned activity cannot be resolved: `missing` when no version of the activity is
 * loaded, `version-mismatch` when only other versions are. Never answered by another version.
 */
export interface WorkflowRunPinProblem {
  /** `missing` when no version of the activity is loaded, `version-mismatch` when only others are. */
  readonly reason: 'missing' | 'version-mismatch';
  /** The pinned activity, as `plugin:name@version`. */
  readonly activity: string;
  /** The versions of the activity that are loaded; empty for `missing`. */
  readonly availableVersions: readonly string[];
}

/** A document as Bureau registered it with the engine. */
export interface WorkflowSnapshot {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workflowVersion: string;
  /** When Bureau first registered this revision. */
  readonly registeredAt: string;
  /** When an instance of this revision first started; absent until one has. */
  readonly firstRunAt?: string;
  /** When an instance of this revision most recently started. */
  readonly lastRunAt?: string;
  readonly document: WorkflowDocument;
}

/** One entry of `revisions(id)`: a snapshot that has run. */
export interface WorkflowRevision {
  readonly id: string;
  readonly workflowVersion: string;
  readonly firstRunAt: string;
  readonly lastRunAt: string;
  readonly document: WorkflowDocument;
}

/** A stored snapshot that cannot be used. */
export class WorkflowSnapshotError extends Error {
  readonly code = 'snapshot-unresolvable';
  readonly workflowId: string;
  readonly workflowVersion: string;
  /**
   * `true` when the record is not damaged but holds a key this Bureau does not know, which a newer
   * Bureau wrote (COR-1927). Such a record is that Bureau's to use, so this one leaves it alone.
   */
  readonly unrecognizedKeys: boolean;

  constructor(
    workflowId: string,
    workflowVersion: string,
    message: string,
    options: { readonly unrecognizedKeys?: boolean } = {},
  ) {
    super(message);
    this.name = 'WorkflowSnapshotError';
    this.workflowId = workflowId;
    this.workflowVersion = workflowVersion;
    this.unrecognizedKeys = options.unrecognizedKeys === true;
  }
}

export interface WorkflowSnapshotStore {
  /** Store the snapshot of `document` if it is absent. */
  readonly ensure: (id: string, document: WorkflowDocument) => Promise<void>;
  /**
   * The snapshot for `id` at `workflowVersion`, or `undefined` when there is none. One that is
   * stored but not valid throws {@link WorkflowSnapshotError}.
   */
  readonly load: (id: string, workflowVersion: string) => Promise<WorkflowSnapshot | undefined>;
  /** Every identifier that has a snapshot or a cancelled instance. */
  readonly identifiers: () => Promise<readonly string[]>;
  /** Record that Bureau cancels `runId`, before it does. */
  readonly recordCancellation: (cancellation: WorkflowRunCancellation) => Promise<void>;
  /** The reason Bureau cancelled `runId`, or `undefined` when it did not. */
  readonly cancellationOf: (runId: string) => Promise<WorkflowRunCancellation | undefined>;
  /** The valid snapshots of `id`, whether or not they have run. */
  readonly snapshotsOf: (id: string) => Promise<readonly WorkflowSnapshot[]>;
  /** Record that an instance of this revision started at `at`. A revision with no snapshot is ignored. */
  readonly stampRun: (id: string, workflowVersion: string, at: string) => Promise<void>;
  /** The snapshots of `id` that have run, most recently run first. */
  readonly revisions: (id: string) => Promise<readonly WorkflowRevision[]>;
  /**
   * Delete every snapshot `isHeld` does not hold whose last activity, as `lastActivityAt` reports
   * it, is before `cutoff` (epoch milliseconds). Resolves how many it deleted.
   *
   * A record that names the workflow of an instance still in flight, as `hasInFlight` reports it,
   * is never deleted, however old or unreadable: it is the last trace Bureau has of that workflow,
   * and without it the next boot cannot cancel the instance with a reason (COR-1583). That covers
   * a snapshot record that cannot be read and a cancellation record.
   */
  readonly pruneUnheld: (options: {
    readonly cutoff: number;
    readonly isHeld: (snapshot: WorkflowSnapshot) => boolean | Promise<boolean>;
    readonly hasInFlight: (id: string) => boolean | Promise<boolean>;
    readonly lastActivityAt: (snapshot: WorkflowSnapshot) => Promise<number | undefined>;
  }) => Promise<number>;
}

export interface WorkflowSnapshotStoreOptions {
  /** Where the records live. Omit for a store that lasts as long as the process. */
  readonly store?: TextValueStore | undefined;
  readonly nowISO: () => string;
}

function snapshotKey(id: string, workflowVersion: string): string {
  return `${WORKFLOW_SNAPSHOT_KEY_PREFIX}${id}:${workflowVersion}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Parsed =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid'; readonly reason: string; readonly unrecognizedKeys?: true }
  | { readonly kind: 'ok'; readonly snapshot: WorkflowSnapshot };

function parseSnapshot(text: string | null, id: string, workflowVersion: string): Parsed {
  if (text === null) return { kind: 'absent' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: 'invalid', reason: 'it is not JSON' };
  }
  if (
    !isRecord(value) ||
    value['schemaVersion'] !== 1 ||
    value['id'] !== id ||
    value['workflowVersion'] !== workflowVersion ||
    typeof value['registeredAt'] !== 'string' ||
    (value['firstRunAt'] !== undefined && typeof value['firstRunAt'] !== 'string') ||
    (value['lastRunAt'] !== undefined && typeof value['lastRunAt'] !== 'string')
  ) {
    return { kind: 'invalid', reason: 'it is not a workflow snapshot for this key' };
  }
  // A stored document is in Bureau's form; Weft's schema judges its names in Weft's.
  const document = workflowDocumentSchema.safeParse(toWeftDocumentInput(value['document']));
  if (!document.success) {
    // Read from the validator's issue codes, not its text: a record a newer Bureau wrote carries a
    // key this one does not know, which is not the same as a record that is damaged (COR-1927).
    const unrecognized = document.error.issues.some((issue) => issue.code === 'unrecognized_keys');
    return {
      kind: 'invalid',
      reason: unrecognized
        ? 'its document has a key this Bureau does not know'
        : 'its document is not valid',
      ...(unrecognized ? { unrecognizedKeys: true as const } : {}),
    };
  }
  const stored = fromWeftDocument(document.data as WorkflowDocument);
  if (workflowVersionOf(stored) !== workflowVersion) {
    return { kind: 'invalid', reason: 'its document does not hash to its key' };
  }
  return {
    kind: 'ok',
    snapshot: {
      schemaVersion: 1,
      id,
      workflowVersion,
      registeredAt: value['registeredAt'],
      ...(typeof value['firstRunAt'] === 'string' ? { firstRunAt: value['firstRunAt'] } : {}),
      ...(typeof value['lastRunAt'] === 'string' ? { lastRunAt: value['lastRunAt'] } : {}),
      document: stored,
    },
  };
}

function parseCancellation(text: string | null): WorkflowRunCancellation | undefined {
  if (text === null) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (
      isRecord(value) &&
      value['schemaVersion'] === 1 &&
      typeof value['runId'] === 'string' &&
      typeof value['id'] === 'string' &&
      typeof value['workflowVersion'] === 'string' &&
      typeof value['reason'] === 'string' &&
      typeof value['cancelledAt'] === 'string'
    ) {
      return value as unknown as WorkflowRunCancellation;
    }
  } catch {
    // A record that is not JSON is not a cancellation.
  }
  return undefined;
}

export function createWorkflowSnapshotStore(
  options: WorkflowSnapshotStoreOptions,
): WorkflowSnapshotStore {
  const store = options.store ?? textValueStore(new MemoryStorage());
  let tail: Promise<unknown> = Promise.resolve();
  /** One at a time in this process, so a prune never races an ensure or a stamp. */
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  }

  /** The id and version a key names, or `undefined` for a key that is not a snapshot's. */
  function splitKey(key: string): { id: string; workflowVersion: string } | undefined {
    if (!key.startsWith(WORKFLOW_SNAPSHOT_KEY_PREFIX)) return undefined;
    const rest = key.slice(WORKFLOW_SNAPSHOT_KEY_PREFIX.length);
    // A version is `sha256:<hex>` and an id may hold a colon (`plugin:name`), so split before the algorithm.
    const separator = rest.indexOf(':sha256:');
    if (separator <= 0) return undefined;
    return { id: rest.slice(0, separator), workflowVersion: rest.slice(separator + 1) };
  }

  async function read(id: string, workflowVersion: string): Promise<Parsed> {
    return parseSnapshot(await store.get(snapshotKey(id, workflowVersion)), id, workflowVersion);
  }

  async function validSnapshotsOf(id: string): Promise<WorkflowSnapshot[]> {
    const found: WorkflowSnapshot[] = [];
    for (const key of await store.list(`${WORKFLOW_SNAPSHOT_KEY_PREFIX}${id}:`)) {
      const named = splitKey(key);
      if (named === undefined || named.id !== id) continue;
      const parsed = await read(id, named.workflowVersion);
      if (parsed.kind === 'ok') found.push(parsed.snapshot);
    }
    return found;
  }

  return {
    ensure(id, document) {
      const workflowVersion = workflowVersionOf(document);
      return exclusive(async () => {
        const existing = await read(id, workflowVersion);
        if (existing.kind === 'ok') return;
        const snapshot: WorkflowSnapshot = {
          schemaVersion: 1,
          id,
          workflowVersion,
          registeredAt: options.nowISO(),
          document,
        };
        await store.set(snapshotKey(id, workflowVersion), JSON.stringify(snapshot));
      });
    },

    async load(id, workflowVersion) {
      const parsed = await read(id, workflowVersion);
      if (parsed.kind === 'invalid') {
        throw new WorkflowSnapshotError(
          id,
          workflowVersion,
          `The stored snapshot of workflow "${id}" at ${workflowVersion} cannot be used: ${parsed.reason}.`,
          { unrecognizedKeys: parsed.unrecognizedKeys === true },
        );
      }
      return parsed.kind === 'ok' ? parsed.snapshot : undefined;
    },

    async identifiers() {
      const found = new Set<string>();
      for (const key of await store.list(WORKFLOW_SNAPSHOT_KEY_PREFIX)) {
        const named = splitKey(key);
        if (named !== undefined) found.add(named.id);
      }
      for (const key of await store.list(WORKFLOW_CANCELLATION_KEY_PREFIX)) {
        const cancellation = parseCancellation(await store.get(key));
        if (cancellation !== undefined) found.add(cancellation.id);
      }
      return [...found].toSorted();
    },

    async recordCancellation(cancellation) {
      await store.set(
        `${WORKFLOW_CANCELLATION_KEY_PREFIX}${cancellation.runId}`,
        JSON.stringify(cancellation),
      );
    },

    async cancellationOf(runId) {
      return parseCancellation(await store.get(`${WORKFLOW_CANCELLATION_KEY_PREFIX}${runId}`));
    },

    snapshotsOf: validSnapshotsOf,

    stampRun(id, workflowVersion, at) {
      return exclusive(async () => {
        const parsed = await read(id, workflowVersion);
        if (parsed.kind !== 'ok') return;
        const { snapshot } = parsed;
        const lastRunAt =
          snapshot.lastRunAt === undefined || snapshot.lastRunAt < at ? at : snapshot.lastRunAt;
        const firstRunAt =
          snapshot.firstRunAt === undefined || at < snapshot.firstRunAt ? at : snapshot.firstRunAt;
        if (firstRunAt === snapshot.firstRunAt && lastRunAt === snapshot.lastRunAt) return;
        await store.set(
          snapshotKey(id, workflowVersion),
          JSON.stringify({ ...snapshot, firstRunAt, lastRunAt } satisfies WorkflowSnapshot),
        );
      });
    },

    async revisions(id) {
      const snapshots = await validSnapshotsOf(id);
      return snapshots
        .flatMap((snapshot): WorkflowRevision[] =>
          snapshot.lastRunAt === undefined || snapshot.firstRunAt === undefined
            ? []
            : [
                {
                  id: snapshot.id,
                  workflowVersion: snapshot.workflowVersion,
                  firstRunAt: snapshot.firstRunAt,
                  lastRunAt: snapshot.lastRunAt,
                  document: snapshot.document,
                },
              ],
        )
        .toSorted(
          (left, right) =>
            right.lastRunAt.localeCompare(left.lastRunAt) ||
            right.firstRunAt.localeCompare(left.firstRunAt) ||
            right.workflowVersion.localeCompare(left.workflowVersion),
        );
    },

    pruneUnheld({ cutoff, isHeld, hasInFlight, lastActivityAt }) {
      return exclusive(async () => {
        let removed = 0;
        for (const key of await store.list(WORKFLOW_SNAPSHOT_KEY_PREFIX)) {
          const named = splitKey(key);
          if (named === undefined) continue;
          const parsed = await read(named.id, named.workflowVersion);
          // A record that cannot be read is not a snapshot anything can resume from, so it goes,
          // unless an instance of its workflow is still in flight: the identifier its key names is
          // then the only trace left of that instance.
          if (parsed.kind === 'invalid') {
            if (await hasInFlight(named.id)) continue;
            await store.delete(key);
            removed += 1;
            continue;
          }
          if (parsed.kind !== 'ok') continue;
          const { snapshot } = parsed;
          if (await isHeld(snapshot)) continue;
          const engineActivity = await lastActivityAt(snapshot);
          const own = Math.max(
            Date.parse(snapshot.registeredAt),
            snapshot.lastRunAt === undefined ? 0 : Date.parse(snapshot.lastRunAt),
            engineActivity ?? 0,
          );
          if (!(own < cutoff)) continue;
          await store.delete(key);
          removed += 1;
        }
        // A cancellation record lives as long as the snapshots do: it keeps the run readable, and
        // while an instance of its workflow is still in flight (a cancel that kept failing) it is
        // also the trace the next boot cancels that instance from.
        for (const key of await store.list(WORKFLOW_CANCELLATION_KEY_PREFIX)) {
          const cancellation = parseCancellation(await store.get(key));
          if (cancellation !== undefined) {
            if (!(Date.parse(cancellation.cancelledAt) < cutoff)) continue;
            if (await hasInFlight(cancellation.id)) continue;
          }
          await store.delete(key);
        }
        return removed;
      });
    },
  };
}
