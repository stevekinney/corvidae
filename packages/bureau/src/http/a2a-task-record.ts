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
  /** Deletes a task's record. */
  remove(taskId: string): Promise<void>;
}

function keyOf(taskId: string): string {
  return `${A2A_TASK_RECORD_KEY_PREFIX}${encodeURIComponent(taskId)}`;
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

  return {
    read,

    async create(record) {
      const key = keyOf(record.taskId);
      for (let attempt = 0; attempt < MAXIMUM_WRITE_ATTEMPTS; attempt += 1) {
        const raw = await kv.get(key);
        if (raw !== null) return parse(record.taskId, raw);
        const written = await kv.conditionalBatch(
          [{ key, expectedValue: null }],
          [{ type: 'set', key, value: JSON.stringify(record) }],
        );
        if (written) return record;
      }
      throw new Error(`The A2A record of task "${record.taskId}" could not be written.`);
    },

    async update(taskId, change) {
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
    },

    async remove(taskId) {
      await kv.delete(keyOf(taskId));
    },
  };
}
