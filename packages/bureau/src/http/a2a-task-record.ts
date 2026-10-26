/**
 * Bureau's persisted per-task A2A record (COR-903): what a task served over A2A keeps beside its
 * task record. It holds the task's own A2A history (the messages exchanged on the task through
 * A2A, never the session transcript), so `Task.history` is served from it, and the `contextId`
 * the task was recorded with, which continuation checks compare against.
 *
 * A record is versioned (`recordVersion: 1`), and one written by a later version fails its read
 * with {@link A2ATaskRecordVersionError} rather than being misread. Every write is a
 * compare-and-swap on the stored text, so two writers to one task never lose each other's
 * history entry. The record is deleted when its task leaves the run store (`run.removed`).
 *
 * @module a2a-task-record
 */

import type { ConditionalTextValueStore } from '@lostgradient/weft';

/** The key prefix of a task's A2A record, disjoint from every other prefix the Bureau stores. */
export const A2A_TASK_RECORD_KEY_PREFIX = 'bureau-a2a-task:v1:';

/** The key prefix of the index of a context's tasks, so deleting the context clears them all. */
export const A2A_CONTEXT_INDEX_KEY_PREFIX = 'bureau-a2a-context:v1:';

/** The record version this module writes and reads. */
export const A2A_TASK_RECORD_VERSION = 1;

/** The most compare-and-swap attempts one write makes before it gives up. */
const MAXIMUM_WRITE_ATTEMPTS = 16;

/** One A2A message, in its proto3 JSON wire form (`Message.toJSON`). */
export type A2AWireMessage = Record<string, unknown>;

/** The persisted A2A record of one task. */
export interface A2ATaskRecord {
  readonly recordVersion: typeof A2A_TASK_RECORD_VERSION;
  readonly taskId: string;
  /** The context the task was created in: the session identifier, unchanged. */
  readonly contextId: string;
  /**
   * The incarnation of that context the task belongs to (`''` for a context with no session). A
   * context deleted and created again under the same id is a new one, so clearing a deleted
   * context's history never reaches the tasks of its successor.
   */
  readonly incarnation: string;
  /** The task's own A2A history, oldest first. */
  readonly history: readonly A2AWireMessage[];
  /** Whether the agent's final reply has been folded into `history`. */
  readonly replyRecorded: boolean;
}

/** A stored record whose `recordVersion` this Bureau does not know: it is never misread. */
export class A2ATaskRecordVersionError extends Error {
  readonly taskId: string;
  readonly recordVersion: unknown;

  constructor(taskId: string, recordVersion: unknown) {
    super(
      `The A2A record of task "${taskId}" has recordVersion ${JSON.stringify(recordVersion)}, ` +
        `which this Bureau does not read (it reads ${A2A_TASK_RECORD_VERSION}).`,
    );
    this.name = 'A2ATaskRecordVersionError';
    this.taskId = taskId;
    this.recordVersion = recordVersion;
  }
}

/** The store of every task's A2A record. */
export interface A2ATaskRecords {
  /** A task's record, or `undefined` when it has none. */
  read(taskId: string): Promise<A2ATaskRecord | undefined>;
  /** Writes a task's first record; a task that already has one keeps it. Resolves the stored one. */
  create(record: A2ATaskRecord): Promise<A2ATaskRecord>;
  /**
   * Applies `change` to a task's record and stores the result, retrying on a concurrent write.
   * `change` returning `undefined` writes nothing. Resolves the stored record, or `undefined`
   * when the task has none.
   */
  update(
    taskId: string,
    change: (current: A2ATaskRecord) => A2ATaskRecord | undefined,
  ): Promise<A2ATaskRecord | undefined>;
  /**
   * Empties the history of every task recorded in `contextId` at `incarnation`, for that
   * incarnation of the context having been deleted: message text does not outlive its context. A
   * task of another incarnation created under the same id keeps its history. The task's reply is
   * not folded in afterwards. Resolves how many records it cleared.
   */
  clearContext(contextId: string, incarnation: string): Promise<number>;
  /** Deletes a task's record. */
  remove(taskId: string): Promise<void>;
  /**
   * Deletes every record whose task `exists` no longer reports, for a removal that failed or never
   * ran (a crash after the task left the store). Resolves how many records it deleted.
   */
  sweep(exists: (taskId: string) => Promise<boolean>): Promise<number>;
}

/** A record with its history emptied, as a deleted context leaves it. */
export function clearedRecord(record: A2ATaskRecord): A2ATaskRecord {
  return { ...record, history: [], replyRecorded: true };
}

function keyOf(taskId: string): string {
  return `${A2A_TASK_RECORD_KEY_PREFIX}${encodeURIComponent(taskId)}`;
}

function contextPrefix(contextId: string): string {
  return `${A2A_CONTEXT_INDEX_KEY_PREFIX}${encodeURIComponent(contextId)}:`;
}

function indexKeyOf(contextId: string, taskId: string): string {
  return `${contextPrefix(contextId)}${encodeURIComponent(taskId)}`;
}

function parse(taskId: string, raw: string): A2ATaskRecord {
  const parsed = JSON.parse(raw) as { recordVersion?: unknown };
  if (parsed.recordVersion !== A2A_TASK_RECORD_VERSION) {
    throw new A2ATaskRecordVersionError(taskId, parsed.recordVersion);
  }
  return parsed as A2ATaskRecord;
}

/** The A2A records over `kv`, the Bureau's own store (or memory, for an ephemeral Bureau). */
export function createA2ATaskRecords(kv: ConditionalTextValueStore): A2ATaskRecords {
  async function read(taskId: string): Promise<A2ATaskRecord | undefined> {
    const raw = await kv.get(keyOf(taskId));
    return raw === null ? undefined : parse(taskId, raw);
  }

  async function update(
    taskId: string,
    change: (current: A2ATaskRecord) => A2ATaskRecord | undefined,
  ): Promise<A2ATaskRecord | undefined> {
    const key = keyOf(taskId);
    for (let attempt = 0; attempt < MAXIMUM_WRITE_ATTEMPTS; attempt += 1) {
      const raw = await kv.get(key);
      if (raw === null) return undefined;
      const current = parse(taskId, raw);
      const next = change(current);
      if (next === undefined) return current;
      const written = await kv.conditionalBatch(
        [{ key, expectedValue: raw }],
        [{ type: 'set', key, value: JSON.stringify(next) }],
      );
      if (written) return next;
    }
    throw new Error(`The A2A record of task "${taskId}" could not be updated.`);
  }

  async function remove(taskId: string): Promise<void> {
    const raw = await kv.get(keyOf(taskId));
    const record = raw === null ? undefined : (JSON.parse(raw) as Partial<A2ATaskRecord>);
    if (typeof record?.contextId === 'string') {
      await kv.delete(indexKeyOf(record.contextId, taskId));
    }
    await kv.delete(keyOf(taskId));
  }

  return {
    read,
    update,

    async clearContext(contextId, incarnation) {
      let cleared = 0;
      for (const indexKey of await kv.list(contextPrefix(contextId))) {
        const taskId = await kv.get(indexKey);
        if (taskId === null) continue;
        const record = await read(taskId);
        // Another incarnation's task keeps its history, and its index entry for its own deletion.
        if (record !== undefined && record.incarnation !== incarnation) continue;
        if (record !== undefined && record.history.length > 0) {
          await update(taskId, (current) =>
            current.incarnation !== incarnation || current.history.length === 0
              ? undefined
              : clearedRecord(current),
          );
          cleared += 1;
        }
        await kv.delete(indexKey);
      }
      return cleared;
    },

    async sweep(exists) {
      let removed = 0;
      for (const key of await kv.list(A2A_TASK_RECORD_KEY_PREFIX)) {
        const taskId = decodeURIComponent(key.slice(A2A_TASK_RECORD_KEY_PREFIX.length));
        if (await exists(taskId)) continue;
        await remove(taskId);
        removed += 1;
      }
      return removed;
    },

    async create(record) {
      const key = keyOf(record.taskId);
      for (let attempt = 0; attempt < MAXIMUM_WRITE_ATTEMPTS; attempt += 1) {
        const raw = await kv.get(key);
        if (raw !== null) return parse(record.taskId, raw);
        const written = await kv.conditionalBatch(
          [{ key, expectedValue: null }],
          [
            { type: 'set', key, value: JSON.stringify(record) },
            { type: 'set', key: indexKeyOf(record.contextId, record.taskId), value: record.taskId },
          ],
        );
        if (written) return record;
      }
      throw new Error(`The A2A record of task "${record.taskId}" could not be written.`);
    },

    remove,
  };
}
