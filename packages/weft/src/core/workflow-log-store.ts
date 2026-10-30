/**
 * The persisted `ctx.log` lines of a workflow run (COR-1811): a bounded, buffered sink that writes
 * the lines the engine emits, a reader that serves them per run and per step, and a retention pass
 * that drops the lines of runs that went quiet.
 *
 * The sink is the host's `EngineOptions.onLog`; the engine is handed the same store through
 * `EngineOptions.workflowLogs`, which is how `Engine.getLogs` reads (after flushing the buffered
 * tail), how a shutdown flushes, and how a purge removes a run's lines with the run.
 *
 * Bounds, all documented on {@link WorkflowLogStoreOptions}: a run keeps at most
 * `maximumLinesPerRun` lines (500 by default), evicting the oldest and counting each in
 * {@link WorkflowLogsResult.dropped}; a line's message and attributes are each cut to
 * `maximumLineBytes` (2 KiB by default), with a visible marker.
 *
 * Durability: the sink is asynchronous. A line is buffered in memory and written in a batch on the
 * next turn, on {@link WorkflowLogStore.flush}, and on engine shutdown (`shutdown()` or `await using`;
 * a synchronous `using` disposal cannot await storage, so it flushes nothing). A crash can lose the lines
 * of the turn that had not been written yet; that is accepted. A write that fails drops its batch
 * and reports to {@link WorkflowLogStoreOptions.onError}; a log must never fail the run it describes.
 *
 * The store assumes one writer per run, which Weft's one-engine-per-store rule already guarantees:
 * each write reads the run's counter record, extends it, and writes it back with the lines.
 *
 * @module core/workflow-log-store
 */

import {
  storageDeletePrefix,
  tryDecodeStorageKeyComponent,
  type BatchOperation,
  type Storage,
} from '@lostgradient/storage';

import { KEYS } from '../storage/keys.ts';
import type { WorkflowLogRecord } from './types/workflow-log.ts';
import {
  DEFAULT_MAXIMUM_LOG_LINES_PER_RUN,
  DEFAULT_MAXIMUM_LOG_LINE_BYTES,
  ENCODER,
  MAXIMUM_LOG_LINES_PER_RUN_LIMIT,
  cutMessage,
  decodeCounter,
  decodeLine,
  isNonNegativeInteger,
  sequenceOfKey,
  serializeAttributes,
  type Counter,
  type PendingLine,
  type WorkflowLogLine,
  type WorkflowLogsResult,
} from './workflow-log-codec.ts';

/** The most batch operations one storage write carries when the eviction is large. */
const EVICTION_CHUNK = 2000;

/**
 * Options for {@link createWorkflowLogStore}.
 *
 * @example
 * ```ts
 * import { createWorkflowLogStore } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/storage';
 *
 * const store = createWorkflowLogStore(new MemoryStorage(), { maximumLinesPerRun: 100 });
 * void store;
 * ```
 */
export interface WorkflowLogStoreOptions {
  /**
   * How many lines a run keeps; past it the oldest line is evicted and counted as dropped.
   * A function is read on every write, so a host can change the cap while the engine runs; one that
   * answers `undefined` gets the default. Never more than {@link MAXIMUM_LOG_LINES_PER_RUN_LIMIT}.
   * Default {@link DEFAULT_MAXIMUM_LOG_LINES_PER_RUN}.
   */
  readonly maximumLinesPerRun?: number | (() => number | undefined);
  /**
   * How many UTF-8 bytes a line's message, and separately its serialized attributes, may take;
   * a longer message is cut and marked, longer attributes are dropped. Default
   * {@link DEFAULT_MAXIMUM_LOG_LINE_BYTES}.
   */
  readonly maximumLineBytes?: number;
  /** The clock the retention pass measures a run's last write against. Default `Date.now`. */
  readonly getNow?: () => number;
  /** Told about a write or prune that failed. The failed batch is dropped; the run is unaffected. */
  readonly onError?: (error: unknown) => void;
}

/**
 * A persisted-log sink, reader, and retention pass over one storage backend.
 *
 * @example
 * ```ts
 * import { createWorkflowLogStore } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/storage';
 *
 * const store = createWorkflowLogStore(new MemoryStorage());
 * store.sink({
 *   level: 'info',
 *   message: 'started',
 *   workflowId: 'run-1',
 *   workflowType: 'order',
 *   timestamp: 1,
 *   step: 0,
 * });
 * await store.flush();
 * console.log((await store.read('run-1')).lines.length); // 1
 * ```
 */
export interface WorkflowLogStore {
  /** Buffer one record for writing. Pass it as `EngineOptions.onLog`. Never throws. */
  readonly sink: (record: WorkflowLogRecord) => void;
  /** Resolve once every buffered line has been written (or its batch dropped and reported). */
  flush(): Promise<void>;
  /**
   * Read a run's kept lines, oldest first, after flushing the buffered tail. `step` narrows the
   * read to the lines logged before that durable step; leave it out for every line.
   */
  read(
    workflowId: string,
    options?: { readonly step?: number | undefined },
  ): Promise<WorkflowLogsResult>;
  /**
   * Remove the lines and the counter of every run whose last line was written more than
   * `olderThan` milliseconds ago, and answer how many runs that was.
   */
  prune(options: { readonly olderThan: number }): Promise<{ readonly runs: number }>;
}

/** One run's buffer: the lines waiting for a write, and those the in-memory bound already shed. */
interface RunBuffer {
  lines: PendingLine[];
  shed: number;
}

/**
 * Create the {@link WorkflowLogStore} over `storage`: the same backend the engine uses, because
 * the engine reads and purges through it.
 *
 * @example
 * ```ts
 * import { Engine, createWorkflowLogStore } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/storage';
 *
 * const storage = new MemoryStorage();
 * const logs = createWorkflowLogStore(storage);
 * const engine = new Engine({ storage, onLog: logs.sink, workflowLogs: logs });
 * void engine;
 * ```
 */
export function createWorkflowLogStore(
  storage: Storage,
  options: WorkflowLogStoreOptions = {},
): WorkflowLogStore {
  const getNow = options.getNow ?? Date.now;
  const maximumLineBytes =
    typeof options.maximumLineBytes === 'number' &&
    Number.isSafeInteger(options.maximumLineBytes) &&
    options.maximumLineBytes > 0
      ? options.maximumLineBytes
      : DEFAULT_MAXIMUM_LOG_LINE_BYTES;
  const buffers = new Map<string, RunBuffer>();
  let chain: Promise<void> = Promise.resolve();
  let scheduled = false;

  const maximumLines = (): number => {
    const configured = options.maximumLinesPerRun;
    const value = typeof configured === 'function' ? configured() : configured;
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? Math.min(value, MAXIMUM_LOG_LINES_PER_RUN_LIMIT)
      : DEFAULT_MAXIMUM_LOG_LINES_PER_RUN;
  };

  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // A reporter must not break the log lane either.
    }
  };

  const loadCounter = async (workflowId: string): Promise<Counter> =>
    decodeCounter(await storage.get(KEYS.workflowLogCounter(workflowId))) ?? {
      next: 0,
      first: 0,
      dropped: 0,
      updatedAt: 0,
    };

  /** Write one run's buffered lines and evict what the cap no longer allows. */
  const writeRun = async (workflowId: string, buffer: RunBuffer): Promise<void> => {
    const cap = maximumLines();
    const counter = await loadCounter(workflowId);
    // A batch longer than the cap would only be evicted again: keep its newest lines.
    const overflow = Math.max(0, buffer.lines.length - cap);
    const lines = buffer.lines.slice(overflow);
    counter.dropped += buffer.shed + overflow;
    const operations: BatchOperation[] = [];
    for (const line of lines) {
      operations.push({
        type: 'put',
        key: KEYS.workflowLog(workflowId, counter.next),
        value: ENCODER.encode(
          JSON.stringify({
            step: line.step,
            level: line.level,
            message: line.message,
            timestamp: line.timestamp,
            workflowType: line.workflowType,
            truncated: line.truncated,
            ...(line.attributes !== undefined && { attributes: JSON.parse(line.attributes) }),
          }),
        ),
      });
      counter.next += 1;
    }
    // The lines the cap no longer allows, oldest first. All but the last EVICTION_CHUNK go in
    // batches of their own; the rest ride the batch that writes the new lines and moves the
    // counter, so a crash there loses neither the eviction nor the count.
    const evictBelow = Math.max(counter.first, counter.next - cap);
    const evicted = evictBelow - counter.first;
    const leading = Math.max(0, evicted - EVICTION_CHUNK);
    for (let start = counter.first; start < counter.first + leading; start += EVICTION_CHUNK) {
      const chunk: BatchOperation[] = [];
      const stop = Math.min(counter.first + leading, start + EVICTION_CHUNK);
      for (let sequence = start; sequence < stop; sequence++) {
        chunk.push({ type: 'delete', key: KEYS.workflowLog(workflowId, sequence) });
      }
      await storage.batch(chunk);
    }
    for (let sequence = counter.first + leading; sequence < evictBelow; sequence++) {
      operations.push({ type: 'delete', key: KEYS.workflowLog(workflowId, sequence) });
    }
    counter.first = evictBelow;
    counter.dropped += evicted;
    counter.updatedAt = getNow();
    operations.push({
      type: 'put',
      key: KEYS.workflowLogCounter(workflowId),
      value: ENCODER.encode(JSON.stringify(counter)),
    });
    await storage.batch(operations);
  };

  /** Write every run's buffer. Runs only inside {@link enqueue}, so two writes never overlap. */
  const drain = async (): Promise<void> => {
    scheduled = false;
    // A snapshot: a line logged while a run's write is in flight starts the next drain, so a
    // workflow that logs on every step cannot keep this one (and everything queued behind it) going.
    const pending = Array.from(buffers);
    buffers.clear();
    for (const [workflowId, buffer] of pending) {
      try {
        await writeRun(workflowId, buffer);
      } catch (error) {
        report(error);
      }
    }
  };

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = chain.then(work);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      void enqueue(drain);
    });
  };

  const flush = (): Promise<void> => enqueue(drain);

  const sink = (record: WorkflowLogRecord): void => {
    try {
      const message = cutMessage(record.message, maximumLineBytes);
      const attributes = serializeAttributes(record.attributes, maximumLineBytes);
      const line: PendingLine = {
        step: isNonNegativeInteger(record.step) ? record.step : null,
        level: record.level,
        message: message.text,
        timestamp: record.timestamp,
        workflowType: record.workflowType,
        ...(attributes.json !== undefined && { attributes: attributes.json }),
        truncated: message.cut || attributes.dropped,
      };
      const buffer = buffers.get(record.workflowId) ?? { lines: [], shed: 0 };
      buffers.set(record.workflowId, buffer);
      buffer.lines.push(line);
      // The buffer is bounded by the cap too, so a run that logs without yielding cannot grow it.
      const cap = maximumLines();
      if (buffer.lines.length > cap) {
        buffer.shed += buffer.lines.length - cap;
        buffer.lines.splice(0, buffer.lines.length - cap);
      }
      schedule();
    } catch (error) {
      report(error);
    }
  };

  const read: WorkflowLogStore['read'] = async (workflowId, readOptions) => {
    await flush();
    const prefix = KEYS.workflowLogPrefix(workflowId);
    const lines: WorkflowLogLine[] = [];
    for await (const [key, bytes] of storage.scan(prefix)) {
      const sequence = sequenceOfKey(prefix, key);
      if (sequence === undefined) continue;
      const line = decodeLine(sequence, bytes);
      if (line === undefined) continue;
      if (readOptions?.step !== undefined && line.step !== readOptions.step) continue;
      lines.push(line);
    }
    const counter = decodeCounter(await storage.get(KEYS.workflowLogCounter(workflowId)));
    return { lines, dropped: counter?.dropped ?? 0 };
  };

  const prune: WorkflowLogStore['prune'] = (pruneOptions) =>
    enqueue(async () => {
      await drain();
      const cutoff = getNow() - pruneOptions.olderThan;
      const expired: string[] = [];
      for await (const [key, bytes] of storage.scan(KEYS.workflowLogCounterPrefix())) {
        const counter = decodeCounter(bytes);
        const encoded = key.slice(KEYS.workflowLogCounterPrefix().length);
        const workflowId = tryDecodeStorageKeyComponent(encoded);
        if (counter !== undefined && workflowId !== null && counter.updatedAt < cutoff) {
          expired.push(workflowId);
        }
      }
      let runs = 0;
      for (const workflowId of expired) {
        try {
          await storageDeletePrefix(storage, KEYS.workflowLogPrefix(workflowId));
          await storage.delete(KEYS.workflowLogCounter(workflowId));
          runs += 1;
        } catch (error) {
          report(error);
        }
      }
      return { runs };
    });

  return { sink, flush, read, prune };
}
