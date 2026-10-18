/**
 * The durable event log behind a workflow agent's A2A tasks.
 *
 * Every status and artifact change of a task is one `StreamResponse` appended to the
 * task's own log, in the same conditional batch that saves the task record, so the
 * record always names the sequence of the last event it reflects: its cursor. A
 * subscriber that reads the record and then follows the log from that cursor sees
 * every later change exactly once and never one the record already contains.
 *
 * Records share the task store's keys and format (`createWeftA2ATaskStore` reads
 * them), scoped by namespace, tenant, and owner. Each task also has one owner record,
 * keyed by its identifier alone, naming the scope it belongs to, so a change the
 * engine reports with only a workflow identifier can be applied to the right task.
 *
 * Live delivery is in-process: a commit notifies the followers of the same log object.
 * A follower that falls behind reads the gap back from storage.
 *
 * @module a2a/task-event-log
 */

import { StreamResponse, Task } from '@a2a-js/sdk';

import type { BatchOperation, Storage } from '../storage/interface.ts';
import {
  type A2ACallerScope,
  decodeRecord,
  encodeRecord,
  scopedKey,
  taskEventPrefix,
  withCompareAndSwap,
  workflowTaskKey,
} from './store-support.ts';

/** One durable event: its sequence, its opaque cursor (the SSE `id`), and the event. */
export type TaskEventEntry = {
  readonly sequence: number;
  readonly cursor: string;
  readonly event: StreamResponse;
};

/** A task record and the sequence of the last event it reflects. */
export type StoredWorkflowTask = {
  readonly task: Task;
  readonly sequence: number;
};

/** The identity a task's owner record keeps, enough to rebuild its caller scope. */
export type TaskOwner = {
  readonly tenant: string;
  readonly authenticated: boolean;
  readonly userName: string;
};

/** What a commit writes: the task's next state and the events that led to it. */
export type TaskMutation = {
  readonly task: Task;
  readonly events: readonly StreamResponse[];
};

/** The outcome of a commit: the task as stored afterwards and the events it appended. */
export type TaskCommit = {
  readonly stored: StoredWorkflowTask;
  readonly appended: readonly TaskEventEntry[];
};

export type TaskEventLog = {
  /** The task record, or `undefined` when the scope holds no task with this identifier. */
  read(scope: A2ACallerScope, taskId: string): Promise<StoredWorkflowTask | undefined>;
  /**
   * Store a new task with its first events and its owner record. Resolves `undefined`,
   * writing nothing, when the scope already holds a task with this identifier, and
   * `'foreign'`, writing nothing, when another owner's task already has it.
   */
  create(
    scope: A2ACallerScope,
    owner: TaskOwner,
    mutation: TaskMutation,
  ): Promise<TaskCommit | 'foreign' | undefined>;
  /**
   * Apply `mutate` to the stored task and append its events atomically. `mutate` may
   * run more than once, after a lost compare-and-swap, and returns `undefined` for no
   * change. Resolves `undefined` when the task does not exist.
   */
  commit(
    scope: A2ACallerScope,
    taskId: string,
    mutate: (stored: StoredWorkflowTask) => TaskMutation | undefined,
  ): Promise<TaskCommit | undefined>;
  /** Every event after `afterSequence`, then each new one as it is committed. */
  follow(
    scope: A2ACallerScope,
    taskId: string,
    afterSequence: number,
  ): AsyncGenerator<TaskEventEntry, void, undefined>;
  /** The owner a task's record names, or `undefined` for an identifier no task has. */
  findOwner(taskId: string): Promise<TaskOwner | undefined>;
};

/** Sequences are zero-padded in keys so a prefix scan returns them in order. */
const SEQUENCE_DIGITS = 16;

function eventKey(taskKey: string, sequence: number): string {
  return taskEventPrefix(taskKey) + String(sequence).padStart(SEQUENCE_DIGITS, '0');
}

/** The opaque cursor of the event with this sequence. */
export function taskEventCursor(sequence: number): string {
  return String(sequence);
}

function readStored(record: Record<string, unknown>): StoredWorkflowTask {
  const sequence = record['sequence'];
  return {
    task: Task.fromJSON(record['task']),
    sequence: typeof sequence === 'number' ? sequence : -1,
  };
}

function readOwner(record: Record<string, unknown>): TaskOwner | undefined {
  const { tenant, authenticated, userName } = record;
  if (
    typeof tenant !== 'string' ||
    typeof authenticated !== 'boolean' ||
    typeof userName !== 'string'
  ) {
    return undefined;
  }
  return { tenant, authenticated, userName };
}

function readEntry(key: string, bytes: Uint8Array): TaskEventEntry {
  const record = decodeRecord(key, bytes);
  const sequence = Number(record['sequence']);
  return {
    sequence,
    cursor: taskEventCursor(sequence),
    event: StreamResponse.fromJSON(record['event']),
  };
}

type EventListener = (entries: readonly TaskEventEntry[]) => void;

/**
 * Create the event log of one workflow agent over `storage`, under `namespace`.
 * `now` stamps each saved record, as the task store does.
 */
export function createTaskEventLog(options: {
  readonly storage: Storage;
  readonly namespace: string;
  readonly now: () => number;
}): TaskEventLog {
  const { storage, namespace, now } = options;
  const listeners = new Map<string, Set<EventListener>>();

  function notify(key: string, entries: readonly TaskEventEntry[]): void {
    if (entries.length === 0) return;
    for (const listener of listeners.get(key) ?? []) listener(entries);
  }

  /**
   * The operations that save `mutation` after the event with `sequence`, and the
   * entries it appends.
   */
  function writeMutation(
    key: string,
    sequence: number,
    mutation: TaskMutation,
  ): { operations: BatchOperation[]; commit: TaskCommit } {
    const operations: BatchOperation[] = [];
    const appended: TaskEventEntry[] = [];
    let next = sequence;
    for (const event of mutation.events) {
      next += 1;
      appended.push({ sequence: next, cursor: taskEventCursor(next), event });
      operations.push({
        type: 'put',
        key: eventKey(key, next),
        value: encodeRecord({ sequence: next, event: StreamResponse.toJSON(event) }),
      });
    }
    operations.push({
      type: 'put',
      key,
      value: encodeRecord({ task: Task.toJSON(mutation.task), savedAt: now(), sequence: next }),
    });
    return { operations, commit: { stored: { task: mutation.task, sequence: next }, appended } };
  }

  async function* replay(key: string, afterSequence: number): AsyncGenerator<TaskEventEntry> {
    const start = eventKey(key, afterSequence + 1);
    for await (const [entryKey, bytes] of storage.scan(taskEventPrefix(key))) {
      if (entryKey >= start) yield readEntry(entryKey, bytes);
    }
  }

  return {
    async read(scope, taskId) {
      const key = scopedKey('task', scope, taskId);
      const bytes = await storage.get(key);
      return bytes === null ? undefined : readStored(decodeRecord(key, bytes));
    },

    async create(scope, owner, mutation) {
      const key = scopedKey('task', scope, mutation.task.id);
      const ownerKey = workflowTaskKey(namespace, mutation.task.id);
      const created = await withCompareAndSwap<TaskCommit | 'foreign' | undefined>(
        storage,
        key,
        async () => {
          if ((await storage.get(key)) !== null) return { result: undefined };
          const existingOwner = await storage.get(ownerKey);
          if (existingOwner !== null) return { result: 'foreign' as const };
          const { operations, commit } = writeMutation(key, -1, mutation);
          operations.push({ type: 'put', key: ownerKey, value: encodeRecord({ ...owner }) });
          return {
            conditions: [
              { key, expectedValue: null },
              { key: ownerKey, expectedValue: null },
            ],
            operations,
            result: commit,
          };
        },
      );
      if (created !== undefined && created !== 'foreign') notify(key, created.appended);
      return created;
    },

    async commit(scope, taskId, mutate) {
      const key = scopedKey('task', scope, taskId);
      const committed = await withCompareAndSwap(storage, key, async () => {
        const current = await storage.get(key);
        if (current === null) return { result: undefined };
        const stored = readStored(decodeRecord(key, current));
        const mutation = mutate(stored);
        if (mutation === undefined) return { result: { stored, appended: [] } };
        const { operations, commit } = writeMutation(key, stored.sequence, mutation);
        return { conditions: [{ key, expectedValue: current }], operations, result: commit };
      });
      if (committed !== undefined) notify(key, committed.appended);
      return committed;
    },

    async *follow(scope, taskId, afterSequence) {
      const key = scopedKey('task', scope, taskId);
      const pending: TaskEventEntry[] = [];
      let wake: (() => void) | undefined;
      const listener: EventListener = (entries) => {
        pending.push(...entries);
        wake?.();
      };
      const keyListeners = listeners.get(key) ?? new Set<EventListener>();
      keyListeners.add(listener);
      listeners.set(key, keyListeners);
      let last = afterSequence;
      try {
        // Listening before replaying means no commit can fall between the two.
        for await (const entry of replay(key, last)) {
          last = entry.sequence;
          yield entry;
        }
        while (true) {
          const entry = pending.shift();
          if (entry === undefined) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = undefined;
          } else if (entry.sequence === last + 1) {
            last = entry.sequence;
            yield entry;
          } else if (entry.sequence > last + 1) {
            // Notifications of concurrent commits can arrive out of order; read the gap.
            for await (const missed of replay(key, last)) {
              last = missed.sequence;
              yield missed;
            }
          }
        }
      } finally {
        keyListeners.delete(listener);
        if (keyListeners.size === 0) listeners.delete(key);
      }
    },

    async findOwner(taskId) {
      const key = workflowTaskKey(namespace, taskId);
      const bytes = await storage.get(key);
      return bytes === null ? undefined : readOwner(decodeRecord(key, bytes));
    },
  };
}
