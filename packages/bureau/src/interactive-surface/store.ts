/**
 * COR-1631 — the lifecycle of interactive surfaces: create, compare-and-swap
 * update, snapshot, action admission, close, owner-cancellation freeze, and
 * cleanup, kept in the task's durable history.
 *
 * Every change is one durable event in the task's history (owner
 * `{ kind: 'run', id: taskId }`), appended in the same storage batch as the
 * surface's projection: the batch requires the projection to still read what
 * the command was checked against, so two changes racing from one revision
 * cannot both commit, and the history and the projection never disagree. The
 * projection is what a snapshot reads in one storage read; the history is
 * what a subscriber replays. Each surface also keeps a small cursor record,
 * written after the batch, naming the event that committed its latest
 * revision (see the contract's Event durability section).
 */
import { sha256HexSync } from '@lostgradient/cryptography';
import type { CleanupAcknowledgement } from '@lostgradient/operative';
import {
  type BatchOperation,
  type ConditionalBatchCondition,
  type ConditionalTextValueStore,
  encodeStorageKeyComponent,
  type Storage,
  textValueStore,
} from '@lostgradient/weft';

import type { DurableEventHistory } from '../durable-event-history';
import {
  type AbortInteractiveSurfacesCommand,
  type AbortInteractiveSurfacesReceipt,
  type CloseInteractiveSurfaceCommand,
  type CloseInteractiveSurfaceReceipt,
  type CreateInteractiveSurfaceCommand,
  type CreateInteractiveSurfaceReceipt,
  INTERACTIVE_SURFACE_CONTRACT_VERSION,
  INTERACTIVE_SURFACE_MAX_PAYLOAD_BYTES,
  type InteractiveSurface,
  type InteractiveSurfaceAcceptance,
  type InteractiveSurfaceActionAdmission,
  type InteractiveSurfaceActionDefinition,
  type InteractiveSurfaceActionReceipt,
  type InteractiveSurfaceActionRequest,
  type InteractiveSurfaceAuthorization,
  type InteractiveSurfaceCleanupQuery,
  type InteractiveSurfaceCleanupReceipt,
  type InteractiveSurfaceCloseReason,
  type InteractiveSurfaceJsonValue,
  type InteractiveSurfaceRejection,
  type InteractiveSurfaceRejectionReason,
  type InteractiveSurfaceSnapshotQuery,
  type InteractiveSurfaceSnapshotReceipt,
  type UpdateInteractiveSurfaceCommand,
  type UpdateInteractiveSurfaceReceipt,
} from './types';
import {
  actionValueSchema,
  assertContractVersion,
  assertKnownFields,
  assertWithinPayloadLimit,
  InteractiveSurfaceSchemaCompiler,
  InteractiveSurfaceValidationError,
  isPlainObject,
  readActions,
  detach,
  readAudience,
  MAX_COMPOSITE_IDENTIFIER_LENGTH,
  readIdentifier,
  readJsonValue,
  readRepresentation,
  readSummary,
} from './validation';

/** The storage-key prefix of every surface record. */
export const INTERACTIVE_SURFACE_KEY_PREFIX = 'bureau-surface:v1:';

/** The durable event kinds a surface's changes are recorded as, in its task's history. */
export const INTERACTIVE_SURFACE_EVENT_KINDS = {
  created: 'surface.created',
  updated: 'surface.updated',
  actionAdmitted: 'surface.action.admitted',
  closed: 'surface.closed',
  frozen: 'surface.frozen',
} as const;

/** How many recent commands a surface remembers for exact-retry replay. */
const REMEMBERED_COMMANDS = 64;

/** How many times a command re-reads and retries after losing a race it did not lose on revision. */
const MAX_COMMIT_ATTEMPTS = 5;

/** What the surface store needs to know about a task. */
export interface InteractiveSurfaceTask {
  /** The task's owner of record. */
  readonly owner: string;
  /** How the task ended, once it has. */
  readonly settled?: 'completed' | 'failed' | 'canceled' | undefined;
  /** The session the task runs in, which a `signal` continuation must name. */
  readonly contextId?: string | undefined;
  /**
   * Tells reuses of one task id apart: a session deleted and recreated under
   * its id reuses its run ids. A removal fences only its own generation.
   */
  readonly generation?: string | undefined;
}

/** Options for {@link createInteractiveSurfaces}. */
export interface InteractiveSurfacesOptions {
  /** The storage the history writes to; the surface records live beside its events. */
  readonly storage: Storage;
  readonly history: DurableEventHistory;
  /** Looks up a task; `undefined` for a task that does not exist. */
  readonly task: (taskId: string) => Promise<InteractiveSurfaceTask | undefined>;
  /** Epoch milliseconds. */
  readonly now: () => number;
  /** The cap on a surface's content; {@link INTERACTIVE_SURFACE_MAX_PAYLOAD_BYTES} by default. */
  readonly maxPayloadBytes?: number | undefined;
  /**
   * Calls `listener` once when the task settles in this process. The store
   * watches each task it creates a surface on, so the task's surfaces freeze
   * as it ends; a settlement it does not see (another process's, or one before
   * a restart) freezes them when they are next read.
   */
  readonly watchTask?:
    | ((taskId: string, listener: (status: 'completed' | 'failed' | 'canceled') => void) => void)
    | undefined;
  /** Hears a freeze that failed after its task settled; the next read retries it. */
  readonly onFreezeError?: ((taskId: string, error: unknown) => void) | undefined;
  /**
   * The ids of the reviews a task holds open. When given, a review continuation
   * must name one of them, which is the authority on which run a review belongs
   * to; without it, the review id's grammar decides (see `assertOwnContinuations`).
   */
  readonly reviewIdsOf?: ((taskId: string) => Promise<ReadonlySet<string>>) | undefined;
}

/**
 * Bureau's interactive surfaces. Every method answers with a typed receipt and
 * never throws for a refused command; it throws only when storage fails.
 */
export interface InteractiveSurfaces {
  create(
    command: CreateInteractiveSurfaceCommand,
    authorization?: InteractiveSurfaceAuthorization,
  ): Promise<CreateInteractiveSurfaceReceipt>;
  update(
    command: UpdateInteractiveSurfaceCommand,
    authorization?: InteractiveSurfaceAuthorization,
  ): Promise<UpdateInteractiveSurfaceReceipt>;
  snapshot(
    query: InteractiveSurfaceSnapshotQuery,
    authorization?: InteractiveSurfaceAuthorization,
  ): Promise<InteractiveSurfaceSnapshotReceipt>;
  /**
   * Admits or denies an action. An admitted action is recorded in the task's
   * history and returned with its continuation, which the caller runs
   * (`reviews.resolve` or `signalSession`); a denied one commits nothing.
   */
  act(
    request: InteractiveSurfaceActionRequest,
    authorization?: InteractiveSurfaceAuthorization,
  ): Promise<InteractiveSurfaceActionReceipt>;
  close(
    command: CloseInteractiveSurfaceCommand,
    authorization?: InteractiveSurfaceAuthorization,
  ): Promise<CloseInteractiveSurfaceReceipt>;
  /**
   * Every surface of a task that the caller may see, oldest first, as `snapshot` would read each.
   * A task the caller cannot reach has none.
   */
  list(
    taskId: string,
    authorization?: InteractiveSurfaceAuthorization,
  ): Promise<readonly InteractiveSurface[]>;
  /** Freezes every open surface of a task, closed as `cancelled`. */
  abort(
    command: AbortInteractiveSurfacesCommand,
    authorization?: InteractiveSurfaceAuthorization,
  ): Promise<AbortInteractiveSurfacesReceipt>;
  cleanup(
    query: InteractiveSurfaceCleanupQuery,
    authorization?: InteractiveSurfaceAuthorization,
  ): Promise<InteractiveSurfaceCleanupReceipt>;
  /**
   * Freezes every open surface of a task that has ended: `cancelled` for a
   * cancelled task, `task-ended` otherwise. Resolves the cleanup evidence.
   */
  settleTask(
    taskId: string,
    status: 'completed' | 'failed' | 'canceled',
  ): Promise<CleanupAcknowledgement>;
  /**
   * The cleanup evidence of a task's surfaces: resolves once the task has
   * settled and every one of its surfaces is frozen or closed (`completed`),
   * at once when it has none (`not-required`), and `failed` when a freeze
   * could not be written. `signal` bounds this caller's wait, resolving
   * `unresolved` (`timed-out`) when it aborts first.
   */
  closed(
    taskId: string,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<CleanupAcknowledgement>;
  /** Deletes every record of a task's surfaces, as the task's retention ends. */
  removeTask(taskId: string): Promise<void>;
  /** Resolves once every settlement freeze now in flight has landed (or failed). Shutdown awaits it. */
  flush(): Promise<void>;
}

/** A command the surface remembers, so an exact retry returns its original receipt. */
interface RememberedCommand {
  readonly commandId: string;
  readonly digest: string;
  /** The surface revision the command produced, or was admitted against. */
  readonly revision: number;
  /**
   * For an admitted action, its admission without the value: the projection
   * never stores an action's value (a sensitive surface's least of all), and
   * an exact retry carries the same value, which its digest proves.
   */
  readonly admission?: Omit<InteractiveSurfaceActionAdmission, 'value'> | undefined;
}

/** The projection record, as stored. */
interface StoredSurface {
  readonly schemaVersion: 1;
  readonly surface: InteractiveSurface;
  readonly commands: readonly RememberedCommand[];
}

/** The cursor record, as stored. */
interface StoredCursor {
  readonly revision: number;
  readonly cursor: string;
}

type Loaded = { readonly text: string; readonly stored: StoredSurface } | undefined;

function rejection(
  reason: InteractiveSurfaceRejectionReason,
  detail?: string,
  currentRevision?: number,
): InteractiveSurfaceRejection {
  return {
    contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
    outcome: 'rejected',
    reason,
    ...(detail === undefined ? {} : { detail }),
    ...(currentRevision === undefined ? {} : { currentRevision }),
  };
}

function isRejection(value: unknown): value is InteractiveSurfaceRejection {
  return isPlainObject(value) && value['outcome'] === 'rejected';
}

/** JSON with object keys sorted, so a digest does not depend on key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .toSorted();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digestOf(value: unknown): string {
  return `sha256:${sha256HexSync(canonicalJson(value))}`;
}

const REMOVAL_MARKER_PREFIX = 'bureau-removed-surfaces:v1:';

/**
 * How long a removal marker is kept: far longer than any command takes to commit, which retries a
 * bounded number of times, so a command checked before the removal has long since failed or landed.
 */
const REMOVAL_MARKER_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1000;

/** How often a removal sweeps the markers: an hour, so a removal costs a read of the set only now and then. */
const REMOVAL_MARKER_SWEEP_INTERVAL_MILLISECONDS = 60 * 60 * 1000;

/**
 * Marks a task whose surfaces were removed. It lives outside the task's prefix,
 * so removing the prefix keeps it, and every commit is conditioned on its
 * absence: a command checked before the removal cannot write after it.
 */
function removedKey(taskId: string, generation: string): string {
  return `${REMOVAL_MARKER_PREFIX}${encodeStorageKeyComponent(taskId)}:${encodeStorageKeyComponent(generation)}`;
}

function surfacePrefix(taskId: string): string {
  return `${INTERACTIVE_SURFACE_KEY_PREFIX}${encodeStorageKeyComponent(taskId)}:`;
}

function surfaceKey(taskId: string, surfaceId: string): string {
  return `${surfacePrefix(taskId)}surface:${encodeStorageKeyComponent(surfaceId)}`;
}

function cursorKey(taskId: string, surfaceId: string): string {
  return `${surfacePrefix(taskId)}cursor:${encodeStorageKeyComponent(surfaceId)}`;
}

function remember(
  commands: readonly RememberedCommand[],
  entry: RememberedCommand,
): readonly RememberedCommand[] {
  return [...commands, entry].slice(-REMEMBERED_COMMANDS);
}

function withoutValue(
  admission: InteractiveSurfaceActionAdmission,
): Omit<InteractiveSurfaceActionAdmission, 'value'> {
  const { value: _value, ...rest } = admission;
  return rest;
}

/**
 * Fails unless every action continues this task: a review this task holds, or
 * a signal to this task's own session. A surface's author may be the model, so
 * a continuation naming another task is refused here rather than handed to the
 * caller to dispatch.
 *
 * Both a run id and a wait's signal name can hold colons, so no grammar can say
 * which run a review id names. `reviewIdsOf` is the authority when it is given:
 * the review must be one the task holds open. Without it (a store used on its
 * own), the review id must read `approval:<taskId>:<callId>` or
 * `human-wait:<taskId>:<signalName>:<ordinal>` with no colon in the call id or
 * signal name, and anything else is refused rather than guessed at.
 */
async function assertOwnContinuations(
  actions: readonly InteractiveSurfaceActionDefinition[],
  taskId: string,
  task: InteractiveSurfaceTask,
  reviewIdsOf: ((taskId: string) => Promise<ReadonlySet<string>>) | undefined,
): Promise<void> {
  let held: ReadonlySet<string> | undefined;
  for (const action of actions) {
    const continuation = action.continuation;
    if (continuation.type === 'review') {
      const reviewId = continuation.reviewId;
      let own: boolean;
      if (reviewIdsOf === undefined) {
        const approval = `approval:${taskId}:`;
        const wait = `human-wait:${taskId}:`;
        own =
          (reviewId.startsWith(approval) && /^[^:]+$/.test(reviewId.slice(approval.length))) ||
          (reviewId.startsWith(wait) && /^[^:]+:\d+$/.test(reviewId.slice(wait.length)));
      } else {
        held ??= await reviewIdsOf(taskId);
        own = held.has(reviewId);
      }
      if (!own) {
        throw new InteractiveSurfaceValidationError(
          `action "${action.name}" continues a review this task does not hold`,
        );
      }
    } else if (task.contextId === undefined || continuation.sessionId !== task.contextId) {
      throw new InteractiveSurfaceValidationError(
        `action "${action.name}" signals a session that is not this task's`,
      );
    }
  }
}

/**
 * Whether an ISO 8601 date-time names a real calendar date and time of day:
 * `Date.parse` normalizes `2023-02-29` to March 1 rather than refusing it.
 */
function isCalendarDateTime(value: string): boolean {
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    hour < 24 &&
    minute < 60 &&
    second < 60
  );
}

/** An action's A2UI provenance: the component that raised it and when, each optional. */
function readActionProvenance(record: Record<string, unknown>): {
  sourceComponentId?: string;
  timestamp?: string;
} {
  const source = record['sourceComponentId'];
  const timestamp = record['timestamp'];
  if (
    timestamp !== undefined &&
    (typeof timestamp !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) ||
      Number.isNaN(Date.parse(timestamp)))
  ) {
    throw new InteractiveSurfaceValidationError('timestamp must be an ISO 8601 date-time');
  }
  if (timestamp !== undefined && !isCalendarDateTime(timestamp)) {
    throw new InteractiveSurfaceValidationError('timestamp must name a real date and time');
  }
  return {
    ...(source === undefined
      ? {}
      : { sourceComponentId: readIdentifier(source, 'sourceComponentId') }),
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

/** Thrown inside a commit when the task's surfaces were removed; it answers `not-found`. */
class TaskRemoved extends Error {}

/** Thrown inside a commit when the projection moved; the caller re-reads. */
class LostRace extends Error {}

/** Builds the interactive surfaces of one Bureau over its durable history. */
export function createInteractiveSurfaces(
  options: InteractiveSurfacesOptions,
): InteractiveSurfaces {
  const store: ConditionalTextValueStore = textValueStore(options.storage, {
    disposeUnderlyingStorage: false,
  });
  const schemas = new InteractiveSurfaceSchemaCompiler();
  const maxPayloadBytes = options.maxPayloadBytes ?? INTERACTIVE_SURFACE_MAX_PAYLOAD_BYTES;
  const isoNow = (): string => new Date(options.now()).toISOString();
  let nextMarkerSweepAt = 0;

  async function load(taskId: string, surfaceId: string): Promise<Loaded> {
    const text = await store.get(surfaceKey(taskId, surfaceId));
    if (text === null) return undefined;
    return { text, stored: JSON.parse(text) as StoredSurface };
  }

  async function readCursor(taskId: string, surfaceId: string): Promise<StoredCursor | undefined> {
    const text = await store.get(cursorKey(taskId, surfaceId));
    return text === null ? undefined : (JSON.parse(text) as StoredCursor);
  }

  /**
   * Records the committing event's cursor, unless a later revision already
   * has, and only while the stored surface is still at `surface`'s revision.
   * The fence is the revision, not the projection's text: an action admitted
   * meanwhile changes the text but not the revision, and the cursor still
   * belongs to it, while a later commit or the task's removal makes this
   * write stale, so a removal can never be followed by a cursor.
   */
  async function writeCursor(surface: InteractiveSurface, cursor: string): Promise<void> {
    const key = cursorKey(surface.taskId, surface.surfaceId);
    const projection = surfaceKey(surface.taskId, surface.surfaceId);
    const next = JSON.stringify({ revision: surface.revision, cursor } satisfies StoredCursor);
    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
      const recorded = await store.get(key);
      if (
        recorded !== null &&
        (JSON.parse(recorded) as StoredCursor).revision >= surface.revision
      ) {
        return;
      }
      const stored = await store.get(projection);
      if (
        stored === null ||
        (JSON.parse(stored) as StoredSurface).surface.revision !== surface.revision
      ) {
        return;
      }
      if (
        await store.conditionalBatch(
          [
            { key, expectedValue: recorded },
            { key: projection, expectedValue: stored },
          ],
          [{ type: 'put', key, value: next }],
        )
      ) {
        return;
      }
    }
  }

  async function withCursor(surface: InteractiveSurface): Promise<InteractiveSurface> {
    const cursor = await readCursor(surface.taskId, surface.surfaceId);
    return {
      ...surface,
      eventCursor:
        cursor !== undefined && cursor.revision === surface.revision ? cursor.cursor : null,
    };
  }

  /**
   * Appends `kind` to the task's history in one batch with the projection
   * write, conditioned on the projection still reading `expected`. Throws
   * {@link LostRace} when it no longer does.
   */
  async function commit(
    taskId: string,
    surfaceId: string,
    expected: string | null,
    next: StoredSurface,
    kind: string,
    payload: unknown,
    advancesRevision = true,
  ): Promise<string> {
    const key = surfaceKey(taskId, surfaceId);
    // The fence of the task's current generation: a reused task id is a new task.
    const owner = await options.task(taskId);
    if (owner === undefined) throw new TaskRemoved();
    const fence = removedKey(taskId, owner.generation ?? '');
    const conditions: ConditionalBatchCondition[] = [
      { key, expectedValue: expected === null ? null : new TextEncoder().encode(expected) },
      { key: fence, expectedValue: null },
    ];
    const operations: BatchOperation[] = [
      { type: 'put', key, value: new TextEncoder().encode(JSON.stringify(next)) },
    ];
    let cursor: string;
    try {
      const envelope = await options.history.record({ kind: 'run', id: taskId }, kind, payload, {
        conditions,
        operations,
      });
      cursor = envelope.cursor;
    } catch (error: unknown) {
      if ((await store.get(fence)) !== null) throw new TaskRemoved();
      if ((await store.get(key)) !== expected) throw new LostRace();
      throw error;
    }
    // Only an event that committed a revision names that revision's cursor.
    if (advancesRevision) await writeCursor(next.surface, cursor);
    return cursor;
  }

  /** The task, or a `not-found` rejection when the caller may not reach it. */
  async function reachTask(
    taskId: string,
    authorization: InteractiveSurfaceAuthorization,
  ): Promise<InteractiveSurfaceTask | InteractiveSurfaceRejection> {
    if (authorization.taskId !== undefined && authorization.taskId !== taskId) {
      return rejection('not-found');
    }
    const task = await options.task(taskId);
    if (task === undefined) return rejection('not-found');
    return task;
  }

  function mayChange(
    task: InteractiveSurfaceTask,
    authorization: InteractiveSurfaceAuthorization,
  ): boolean {
    return authorization.principal === undefined || authorization.principal === task.owner;
  }

  function maySee(
    surface: InteractiveSurface,
    authorization: InteractiveSurfaceAuthorization,
  ): boolean {
    const principal = authorization.principal;
    return (
      principal === undefined || principal === surface.owner || surface.audience.includes(principal)
    );
  }

  function frozen(
    surface: InteractiveSurface,
    reason: Extract<InteractiveSurfaceCloseReason, 'cancelled' | 'task-ended'>,
  ): InteractiveSurface {
    const at = isoNow();
    return {
      ...surface,
      revision: surface.revision + 1,
      state: 'closed',
      liveness: 'frozen',
      closeResult: { reason, closedAt: at },
      updatedAt: at,
      eventCursor: null,
    };
  }

  /**
   * Freezes one surface if it is still open. Resolves `frozen` when this call
   * committed the freeze, `closed` when the surface was already closed or gone,
   * and `contended` when it kept changing underneath every attempt.
   */
  async function freezeOne(
    taskId: string,
    surfaceId: string,
    reason: Extract<InteractiveSurfaceCloseReason, 'cancelled' | 'task-ended'>,
    commandId: string,
  ): Promise<'frozen' | 'closed' | 'contended'> {
    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
      const loaded = await load(taskId, surfaceId);
      if (loaded === undefined) return 'closed';
      if (loaded.stored.surface.state === 'closed') return 'closed';
      const surface = frozen(loaded.stored.surface, reason);
      try {
        await commit(
          taskId,
          surfaceId,
          loaded.text,
          { ...loaded.stored, surface },
          INTERACTIVE_SURFACE_EVENT_KINDS.frozen,
          {
            contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
            surfaceId,
            revision: surface.revision,
            commandId,
            closeResult: surface.closeResult,
          },
        );
        return 'frozen';
      } catch (error: unknown) {
        // A removed task's surfaces are gone, which is as closed as they get.
        if (error instanceof TaskRemoved) return 'closed';
        if (!(error instanceof LostRace)) throw error;
      }
    }
    return 'contended';
  }

  async function surfaceIdsOf(taskId: string): Promise<string[]> {
    const prefix = `${surfacePrefix(taskId)}surface:`;
    const keys = await store.list(prefix);
    return keys.map((key) => decodeURIComponent(key.slice(prefix.length)));
  }

  async function freezeTask(
    taskId: string,
    reason: Extract<InteractiveSurfaceCloseReason, 'cancelled' | 'task-ended'>,
    commandId: string,
  ): Promise<{ readonly frozen: number; readonly cleanup: CleanupAcknowledgement }> {
    const surfaceIds = await surfaceIdsOf(taskId);
    if (surfaceIds.length === 0) return { frozen: 0, cleanup: { status: 'not-required' } };
    let count = 0;
    let failure: unknown;
    for (const surfaceId of surfaceIds) {
      try {
        const outcome = await freezeOne(taskId, surfaceId, reason, commandId);
        if (outcome === 'contended') {
          failure ??= new Error(`surface "${surfaceId}" kept changing while it was being frozen`);
        } else if (outcome === 'frozen') {
          count += 1;
        }
      } catch (error: unknown) {
        failure ??= error;
      }
    }
    return {
      frozen: count,
      cleanup:
        failure === undefined ? { status: 'completed' } : { status: 'failed', error: failure },
    };
  }

  /**
   * The surface, frozen first when its task has ended since it last changed
   * (a settlement this process did not see, or one before a restart).
   */
  async function current(
    task: InteractiveSurfaceTask,
    taskId: string,
    surfaceId: string,
  ): Promise<Loaded> {
    const loaded = await load(taskId, surfaceId);
    if (
      loaded === undefined ||
      loaded.stored.surface.state === 'closed' ||
      task.settled === undefined
    ) {
      return loaded;
    }
    // A freeze that cannot be written leaves the stored surface open; the
    // commands that change or act refuse an ended task on their own (see
    // `ended`), so what a snapshot reads is always what is stored.
    await freezeOne(
      taskId,
      surfaceId,
      task.settled === 'canceled' ? 'cancelled' : 'task-ended',
      `task-settled:${taskId}`,
    );
    return load(taskId, surfaceId);
  }

  /** Whether a command must treat the surface as closed: it is, or its task has ended. */
  function ended(task: InteractiveSurfaceTask, surface: InteractiveSurface): boolean {
    return surface.state === 'closed' || task.settled !== undefined;
  }

  function accepted(
    commandId: string,
    surface: InteractiveSurface,
    replayed: boolean,
    committedRevision: number = surface.revision,
  ): InteractiveSurfaceAcceptance {
    return {
      contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
      outcome: 'accepted',
      commandId,
      committedRevision,
      surface,
      replayed,
    };
  }

  /** The original receipt for an exact retry, `conflict` for a reused id, or `undefined`. */
  async function replay(
    stored: StoredSurface,
    commandId: string,
    digest: string,
  ): Promise<InteractiveSurfaceAcceptance | InteractiveSurfaceRejection | undefined> {
    const seen = stored.commands.find((entry) => entry.commandId === commandId);
    if (seen === undefined) return undefined;
    if (seen.digest !== digest) {
      return rejection('conflict', `commandId "${commandId}" was used for a different command`);
    }
    return accepted(commandId, await withCursor(stored.surface), true, seen.revision);
  }

  /** Runs `attempt` until it does not lose a race, or the attempt budget is spent. */
  /**
   * Runs a commit attempt again each time it loses its race. Admitted actions
   * change a surface without advancing its revision, so a command can keep
   * losing while it stays valid; after the last attempt it is refused as
   * `contended`, which a caller may retry, rather than thrown.
   */
  async function retrying<T>(attempt: () => Promise<T>): Promise<T | InteractiveSurfaceRejection> {
    for (let index = 1; index <= MAX_COMMIT_ATTEMPTS; index += 1) {
      try {
        return await attempt();
      } catch (error: unknown) {
        if (!(error instanceof LostRace)) throw error;
      }
    }
    return rejection('contended', 'the surface kept changing while the command was checked');
  }

  /** Runs a command body, mapping validation failures to their rejections. */
  async function guarded<T>(body: () => Promise<T>): Promise<T | InteractiveSurfaceRejection> {
    try {
      return await body();
    } catch (error: unknown) {
      if (error instanceof InteractiveSurfaceValidationError) {
        return rejection(error.reason, error.message);
      }
      if (error instanceof TaskRemoved) return rejection('not-found');
      throw error;
    }
  }

  function readBaseRevision(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new InteractiveSurfaceValidationError('baseRevision must be a positive integer');
    }
    return value;
  }

  function readCommandBase(command: unknown, type: string, extra: readonly string[]) {
    if (!isPlainObject(command))
      throw new InteractiveSurfaceValidationError('the command must be an object');
    // Detach from the caller's objects, so content cannot change between being
    // checked here and being committed after the awaits below.
    const record = detach(command);
    assertKnownFields(
      record,
      ['type', 'contractVersion', 'commandId', 'taskId', ...extra],
      'the command',
    );
    if (record['type'] !== type) {
      throw new InteractiveSurfaceValidationError(`type must be "${type}"`);
    }
    assertContractVersion(record['contractVersion']);
    return {
      record,
      commandId: readIdentifier(record['commandId'], 'commandId'),
      taskId: readIdentifier(record['taskId'], 'taskId', MAX_COMPOSITE_IDENTIFIER_LENGTH),
    };
  }

  function content(surface: InteractiveSurface) {
    return {
      representation: surface.representation,
      data: surface.data,
      summary: surface.summary,
      actions: surface.actions,
      audience: surface.audience,
    };
  }

  // ── create ────────────────────────────────────────────────────────

  async function create(
    command: CreateInteractiveSurfaceCommand,
    authorization: InteractiveSurfaceAuthorization = {},
  ): Promise<CreateInteractiveSurfaceReceipt> {
    return guarded(async () => {
      const { record, commandId, taskId } = readCommandBase(command, 'surface.create', [
        'surfaceId',
        'summary',
        'representation',
        'data',
        'actions',
        'audience',
        'classification',
      ]);
      const surfaceId = readIdentifier(record['surfaceId'], 'surfaceId');
      // Authorize before the costly checks (schema compilation) below.
      const task = await reachTask(taskId, authorization);
      if (isRejection(task)) return task;
      if (!mayChange(task, authorization)) return rejection('not-found');
      // Measured first: an oversized proposal is refused before its schemas are compiled.
      assertWithinPayloadLimit(
        {
          representation: record['representation'],
          data: record['data'],
          summary: record['summary'],
          actions: record['actions'],
          audience: record['audience'],
        },
        maxPayloadBytes,
      );
      const representation = readRepresentation(record['representation'], schemas);
      const data = record['data'] === undefined ? null : readJsonValue(record['data'], 'data');
      const summary = readSummary(record['summary']);
      const actions = readActions(record['actions'], schemas);
      const audience = readAudience(record['audience']);
      const classification =
        record['classification'] === undefined ? 'standard' : record['classification'];
      if (classification !== 'standard' && classification !== 'sensitive') {
        throw new InteractiveSurfaceValidationError(
          'classification must be "standard" or "sensitive"',
        );
      }
      assertWithinPayloadLimit(
        { representation, data, summary, actions, audience },
        maxPayloadBytes,
      );
      const digest = digestOf(record);

      // Watch before committing, so a settlement after this point freezes the new surface.
      watch(taskId);

      return retrying(async () => {
        // `current`, not `load`: a retry replays the surface as it stands, frozen
        // first when its task has ended, like every other read.
        const existing = await current(task, taskId, surfaceId);
        if (existing !== undefined) {
          return (
            (await replay(existing.stored, commandId, digest)) ??
            rejection('conflict', `surface "${surfaceId}" already exists`)
          );
        }
        if (task.settled !== undefined) return rejection('closed', 'the task has ended');
        // Ownership is checked only for a command not yet committed: an exact
        // retry replays above even after the review it named has resolved.
        await assertOwnContinuations(actions, taskId, task, options.reviewIdsOf);
        const at = isoNow();
        const surface: InteractiveSurface = {
          contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
          surfaceId,
          taskId,
          owner: task.owner,
          audience,
          kind: representation.kind,
          representation,
          data,
          summary,
          actions,
          classification,
          revision: 1,
          componentRevision: 1,
          dataRevision: 1,
          state: 'open',
          liveness: 'live',
          closeResult: null,
          createdAt: at,
          updatedAt: at,
          eventCursor: null,
        };
        const cursor = await commit(
          taskId,
          surfaceId,
          null,
          { schemaVersion: 1, surface, commands: [{ commandId, digest, revision: 1 }] },
          INTERACTIVE_SURFACE_EVENT_KINDS.created,
          { contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION, commandId, surface },
        );
        // Liveness is enforced when a surface is read, not here: a task that
        // settled while this create committed freezes the surface on its next
        // read (see `current`), and a deleted task's surfaces are unreachable.
        return accepted(commandId, { ...surface, eventCursor: cursor }, false);
      });
    });
  }

  // ── update ────────────────────────────────────────────────────────

  async function update(
    command: UpdateInteractiveSurfaceCommand,
    authorization: InteractiveSurfaceAuthorization = {},
  ): Promise<UpdateInteractiveSurfaceReceipt> {
    return guarded(async () => {
      const { record, commandId, taskId } = readCommandBase(command, 'surface.update', [
        'surfaceId',
        'baseRevision',
        'representation',
        'data',
        'summary',
        'actions',
      ]);
      const surfaceId = readIdentifier(record['surfaceId'], 'surfaceId');
      // Authorize before the costly checks (schema compilation) below.
      const task = await reachTask(taskId, authorization);
      if (isRejection(task)) return task;
      if (!mayChange(task, authorization)) return rejection('not-found');
      const baseRevision = readBaseRevision(record['baseRevision']);
      // Measured first: an oversized change is refused before its schemas are compiled.
      assertWithinPayloadLimit(
        {
          representation: record['representation'],
          data: record['data'],
          summary: record['summary'],
          actions: record['actions'],
        },
        maxPayloadBytes,
      );
      const changes = {
        ...(record['representation'] === undefined
          ? {}
          : { representation: readRepresentation(record['representation'], schemas) }),
        ...(record['data'] === undefined ? {} : { data: readJsonValue(record['data'], 'data') }),
        ...(record['summary'] === undefined ? {} : { summary: readSummary(record['summary']) }),
        ...(record['actions'] === undefined
          ? {}
          : { actions: readActions(record['actions'], schemas) }),
      };
      if (Object.keys(changes).length === 0) {
        throw new InteractiveSurfaceValidationError('an update must change something');
      }
      const digest = digestOf(record);

      return retrying(async () => {
        const loaded = await current(task, taskId, surfaceId);
        if (loaded === undefined) return rejection('not-found');
        const replayed = await replay(loaded.stored, commandId, digest);
        if (replayed !== undefined) return replayed;
        if (changes.actions !== undefined) {
          await assertOwnContinuations(changes.actions, taskId, task, options.reviewIdsOf);
        }
        const before = loaded.stored.surface;
        if (ended(task, before)) return rejection('closed', 'the surface is closed');
        if (before.revision !== baseRevision) {
          return rejection('stale-revision', undefined, before.revision);
        }
        if (changes.representation !== undefined && changes.representation.kind !== before.kind) {
          throw new InteractiveSurfaceValidationError(
            `representation.kind must stay "${before.kind}"`,
          );
        }
        // A2UI fixes a surface's catalog at `createSurface`; `updateComponents` names none.
        if (
          changes.representation?.kind === 'a2ui' &&
          before.representation?.kind === 'a2ui' &&
          changes.representation.catalogId !== before.representation.catalogId
        ) {
          throw new InteractiveSurfaceValidationError(
            `representation.catalogId must stay "${before.representation.catalogId}"`,
          );
        }
        // A new MCP App resource is a new app instance, so it must carry a new
        // `instanceId`; otherwise the old instance's actions would still pass.
        const next = changes.representation;
        const previous = before.representation;
        if (
          next?.kind === 'mcp-app' &&
          previous?.kind === 'mcp-app' &&
          (next.resourceUri !== previous.resourceUri ||
            next.contentDigest !== previous.contentDigest ||
            next.domain !== previous.domain) &&
          next.instanceId === previous.instanceId
        ) {
          // A new sandbox origin reloads the document as surely as a new resource does.
          throw new InteractiveSurfaceValidationError(
            'a new MCP App resource, digest, or domain needs a new instanceId',
          );
        }
        const revision = before.revision + 1;
        const surface: InteractiveSurface = {
          ...before,
          ...changes,
          revision,
          componentRevision:
            changes.representation === undefined ? before.componentRevision : revision,
          dataRevision: changes.data === undefined ? before.dataRevision : revision,
          updatedAt: isoNow(),
          eventCursor: null,
        };
        assertWithinPayloadLimit(content(surface), maxPayloadBytes);
        const cursor = await commit(
          taskId,
          surfaceId,
          loaded.text,
          {
            ...loaded.stored,
            surface,
            commands: remember(loaded.stored.commands, { commandId, digest, revision }),
          },
          INTERACTIVE_SURFACE_EVENT_KINDS.updated,
          {
            contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
            commandId,
            surfaceId,
            revision,
            baseRevision,
            changes,
          },
        );
        return accepted(commandId, { ...surface, eventCursor: cursor }, false);
      });
    });
  }

  // ── snapshot ──────────────────────────────────────────────────────

  async function snapshot(
    query: InteractiveSurfaceSnapshotQuery,
    authorization: InteractiveSurfaceAuthorization = {},
  ): Promise<InteractiveSurfaceSnapshotReceipt> {
    return guarded(async () => {
      if (!isPlainObject(query))
        throw new InteractiveSurfaceValidationError('the query must be an object');
      assertKnownFields(query, ['type', 'contractVersion', 'taskId', 'surfaceId'], 'the query');
      if (query.type !== 'surface.snapshot') {
        throw new InteractiveSurfaceValidationError('type must be "surface.snapshot"');
      }
      assertContractVersion(query.contractVersion);
      const taskId = readIdentifier(query.taskId, 'taskId', MAX_COMPOSITE_IDENTIFIER_LENGTH);
      const surfaceId = readIdentifier(query.surfaceId, 'surfaceId');
      const task = await reachTask(taskId, authorization);
      if (isRejection(task)) return task;
      const loaded = await current(task, taskId, surfaceId);
      if (loaded === undefined || !maySee(loaded.stored.surface, authorization)) {
        return rejection('not-found');
      }
      return {
        contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
        outcome: 'found' as const,
        surface: await withCursor(loaded.stored.surface),
      };
    });
  }

  async function list(
    taskId: string,
    authorization: InteractiveSurfaceAuthorization = {},
  ): Promise<readonly InteractiveSurface[]> {
    const read = await guarded(async () => {
      const id = readIdentifier(taskId, 'taskId', MAX_COMPOSITE_IDENTIFIER_LENGTH);
      const task = await reachTask(id, authorization);
      if (isRejection(task)) return [];
      const found: InteractiveSurface[] = [];
      for (const surfaceId of await surfaceIdsOf(id)) {
        const loaded = await current(task, id, surfaceId);
        if (loaded !== undefined && maySee(loaded.stored.surface, authorization)) {
          found.push(await withCursor(loaded.stored.surface));
        }
      }
      return found.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
    });
    return isRejection(read) ? [] : read;
  }

  // ── act ───────────────────────────────────────────────────────────

  async function act(
    request: InteractiveSurfaceActionRequest,
    authorization: InteractiveSurfaceAuthorization = {},
  ): Promise<InteractiveSurfaceActionReceipt> {
    return guarded(async () => {
      const { record, commandId, taskId } = readCommandBase(request, 'surface.action', [
        'surfaceId',
        'revision',
        'action',
        'value',
        'sourceComponentId',
        'timestamp',
      ]);
      const surfaceId = readIdentifier(record['surfaceId'], 'surfaceId');
      const revision = record['revision'];
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
        throw new InteractiveSurfaceValidationError('revision must be a positive integer');
      }
      const actionName = readIdentifier(record['action'], 'action');
      const value = record['value'] === undefined ? null : readJsonValue(record['value'], 'value');
      const provenance = readActionProvenance(record);
      const digest = digestOf(record);

      const task = await reachTask(taskId, authorization);
      if (isRejection(task)) return task;

      return retrying(async () => {
        const loaded = await current(task, taskId, surfaceId);
        if (loaded === undefined || !maySee(loaded.stored.surface, authorization)) {
          return rejection('not-found');
        }
        const seen = loaded.stored.commands.find((entry) => entry.commandId === commandId);
        if (seen !== undefined) {
          if (seen.digest !== digest || seen.admission === undefined) {
            return rejection(
              'conflict',
              `commandId "${commandId}" was used for a different command`,
            );
          }
          return { ...seen.admission, value, replayed: true };
        }
        const surface = loaded.stored.surface;
        if (ended(task, surface)) return rejection('closed', 'the surface is closed');
        if (surface.revision !== revision) {
          return rejection('stale-revision', undefined, surface.revision);
        }
        // An untrusted caller (one that states a principal) acting on an MCP App
        // must say which app instance it is, and it must be the one shown.
        if (
          surface.representation?.kind === 'mcp-app' &&
          (authorization.instanceId === undefined
            ? authorization.principal !== undefined
            : authorization.instanceId !== surface.representation.instanceId)
        ) {
          return rejection('stale-instance', 'the app instance is not the one the surface shows');
        }
        const action = surface.actions.find((entry) => entry.name === actionName);
        if (action === undefined) {
          return rejection('invalid', `the surface offers no action "${actionName}"`);
        }
        const schema = actionValueSchema(action, surface.representation);
        if (schema === undefined) {
          if (value !== null)
            return rejection('invalid', `the action "${actionName}" takes no value`);
        } else {
          const problem = schemas.check(schema, value);
          if (problem !== undefined) return rejection('invalid', problem);
        }
        const admission: InteractiveSurfaceActionAdmission = {
          contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
          outcome: 'accepted',
          commandId,
          taskId,
          surfaceId,
          revision,
          action: action.name,
          intent: action.intent,
          continuation: action.continuation,
          value,
          replayed: false,
        };
        await commit(
          taskId,
          surfaceId,
          loaded.text,
          {
            ...loaded.stored,
            commands: remember(loaded.stored.commands, {
              commandId,
              digest,
              revision,
              admission: withoutValue(admission),
            }),
          },
          INTERACTIVE_SURFACE_EVENT_KINDS.actionAdmitted,
          {
            contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
            commandId,
            surfaceId,
            revision,
            action: action.name,
            intent: action.intent,
            continuation: action.continuation,
            ...provenance,
            ...(surface.classification === 'sensitive'
              ? { valueDigest: digestOf(value) }
              : { value: value satisfies InteractiveSurfaceJsonValue }),
          },
          false,
        );
        return admission;
      });
    });
  }

  // ── close ─────────────────────────────────────────────────────────

  async function close(
    command: CloseInteractiveSurfaceCommand,
    authorization: InteractiveSurfaceAuthorization = {},
  ): Promise<CloseInteractiveSurfaceReceipt> {
    return guarded(async () => {
      const { record, commandId, taskId } = readCommandBase(command, 'surface.close', [
        'surfaceId',
        'baseRevision',
        'reason',
      ]);
      const surfaceId = readIdentifier(record['surfaceId'], 'surfaceId');
      const reason = record['reason'];
      if (reason !== 'completed' && reason !== 'dismissed') {
        throw new InteractiveSurfaceValidationError('reason must be "completed" or "dismissed"');
      }
      const baseRevision = readBaseRevision(record['baseRevision']);
      const digest = digestOf(record);
      const task = await reachTask(taskId, authorization);
      if (isRejection(task)) return task;
      if (!mayChange(task, authorization)) return rejection('not-found');

      return retrying(async () => {
        const loaded = await current(task, taskId, surfaceId);
        if (loaded === undefined) return rejection('not-found');
        const replayed = await replay(loaded.stored, commandId, digest);
        if (replayed !== undefined) return replayed;
        const before = loaded.stored.surface;
        if (ended(task, before)) return rejection('closed', 'the surface is closed');
        if (before.revision !== baseRevision) {
          return rejection('stale-revision', undefined, before.revision);
        }
        const at = isoNow();
        const revision = before.revision + 1;
        const surface: InteractiveSurface = {
          ...before,
          representation: null,
          data: null,
          actions: [],
          revision,
          componentRevision: revision,
          dataRevision: revision,
          state: 'closed',
          liveness: 'torn-down',
          closeResult: { reason, closedAt: at },
          updatedAt: at,
          eventCursor: null,
        };
        const cursor = await commit(
          taskId,
          surfaceId,
          loaded.text,
          {
            ...loaded.stored,
            surface,
            commands: remember(loaded.stored.commands, { commandId, digest, revision }),
          },
          INTERACTIVE_SURFACE_EVENT_KINDS.closed,
          {
            contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
            commandId,
            surfaceId,
            revision,
            closeResult: surface.closeResult,
          },
        );
        return accepted(commandId, { ...surface, eventCursor: cursor }, false);
      });
    });
  }

  // ── abort, cleanup, settlement, retention ─────────────────────────

  async function abort(
    command: AbortInteractiveSurfacesCommand,
    authorization: InteractiveSurfaceAuthorization = {},
  ): Promise<AbortInteractiveSurfacesReceipt> {
    return guarded(async () => {
      const { commandId, taskId } = readCommandBase(command, 'surface.owner-abort', []);
      const task = await reachTask(taskId, authorization);
      if (isRejection(task)) return task;
      if (!mayChange(task, authorization)) return rejection('not-found');
      // A task that already ended keeps the reason its ending gives: an abort records `cancelled`
      // only for a task that is still running or was itself cancelled.
      const reason =
        task.settled === 'completed' || task.settled === 'failed' ? 'task-ended' : 'cancelled';
      const result = await freezeTask(taskId, reason, commandId);
      return {
        contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
        outcome: 'accepted' as const,
        commandId,
        frozen: result.frozen,
        cleanup: result.cleanup,
      };
    });
  }

  async function cleanup(
    query: InteractiveSurfaceCleanupQuery,
    authorization: InteractiveSurfaceAuthorization = {},
  ): Promise<InteractiveSurfaceCleanupReceipt> {
    return guarded(async () => {
      if (!isPlainObject(query))
        throw new InteractiveSurfaceValidationError('the query must be an object');
      assertKnownFields(query, ['type', 'contractVersion', 'taskId'], 'the query');
      if (query.type !== 'surface.cleanup') {
        throw new InteractiveSurfaceValidationError('type must be "surface.cleanup"');
      }
      assertContractVersion(query.contractVersion);
      const taskId = readIdentifier(query.taskId, 'taskId', MAX_COMPOSITE_IDENTIFIER_LENGTH);
      const task = await reachTask(taskId, authorization);
      if (isRejection(task)) return task;
      if (!mayChange(task, authorization)) return rejection('not-found');
      const surfaceIds = await surfaceIdsOf(taskId);
      if (surfaceIds.length === 0) {
        return {
          contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
          outcome: 'found' as const,
          cleanup: { status: 'not-required' as const },
        };
      }
      let open = 0;
      for (const surfaceId of surfaceIds) {
        const loaded = await current(task, taskId, surfaceId);
        if (loaded?.stored.surface.state === 'open') open += 1;
      }
      return open === 0
        ? {
            contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
            outcome: 'found' as const,
            cleanup: { status: 'completed' as const },
          }
        : {
            contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
            outcome: 'pending' as const,
            open,
          };
    });
  }

  /** Each task's settlement freeze, once it has started. */
  const settlements = new Map<string, Promise<CleanupAcknowledgement>>();
  /** Callers waiting for a task to settle in this process. */
  const settlementWaiters = new Map<
    string,
    Set<(acknowledgement: CleanupAcknowledgement) => void>
  >();
  const watched = new Set<string>();

  function settleTask(
    taskId: string,
    status: 'completed' | 'failed' | 'canceled',
  ): Promise<CleanupAcknowledgement> {
    const existing = settlements.get(taskId);
    if (existing !== undefined) return existing;
    const settlement = freezeTask(
      taskId,
      status === 'canceled' ? 'cancelled' : 'task-ended',
      `task-settled:${taskId}`,
    ).then(
      (result) => result.cleanup,
      (error: unknown): CleanupAcknowledgement => ({ status: 'failed', error }),
    );
    settlements.set(taskId, settlement);
    void announceSettlement(taskId, settlement);
    return settlement;
  }

  async function announceSettlement(
    taskId: string,
    settlement: Promise<CleanupAcknowledgement>,
  ): Promise<void> {
    const acknowledgement = await settlement;
    // Only a settlement in flight is remembered: a later one scans the task's
    // surfaces again, so a surface created after this scan is frozen too.
    settlements.delete(taskId);
    if (acknowledgement.status === 'failed') options.onFreezeError?.(taskId, acknowledgement.error);
    const waiters = settlementWaiters.get(taskId);
    settlementWaiters.delete(taskId);
    for (const resolve of waiters ?? []) resolve(acknowledgement);
  }

  function watch(taskId: string): void {
    if (options.watchTask === undefined || watched.has(taskId)) return;
    watched.add(taskId);
    options.watchTask(taskId, (status) => {
      void settleTask(taskId, status);
    });
  }

  /** Settles `wait`, or `unresolved` once `signal` aborts, whichever is first. */
  function untilAborted(
    wait: Promise<CleanupAcknowledgement>,
    signal: AbortSignal | undefined,
  ): Promise<CleanupAcknowledgement> {
    if (signal === undefined) return wait;
    const timedOut: CleanupAcknowledgement = { status: 'unresolved', reason: 'timed-out' };
    if (signal.aborted) return Promise.resolve(timedOut);
    const aborted = Promise.withResolvers<CleanupAcknowledgement>();
    const onAbort = (): void => aborted.resolve(timedOut);
    signal.addEventListener('abort', onAbort, { once: true });
    return Promise.race([wait, aborted.promise]).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  }

  function closed(
    taskId: string,
    waitOptions?: { readonly signal?: AbortSignal | undefined },
  ): Promise<CleanupAcknowledgement> {
    // Every await below (storage, the task lookup, a settlement's freezes) can
    // stall, so the whole wait races the caller's signal.
    return untilAborted(waitForClosed(taskId, waitOptions?.signal), waitOptions?.signal);
  }

  async function waitForClosed(
    taskId: string,
    signal: AbortSignal | undefined,
  ): Promise<CleanupAcknowledgement> {
    const pending = settlements.get(taskId);
    if (pending !== undefined) await pending;
    const surfaceIds = await surfaceIdsOf(taskId);
    if (surfaceIds.length === 0) return { status: 'not-required' };
    const task = await options.task(taskId);
    if (task === undefined) return { status: 'not-required' };
    if (task.settled !== undefined) return settleTask(taskId, task.settled);
    // A surface created before a restart has no watcher yet; nothing would
    // settle this wait without one. Read the task again once it is watched, so
    // a settlement between the read above and the watch is not missed.
    watch(taskId);
    const again = await options.task(taskId);
    if (again === undefined) return { status: 'not-required' };
    if (again.settled !== undefined) return settleTask(taskId, again.settled);
    return new Promise<CleanupAcknowledgement>((resolve) => {
      if (signal?.aborted === true) {
        resolve({ status: 'unresolved', reason: 'timed-out' });
        return;
      }
      const waiters = settlementWaiters.get(taskId) ?? new Set();
      settlementWaiters.set(taskId, waiters);
      const onSettled = (acknowledgement: CleanupAcknowledgement): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve(acknowledgement);
      };
      const onAbort = (): void => {
        waiters.delete(onSettled);
        resolve({ status: 'unresolved', reason: 'timed-out' });
      };
      waiters.add(onSettled);
      signal?.addEventListener('abort', onAbort, { once: true });
      // A settlement that started after the checks above may already have
      // announced itself to an empty set of waiters.
      const started = settlements.get(taskId);
      if (started !== undefined) {
        waiters.delete(onSettled);
        void started.then(onSettled);
      }
    });
  }

  /**
   * Deletes the removal markers old enough that no command authorized before the removal can still
   * be committing. A marker only fences such a command, and a generation is never reused, so a
   * marker past {@link REMOVAL_MARKER_RETENTION_MILLISECONDS} has nothing left to fence. A marker
   * whose value is not a time (written before markers carried one) is retired as well.
   */
  async function retireRemovalMarkers(): Promise<void> {
    // Once per interval: the markers listed and read are every one still kept, so a pass per
    // removal would read the whole set each time.
    const now = options.now();
    if (now < nextMarkerSweepAt) return;
    nextMarkerSweepAt = now + REMOVAL_MARKER_SWEEP_INTERVAL_MILLISECONDS;
    const cutoff = now - REMOVAL_MARKER_RETENTION_MILLISECONDS;
    for (const key of await store.list(REMOVAL_MARKER_PREFIX)) {
      const value = await store.get(key);
      if (value === null) continue;
      const writtenAt = Number(value);
      if (Number.isFinite(writtenAt) && writtenAt >= cutoff) continue;
      // Only the value that was read: a removal that rewrote the marker meanwhile keeps its own.
      await store.conditionalBatch([{ key, expectedValue: value }], [{ type: 'delete', key }]);
    }
  }

  async function removeTask(taskId: string): Promise<void> {
    // A settlement in flight stays tracked, so `flush` still drains it, and is
    // awaited before the surfaces it is freezing go away.
    await settlements.get(taskId);
    watched.delete(taskId);
    // The marker first: a command already past its checks then fails its commit.
    const task = await options.task(taskId);
    await store.set(removedKey(taskId, task?.generation ?? ''), String(options.now()));
    await retireRemovalMarkers();
    await store.deletePrefix(surfacePrefix(taskId));
    // A wait for this task's cleanup has nothing left to wait for.
    const waiters = settlementWaiters.get(taskId);
    settlementWaiters.delete(taskId);
    for (const resolve of waiters ?? []) resolve({ status: 'not-required' });
  }

  async function flush(): Promise<void> {
    await Promise.allSettled(settlements.values());
  }

  return {
    create,
    update,
    snapshot,
    list,
    act,
    close,
    abort,
    cleanup,
    settleTask,
    closed,
    removeTask,
    flush,
  };
}
