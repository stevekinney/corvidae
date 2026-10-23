/**
 * The push projector's persisted checkpoint (COR-1543): one record per push configuration,
 * holding the last durable-history cursor whose events were enqueued for it. A checkpoint is
 * stored in the Bureau's own key-value store beside the task's A2A record, and is deleted with
 * its configuration or its task.
 *
 * A record is versioned (`recordVersion: 1`); one written by a later version fails its read with
 * {@link A2APushCheckpointVersionError} rather than being misread. A checkpoint also remembers
 * the caller scope its configuration was created under, because the projector runs outside any
 * request and the push store scopes a configuration by caller.
 *
 * @module a2a-push-checkpoint
 */

import type { ConditionalTextValueStore } from '@lostgradient/weft';

/** The key prefix of a push checkpoint, disjoint from every other prefix the Bureau stores. */
export const A2A_PUSH_CHECKPOINT_KEY_PREFIX = 'bureau-a2a-push:v1:';

/** The record version this module writes and reads. */
export const A2A_PUSH_CHECKPOINT_VERSION = 1;

/** The most compare-and-swap attempts one write makes before it gives up. */
const MAXIMUM_WRITE_ATTEMPTS = 16;

/** The caller scope a configuration was created under, as the push store scopes it. */
export interface A2APushCaller {
  readonly authenticated: boolean;
  readonly userName: string;
}

/** The persisted checkpoint of one push configuration. */
export interface A2APushCheckpoint {
  readonly recordVersion: typeof A2A_PUSH_CHECKPOINT_VERSION;
  readonly taskId: string;
  readonly configId: string;
  /** The last durable-history cursor enqueued; `'-1'` is before the first event. */
  readonly cursor: string;
  readonly caller: A2APushCaller;
  /**
   * Written before the configuration it names, and cleared once that configuration exists. A
   * pending checkpoint is never pumped: a restart either confirms it (the configuration was
   * committed) or removes it (it was not), so a configuration never exists without a checkpoint.
   */
  readonly pending?: true;
  /**
   * The install that wrote a pending checkpoint. Only that install, or a recovery that read this
   * generation, may remove it, so an install that lost a race never deletes the winner's.
   */
  readonly installId?: string;
}

/** A stored checkpoint whose `recordVersion` this Bureau does not know: it is never misread. */
export class A2APushCheckpointVersionError extends Error {
  readonly taskId: string;
  readonly configId: string;
  readonly recordVersion: unknown;

  constructor(taskId: string, configId: string, recordVersion: unknown) {
    super(
      `The push checkpoint of configuration "${configId}" on task "${taskId}" has recordVersion ` +
        `${JSON.stringify(recordVersion)}, which this Bureau does not read ` +
        `(it reads ${A2A_PUSH_CHECKPOINT_VERSION}).`,
    );
    this.name = 'A2APushCheckpointVersionError';
    this.taskId = taskId;
    this.configId = configId;
    this.recordVersion = recordVersion;
  }
}

/** The store of every push configuration's checkpoint. */
export interface A2APushCheckpoints {
  /** A configuration's checkpoint, or `undefined` when it has none. */
  read(taskId: string, configId: string): Promise<A2APushCheckpoint | undefined>;
  /** Writes a configuration's first checkpoint; one that exists is kept. Resolves the stored one. */
  create(checkpoint: A2APushCheckpoint): Promise<A2APushCheckpoint>;
  /**
   * Moves a checkpoint forward to `cursor`. A cursor at or behind the stored one writes nothing,
   * so a slow writer never moves the checkpoint back. Resolves the stored checkpoint, or
   * `undefined` when the configuration has none.
   */
  advance(taskId: string, configId: string, cursor: string): Promise<A2APushCheckpoint | undefined>;
  /** Clears a checkpoint's `pending` mark. Resolves the stored checkpoint, or `undefined`. */
  confirm(taskId: string, configId: string): Promise<A2APushCheckpoint | undefined>;
  /** Every checkpoint of a task. */
  listForTask(taskId: string): Promise<A2APushCheckpoint[]>;
  /** The task identifier of every checkpoint, each once. */
  listTaskIds(): Promise<string[]>;
  /** Deletes a configuration's checkpoint. */
  remove(taskId: string, configId: string): Promise<void>;
  /**
   * Deletes a configuration's checkpoint only while it is still the pending one `installId`
   * wrote. A confirmed checkpoint, or one another install wrote, is kept.
   */
  removePending(taskId: string, configId: string, installId: string | undefined): Promise<void>;
}

function taskPrefix(taskId: string): string {
  return `${A2A_PUSH_CHECKPOINT_KEY_PREFIX}${encodeURIComponent(taskId)}:`;
}

function keyOf(taskId: string, configId: string): string {
  return `${taskPrefix(taskId)}${encodeURIComponent(configId)}`;
}

function parse(taskId: string, configId: string, raw: string): A2APushCheckpoint {
  const parsed = JSON.parse(raw) as { recordVersion?: unknown };
  if (parsed.recordVersion !== A2A_PUSH_CHECKPOINT_VERSION) {
    throw new A2APushCheckpointVersionError(taskId, configId, parsed.recordVersion);
  }
  return parsed as A2APushCheckpoint;
}

/** The sequence a cursor names; `'-1'` is before the first event. */
function sequenceOf(cursor: string): number {
  const sequence = Number(cursor);
  return Number.isSafeInteger(sequence) ? sequence : -1;
}

/** The push checkpoints over `kv`, the Bureau's own store (or memory, for an ephemeral Bureau). */
export function createA2APushCheckpoints(kv: ConditionalTextValueStore): A2APushCheckpoints {
  async function read(taskId: string, configId: string): Promise<A2APushCheckpoint | undefined> {
    const raw = await kv.get(keyOf(taskId, configId));
    return raw === null ? undefined : parse(taskId, configId, raw);
  }

  return {
    read,

    async create(checkpoint) {
      const key = keyOf(checkpoint.taskId, checkpoint.configId);
      for (let attempt = 0; attempt < MAXIMUM_WRITE_ATTEMPTS; attempt += 1) {
        const raw = await kv.get(key);
        if (raw !== null) return parse(checkpoint.taskId, checkpoint.configId, raw);
        const written = await kv.conditionalBatch(
          [{ key, expectedValue: null }],
          [{ type: 'set', key, value: JSON.stringify(checkpoint) }],
        );
        if (written) return checkpoint;
      }
      throw new Error(
        `The push checkpoint of configuration "${checkpoint.configId}" could not be written.`,
      );
    },

    async advance(taskId, configId, cursor) {
      const key = keyOf(taskId, configId);
      for (let attempt = 0; attempt < MAXIMUM_WRITE_ATTEMPTS; attempt += 1) {
        const raw = await kv.get(key);
        if (raw === null) return undefined;
        const current = parse(taskId, configId, raw);
        if (sequenceOf(cursor) <= sequenceOf(current.cursor)) return current;
        const next = { ...current, cursor };
        const written = await kv.conditionalBatch(
          [{ key, expectedValue: raw }],
          [{ type: 'set', key, value: JSON.stringify(next) }],
        );
        if (written) return next;
      }
      throw new Error(`The push checkpoint of configuration "${configId}" could not be advanced.`);
    },

    async confirm(taskId, configId) {
      const key = keyOf(taskId, configId);
      for (let attempt = 0; attempt < MAXIMUM_WRITE_ATTEMPTS; attempt += 1) {
        const raw = await kv.get(key);
        if (raw === null) return undefined;
        const current = parse(taskId, configId, raw);
        if (current.pending !== true) return current;
        const { pending: _pending, ...next } = current;
        const written = await kv.conditionalBatch(
          [{ key, expectedValue: raw }],
          [{ type: 'set', key, value: JSON.stringify(next) }],
        );
        if (written) return next;
      }
      throw new Error(`The push checkpoint of configuration "${configId}" could not be confirmed.`);
    },

    async listForTask(taskId) {
      const prefix = taskPrefix(taskId);
      const checkpoints: A2APushCheckpoint[] = [];
      for (const key of await kv.list(prefix)) {
        const configId = decodeURIComponent(key.slice(prefix.length));
        const checkpoint = await read(taskId, configId);
        if (checkpoint !== undefined) checkpoints.push(checkpoint);
      }
      return checkpoints;
    },

    async listTaskIds() {
      const taskIds = new Set<string>();
      for (const key of await kv.list(A2A_PUSH_CHECKPOINT_KEY_PREFIX)) {
        const rest = key.slice(A2A_PUSH_CHECKPOINT_KEY_PREFIX.length);
        taskIds.add(decodeURIComponent(rest.slice(0, rest.indexOf(':'))));
      }
      return [...taskIds];
    },

    async removePending(taskId, configId, installId) {
      const key = keyOf(taskId, configId);
      for (let attempt = 0; attempt < MAXIMUM_WRITE_ATTEMPTS; attempt += 1) {
        const raw = await kv.get(key);
        if (raw === null) return;
        const current = parse(taskId, configId, raw);
        if (current.pending !== true || current.installId !== installId) return;
        const written = await kv.conditionalBatch(
          [{ key, expectedValue: raw }],
          [{ type: 'delete', key }],
        );
        if (written) return;
      }
      throw new Error(`The push checkpoint of configuration "${configId}" could not be removed.`);
    },

    async remove(taskId, configId) {
      await kv.delete(keyOf(taskId, configId));
    },
  };
}
