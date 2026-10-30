/**
 * COR-1946 — which process owns a task whose run lives only in that process's memory.
 *
 * A run with no durable workflow behind it (a `bureau.run()` or `tasks.start()` run on a Bureau
 * without a durable engine, or one admitted before its workflow was created) dies with its process.
 * The task record it leaves is `working` for ever unless a later boot settles it, and a boot may
 * only settle the tasks of a process that is gone: another process can share the same key-value
 * store and still be running its own.
 *
 * Each Bureau process draws a process id once and stamps it on every task record it admits
 * (`TaskRecord.ownerProcess`). It holds one lease record under that id, `{ "expiresAt": <epoch ms> }`,
 * renewed on the Bureau's injected timers at a third of the lease time and removed at shutdown.
 * A booting process settles a task as `failed` (finish reason {@link TASK_OWNER_LOST_FINISH_REASON})
 * only when the lease of the task's owner is absent or expired by the booting process's own injected
 * clock, and the settlement is a compare-and-swap on the exact lease value that was read, so a renewal
 * that lands first defeats it. A lease that is still current is never touched; the sweep looks again
 * when it would lapse, so a crash that is restarted within the lease time is still settled.
 *
 * What this does not do: it does not stop a stalled-but-alive owner's run. If an owner stalls past
 * its lease and a peer settles its task, the run goes on in the owner. `owner-lost` is an inference,
 * so when that run really ends, the owner's settlement replaces it (the registry announces it as the
 * first settlement); a failure notification written for the inference is dismissed if the real
 * result is not a failure. A lapsed lease whose owner owes no task is removed by the sweep.
 *
 * @module process-lease
 */

import type {
  RuntimeClock,
  RuntimeIdentifiers,
  RuntimeTimeoutHandle,
  RuntimeTimers,
} from '@lostgradient/lifecycle';
import type { ConditionalTextValueStore } from '@lostgradient/storage';

import type { TaskRecord, TaskSettlement } from './task-registry';
import { TASK_OWNER_LOST_FINISH_REASON } from './task-registry';

/** Where a process's lease is stored. */
const LEASE_PREFIX = 'bureau-process:v1:';

/** How long a lease lasts without a renewal. */
export const PROCESS_LEASE_MILLISECONDS = 30_000;

/** The key of one process's lease record. */
export function processLeaseKey(processId: string): string {
  return `${LEASE_PREFIX}${processId}`;
}

/** What a reader found at a process's lease key. */
export type ProcessLeaseReading =
  /** No lease record: the process never held one, or released it at shutdown. */
  | { readonly state: 'absent'; readonly raw: null }
  /** Held and not yet expired by the reader's clock; `expiresAt` is epoch milliseconds. */
  | { readonly state: 'live'; readonly raw: string; readonly expiresAt: number }
  /** Held and expired by the reader's clock. */
  | { readonly state: 'expired'; readonly raw: string }
  /** A value that is not a lease. Never treated as expired: the owner is unknown, not gone. */
  | { readonly state: 'unreadable'; readonly raw: string };

/** Reads the lease of `processId` against `now` (epoch milliseconds). */
export async function readProcessLease(
  kv: ConditionalTextValueStore,
  processId: string,
  now: number,
): Promise<ProcessLeaseReading> {
  const raw = await kv.get(processLeaseKey(processId));
  if (raw === null) return { state: 'absent', raw: null };
  let expiresAt: unknown;
  try {
    expiresAt = (JSON.parse(raw) as { expiresAt?: unknown } | null)?.expiresAt;
  } catch {
    return { state: 'unreadable', raw };
  }
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return { state: 'unreadable', raw };
  }
  return expiresAt > now ? { state: 'live', raw, expiresAt } : { state: 'expired', raw };
}

/** The lease this process holds. */
export interface ProcessLease {
  /** This process's id, stamped on every task record it admits; `undefined` when it holds no lease. */
  readonly processId: string | undefined;
  /**
   * Writes the lease. With `renewal: 'timer'` it also renews it on the injected timers; with
   * `'manual'` (a host that drives its own maintenance and wants no timer of the Bureau's) only
   * {@link renew} extends it. Resolves once the first lease is stored.
   */
  start(renewal: 'timer' | 'manual'): Promise<void>;
  /** Extends the lease by a full lease time. Does nothing once the lease has been released. */
  renew(): Promise<void>;
  /** Stops renewing, without touching the stored lease. Idempotent. */
  halt(): void;
  /** Stops renewing and removes the stored lease, so a peer need not wait for it to lapse. */
  release(): Promise<void>;
}

/** What {@link openProcessLease} needs. */
export interface OpenProcessLeaseOptions {
  /** The Bureau's key-value store, or `undefined` for a Bureau with no storage. */
  readonly kv: ConditionalTextValueStore | undefined;
  /** What the Bureau's storage reports as `capabilities().persistence`, when it has any. */
  readonly persistence: string | undefined;
  readonly clock: Pick<RuntimeClock, 'now'>;
  readonly timers: Pick<RuntimeTimers, 'setInterval' | 'clearInterval'>;
  readonly identifiers: RuntimeIdentifiers;
  readonly diagnose: (message: string, cause?: unknown) => void;
  /** How long a lease lasts without renewal. Renewed three times in this window. */
  readonly leaseMilliseconds?: number;
}

/** A lease that holds nothing: for a Bureau whose store dies with its process. */
const NO_LEASE: ProcessLease = {
  processId: undefined,
  start: () => Promise.resolve(),
  renew: () => Promise.resolve(),
  halt: () => undefined,
  release: () => Promise.resolve(),
};

/**
 * Holds and renews this process's lease. A Bureau whose store dies with its process (no storage, or
 * memory storage) has no second process and no later boot, so it gets {@link NO_LEASE}: no id, no
 * marker on its tasks, no timer.
 */
export function openProcessLease(options: OpenProcessLeaseOptions): ProcessLease {
  const { kv, clock, timers, diagnose } = options;
  if (kv === undefined || (options.persistence !== 'local' && options.persistence !== 'remote')) {
    return NO_LEASE;
  }
  const processId = options.identifiers.next('bureau-process');
  const leaseMilliseconds = options.leaseMilliseconds ?? PROCESS_LEASE_MILLISECONDS;
  const key = processLeaseKey(processId);
  let timer: { readonly handle: RuntimeTimeoutHandle } | undefined;
  let released = false;
  /** The renewals in flight, so a release is never overtaken by a write that was already started. */
  const writes = new Set<Promise<void>>();

  const write = (): Promise<void> => {
    const pending = kv.set(key, JSON.stringify({ expiresAt: clock.now() + leaseMilliseconds }));
    writes.add(pending);
    const settled = (): void => void writes.delete(pending);
    pending.then(settled, settled);
    return pending;
  };

  return {
    processId,
    async start(renewal) {
      await write();
      if (renewal === 'manual') return;
      timer = {
        handle: timers.setInterval(
          () => {
            if (released) return;
            write().catch((error: unknown) => {
              diagnose(`Could not renew the lease of process "${processId}"`, error);
            });
          },
          Math.floor(leaseMilliseconds / 3),
        ),
      };
    },
    async renew() {
      if (!released) await write();
    },
    halt() {
      released = true;
      if (timer !== undefined) timers.clearInterval(timer.handle);
      timer = undefined;
    },
    async release() {
      this.halt();
      await Promise.allSettled(writes);
      await kv.delete(key);
    },
  };
}

/** How soon a task whose settlement lost a compare-and-swap is judged again: a renewal interval. */
export const LOST_RACE_RETRY_MILLISECONDS = Math.floor(PROCESS_LEASE_MILLISECONDS / 3);

/** What {@link settleAbandonedTasks} reads and writes. */
export interface SettleAbandonedTasksOptions {
  readonly kv: ConditionalTextValueStore;
  /** This process's id: its own tasks are never abandoned by it. */
  readonly processId: string;
  readonly now: () => number;
  readonly nowISO: () => string;
  readonly unsettled: () => Promise<readonly TaskRecord[]>;
  /** Whether a run of this task is live in this process. */
  readonly hasLiveRun: (taskId: string) => boolean;
  /**
   * Whether a durable workflow records the task, so its settlement is the engine's to read (and a
   * suspended or running one is the recovery's to reattach), not this process-local rule's.
   */
  readonly isDurablyRecorded: (taskId: string) => Promise<boolean>;
  /**
   * Settles the task if and only if it is still unsettled, still owned by `ownerProcess`, and the
   * owner's lease still reads exactly `lease.expected`. `'lost-race'` means the record or the lease
   * changed under the write, so the task is worth judging again soon.
   */
  readonly settleAbandoned: (
    taskId: string,
    ownerProcess: string,
    lease: { readonly key: string; readonly expected: string | null },
    settlement: TaskSettlement,
  ) => Promise<'written' | 'lost-race' | 'not-applicable'>;
  readonly diagnose: (message: string, cause?: unknown) => void;
}

/** What one sweep found. */
export interface AbandonedTaskSweep {
  /** The tasks it settled. */
  readonly settled: readonly string[];
  /**
   * When (epoch milliseconds) to look again: the earliest lease it left alone lapses, or a
   * settlement it lost a race for ({@link LOST_RACE_RETRY_MILLISECONDS} from now). `undefined` when
   * nothing is left to look at.
   */
  readonly lookAgainAt: number | undefined;
}

/**
 * Settles every unsettled task whose owning process is gone: a record that names an owner other
 * than this process, with no live run here and no durable workflow, whose owner's lease is absent
 * or expired. A record with no owner (written before the marker existed) is left as it is: nothing
 * says who owns it, and a guess could settle a live peer's task.
 */
export async function settleAbandonedTasks(
  options: SettleAbandonedTasksOptions,
): Promise<AbandonedTaskSweep> {
  const settled: string[] = [];
  let lookAgainAt: number | undefined;
  const readings = new Map<string, ProcessLeaseReading>();
  /** The owners with an unsettled task, by task, until this sweep settles it: their lease stays. */
  const owing = new Map<string, string>();
  for (const record of await options.unsettled()) {
    const owner = record.ownerProcess;
    if (owner !== undefined) owing.set(record.taskId, owner);
    if (owner === undefined || owner === options.processId) continue;
    if (record.kind === 'schedule-fire') continue;
    if (options.hasLiveRun(record.taskId)) continue;
    if (await options.isDurablyRecorded(record.taskId)) continue;
    // One reading per owner per sweep: every task of a process is judged by the same lease.
    let reading = readings.get(owner);
    if (reading === undefined) {
      reading = await readProcessLease(options.kv, owner, options.now());
      readings.set(owner, reading);
    }
    if (reading.state === 'live') {
      lookAgainAt = Math.min(lookAgainAt ?? reading.expiresAt, reading.expiresAt);
      continue;
    }
    if (reading.state === 'unreadable') {
      options.diagnose(
        `The lease of process "${owner}" is not readable; its task "${record.taskId}" is left as it is`,
      );
      continue;
    }
    try {
      const wrote = await options.settleAbandoned(
        record.taskId,
        owner,
        { key: processLeaseKey(owner), expected: reading.raw },
        {
          at: options.nowISO(),
          status: 'failed',
          finishReason: TASK_OWNER_LOST_FINISH_REASON,
          message: 'The process that was running this task stopped before it finished.',
        },
      );
      if (wrote === 'written') {
        settled.push(record.taskId);
        owing.delete(record.taskId);
        continue;
      }
      if (wrote === 'lost-race') {
        const retryAt = options.now() + LOST_RACE_RETRY_MILLISECONDS;
        lookAgainAt = Math.min(lookAgainAt ?? retryAt, retryAt);
      }
    } catch (error) {
      options.diagnose(`Could not settle abandoned task "${record.taskId}"`, error);
    }
    // Not settled here: the owner still owes this task, so its lease is kept for the next sweep.
  }
  try {
    await reclaimLapsedLeases(options, new Set(owing.values()));
  } catch (error) {
    options.diagnose('Could not remove the lapsed lease of a stopped process', error);
  }
  return { settled, lookAgainAt };
}

/**
 * Removes the lease of every other process that has lapsed and owes no unsettled task, so the
 * leases of processes that crashed do not pile up in the store. The delete is a compare-and-swap on
 * the value judged lapsed: an owner that renewed first keeps its lease. A stalled owner that
 * writes a task after this is judged like any owner with no lease; its next renewal restores it.
 */
async function reclaimLapsedLeases(
  options: SettleAbandonedTasksOptions,
  owing: ReadonlySet<string>,
): Promise<void> {
  for (const key of await options.kv.list(LEASE_PREFIX)) {
    const owner = key.slice(LEASE_PREFIX.length);
    if (owner === options.processId || owing.has(owner)) continue;
    const reading = await readProcessLease(options.kv, owner, options.now());
    if (reading.state !== 'expired') continue;
    await options.kv.conditionalBatch(
      [{ key, expectedValue: reading.raw }],
      [{ type: 'delete', key }],
    );
  }
}

/** What {@link createAbandonedTaskSweeper} needs, beyond the sweep's own reads and writes. */
export interface CreateAbandonedTaskSweeperOptions extends Omit<
  SettleAbandonedTasksOptions,
  'kv' | 'processId'
> {
  readonly lease: ProcessLease;
  readonly kv: ConditionalTextValueStore | undefined;
  readonly timers: Pick<RuntimeTimers, 'setTimeout' | 'clearTimeout'>;
  /**
   * Whether the sweeper may arm a timer to look again when a lease it left alone would lapse.
   * `false` for a host that runs no timer of the Bureau's: its next maintenance pass looks again.
   */
  readonly rearm: boolean;
}

/** Runs {@link settleAbandonedTasks} and looks again when the lease it left alone would lapse. */
export interface AbandonedTaskSweeper {
  /** One sweep. Never rejects: a failure is diagnosed. A sweep after {@link close} does nothing. */
  run(): Promise<void>;
  /** Cancels the pending look-again and waits for the sweeps in flight. */
  close(): Promise<void>;
}

/** Builds the sweeper; with no lease it sweeps nothing. */
export function createAbandonedTaskSweeper(
  options: CreateAbandonedTaskSweeperOptions,
): AbandonedTaskSweeper {
  const { lease, kv, timers } = options;
  const processId = lease.processId;
  const passes = new Set<Promise<void>>();
  let pending: { readonly handle: RuntimeTimeoutHandle } | undefined;
  let closed = false;

  const sweep = async (): Promise<void> => {
    if (kv === undefined || processId === undefined) return;
    try {
      const swept = await settleAbandonedTasks({ ...options, kv, processId });
      if (swept.lookAgainAt === undefined || closed || !options.rearm) return;
      pending = {
        handle: timers.setTimeout(
          () => {
            pending = undefined;
            void run();
          },
          Math.max(swept.lookAgainAt - options.now(), 0) + 1,
        ),
      };
    } catch (error) {
      options.diagnose('Could not settle the tasks of stopped processes', error);
    }
  };

  const run = async (): Promise<void> => {
    if (closed) return;
    if (pending !== undefined) timers.clearTimeout(pending.handle);
    pending = undefined;
    const pass = sweep();
    passes.add(pass);
    try {
      await pass;
    } finally {
      passes.delete(pass);
    }
  };

  return {
    run,
    async close() {
      closed = true;
      if (pending !== undefined) timers.clearTimeout(pending.handle);
      pending = undefined;
      await Promise.allSettled(passes);
    },
  };
}
