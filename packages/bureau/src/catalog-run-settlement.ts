/**
 * The catalog-run settlement hook: one internal event that fires for every `bureau.run()` run
 * when it reaches a terminal state, whether it was dispatched by this process or recovered
 * after a restart.
 *
 * ## Why one hook
 *
 * A catalog run ends in one of two places. A fresh dispatch's handle resolves
 * `handle.result()` in the process that started it. A run recovered in flight has no handle
 * of the caller's; the AB-240 recovery monitor (`monitorRecoveredCatalogRun`) observes it end.
 * A consumer that wants to know a catalog run ended (the task registry settling a task, a
 * snapshot reference taking its final state) would otherwise have to watch both, and a
 * consumer that watched only the first silently missed every run that crossed a restart. This
 * hook is the single place both publish to, so a subscriber sees every catalog run end once,
 * from either path.
 *
 * ## Contract
 *
 * - {@link CatalogRunSettlementHook.publish} is called by Bureau, once per terminal state per
 *   run per process, after the run's result is known. A run that ends in a process that is
 *   then killed is published by the process that recovers it, if it is still in flight there,
 *   and is otherwise reconciled from the durable state at boot (task records only).
 * - A listener receives a {@link CatalogRunSettlement}: the run id, the agent, how it ended
 *   (`completed`, `failed` or `canceled`), the finish reason, a bounded error message for a
 *   failure, the answer text for a completed run, and whether the run was recovered.
 * - Listeners run in subscription order. One that throws or rejects is isolated (its failure
 *   goes to the diagnostic sink) and never stops the others or the publisher.
 * - `publish` resolves once every listener has settled, so a caller can wait for the writes a
 *   listener started. It never rejects.
 * - Not a public API: subscribers are inside this package, handed the hook by `createBureau`.
 * - A subscriber must be idempotent per `(runId, status)`. Under `ownership: 'none'` two
 *   processes can each own a copy of one run, so each publishes once for it; a subscriber that
 *   acts twice on the same settlement must reach the same state. (The task registry's settler
 *   does: it writes the same settlement, and a record is written once.)
 * - It publishes for every end, however the record fared: a fresh dispatch whose task record
 *   could not be written still publishes.
 * - It publishes only an end the durable run actually reached. A handle whose `result()` rejects
 *   is read against the durable run (see {@link DurableEndReader}): a run the durable engine
 *   holds `failed` publishes `failed`, and one it holds `completed` or `canceled` publishes
 *   that. A run that is still running, or whose state cannot be read, publishes nothing, because
 *   the rejection was the engine being disposed (a graceful shutdown) rather than the run
 *   ending: the run resumes at the next boot, and a subscriber that treated the rejection as an
 *   end would settle a task and a snapshot reference the resumed run still needs. Only a run
 *   with no durable record (a Bureau without a durable engine) publishes `failed` for a
 *   rejection.
 *
 * ## Who publishes, and what a subscriber filters
 *
 * The hook publishes for every run that goes through the recovery path, and for the fresh runs
 * Bureau follows to their end, which is not the same set as "every top-level task":
 *
 * - a fresh `bureau.run()` dispatch is settled from its run store's terminal action, not from here;
 * - a fresh child run, goal attempt or workflow step is followed here (`publishFreshCatalogRun`,
 *   called from `create-bureau.ts`'s `trackSubordinateRun`) once its start committed, and publishes
 *   with `recovered: false`; the task settler is the only subscriber that acts on it, because the
 *   others filter on `recovered`;
 * - a run recovered after a restart publishes with `recovered: true`, and that includes a recovered
 *   child run, goal attempt and workflow step.
 *
 * A subscriber therefore filters what it needs. The snapshot-reference subscriber (in
 * `create-bureau.ts`) filters on `recovered`, because a fresh dispatch settles its own reference
 * where it is dispatched; it settles a child run's or a goal attempt's reference too, which is
 * right, as those hold a snapshot as well. The task settler (`catalog-task-settlement.ts`) settles
 * a record that exists for any run, and writes one for a recovered run only when the run's claim
 * stores a `taskOrigin` (a child, an attempt or a step started since COR-1868) or the run is a
 * recovered top-level run.
 *
 * @module catalog-run-settlement
 */
import type { CleanupAcknowledgement } from '@lostgradient/operative';
import { yieldToPortableEventLoop } from '@lostgradient/weft';

import { serializeUnknownError } from './serialization';
import { settledTaskState } from './task-registry';
import type { DiagnosticSink } from './types';

/** How a catalog run ended. */
export interface CatalogRunSettlement {
  readonly runId: string;
  readonly agentName: string;
  readonly status: 'completed' | 'failed' | 'canceled';
  readonly finishReason: string | null;
  /** The failure's text, at most 1,000 characters, for a run that failed. */
  readonly message: string | null;
  /** The run's answer, for a run that completed with one. Unbounded: a subscriber bounds it. */
  readonly content: string | null;
  /** Whether this process recovered the run after a restart rather than dispatching it. */
  readonly recovered: boolean;
}

export type CatalogRunSettlementListener = (
  settlement: CatalogRunSettlement,
) => void | Promise<void>;

export interface CatalogRunSettlementHook {
  /** Calls `listener` for every catalog run that settles from now on. Returns its unsubscribe. */
  subscribe(listener: CatalogRunSettlementListener): () => void;
  /** Tells every subscriber that a catalog run settled. Never rejects. */
  publish(settlement: CatalogRunSettlement): Promise<void>;
}

/** How many event-loop turns a shutdown waits, by default, for the runs still to end that settlements are following. */
export const SETTLEMENT_TRACKER_MAXIMUM_TURNS = 50;

/**
 * The settlements being published, so a shutdown can wait for the writes they start.
 *
 * A publish has two parts. It first waits for its run to end, which has no bound of its own (a
 * run that never ends never publishes), and then, once the end is known, it reads the durable
 * run and runs every listener: a finite amount of storage work, but real I/O, whose duration
 * depends on the database and on the load the host is under, not on a count of event-loop turns.
 * The first part is bounded by a shutdown; the second is waited for, because the writes it starts
 * would otherwise land on storage the shutdown has already closed.
 */
export interface CatalogSettlementTracker {
  /** Follows a publish (a promise that never rejects, or whose rejection is ignored) until it ends. */
  follow(publishing: Promise<void>): void;
  /**
   * Marks the part of a followed publish that starts once its run's end is known: `work` is
   * called at once, and {@link CatalogSettlementTracker.settled} waits for it however long it
   * takes. Returns what `work` returns.
   */
  commit<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Waits up to `maximumTurns` event-loop turns for every followed publish to see its run end,
   * then stops waiting for the ones whose runs have not ended. A publish whose run has ended (see
   * {@link CatalogSettlementTracker.commit}) is waited for until it finishes: that is a bound on
   * waiting for a run, not on the storage work that records how it ended.
   */
  settled(maximumTurns?: number): Promise<void>;
}

/**
 * A fresh dispatch publishes after its handle's result is known, and a recovered run after its
 * monitor's: for a run that disposing the engine ended, that is after `shutdown()` has moved on,
 * and the writes the publish starts would find storage closed. A shutdown waits on this tracker
 * before it closes storage.
 */
export function createCatalogSettlementTracker(): CatalogSettlementTracker {
  const inFlight = new Set<Promise<void>>();
  const committing = new Set<Promise<unknown>>();
  return {
    follow(publishing) {
      const followed: Promise<void> = publishing
        .catch(() => undefined)
        .finally(() => void inFlight.delete(followed));
      inFlight.add(followed);
    },
    commit(work) {
      const committed = work();
      const forgotten = (): void => void committing.delete(committed);
      committing.add(committed);
      committed.then(forgotten, forgotten);
      return committed;
    },
    async settled(maximumTurns = SETTLEMENT_TRACKER_MAXIMUM_TURNS) {
      for (let turn = 0; turn < maximumTurns && inFlight.size > 0; turn += 1) {
        await yieldToPortableEventLoop();
      }
      while (committing.size > 0) await Promise.allSettled(committing);
    },
  };
}

/** Creates the hook. `diagnose` receives the failure of a listener that throws. */
export function createCatalogRunSettlementHook(diagnose: DiagnosticSink): CatalogRunSettlementHook {
  const listeners = new Set<CatalogRunSettlementListener>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async publish(settlement) {
      for (const listener of listeners) {
        try {
          await listener(settlement);
        } catch (error) {
          diagnose({
            level: 'error',
            scope: 'catalog-run-settlement',
            message: `[bureau] A catalog-run settlement listener failed for run "${settlement.runId}": ${error instanceof Error ? error.message : String(error)}`,
            cause: error,
          });
        }
      }
    },
  };
}

/**
 * Where a durable run stands, as far as a rejected handle is concerned: `completed`, `failed`
 * and `canceled` are terminal states the durable engine holds; `in-flight` is every other state
 * it holds, or one that could not be read; `not-durable` is a run the engine has no record of.
 */
export type DurableEnd = 'completed' | 'failed' | 'canceled' | 'in-flight' | 'not-durable';

/** Reads a run's {@link DurableEnd}. Never rejects: a read that fails is `in-flight`. */
export type DurableEndReader = (runId: string) => Promise<DurableEnd>;

/**
 * What a handle whose `result()` rejected published: the terminal state the durable run reached,
 * or `undefined` when it reached none, and the rejection says nothing about the run (an engine
 * disposal). Shared by the fresh and the recovered path, so the rule is one.
 */
export async function settlementForRejection(options: {
  readonly runId: string;
  readonly agentName: string;
  readonly error: unknown;
  readonly recovered: boolean;
  readonly durableEnd: DurableEndReader | undefined;
}): Promise<CatalogRunSettlement | undefined> {
  const { runId, agentName, error, recovered } = options;
  let end: DurableEnd = 'not-durable';
  if (options.durableEnd !== undefined) {
    try {
      end = await options.durableEnd(runId);
    } catch {
      end = 'in-flight';
    }
  }
  if (end === 'in-flight') return undefined;
  const status = end === 'not-durable' ? 'failed' : end;
  return {
    runId,
    agentName,
    status,
    finishReason: status === 'canceled' ? 'aborted' : status === 'failed' ? 'error' : null,
    message: status === 'failed' ? serializeUnknownError(error).slice(0, 1000) : null,
    content: null,
    recovered,
  };
}

/** What {@link publishFreshCatalogRun} needs of a dispatch's handle. */
export interface FreshCatalogRunHandle {
  readonly id: string;
  result(): Promise<{
    readonly finishReason?: string | undefined;
    readonly error?: unknown;
    readonly content: string;
  }>;
  closed(): Promise<CleanupAcknowledgement>;
}

/**
 * Follows a catalog run this process dispatched to its end and publishes how it ended.
 *
 * `admit` writes the run's task record; a failure is diagnosed and does not stop the publish,
 * because the record is the task's and the settlement is the run's. A handle whose `result()`
 * rejects publishes the terminal state the durable run reached, and nothing when it reached
 * none (see {@link settlementForRejection}). A run that was canceled has its cleanup
 * followed (`followCleanup`) before it is published, so the task never shows `canceled` without
 * a cleanup to report. Never rejects.
 */
export async function publishFreshCatalogRun(options: {
  readonly handle: FreshCatalogRunHandle;
  readonly agentName: string;
  readonly admit: () => Promise<void>;
  readonly hook: Pick<CatalogRunSettlementHook, 'publish'>;
  readonly followCleanup: (closed: Promise<CleanupAcknowledgement>) => void;
  readonly diagnose: DiagnosticSink;
  /** Reads the durable run when the handle rejects. Omit for a Bureau without a durable engine. */
  readonly durableEnd?: DurableEndReader | undefined;
  /**
   * What a shutdown waits on: the admission and the publish are committed to it. Required, so a
   * caller cannot follow a run whose settlement a shutdown would not wait for.
   */
  readonly tracker: Pick<CatalogSettlementTracker, 'commit'>;
}): Promise<void> {
  const { handle, agentName, hook, diagnose, tracker } = options;
  const commit = tracker.commit;
  await commit(async () => {
    try {
      await options.admit();
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'task-registry',
        message: `[bureau] Could not record catalog task "${handle.id}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
  });
  let ended:
    | { readonly result: Awaited<ReturnType<FreshCatalogRunHandle['result']>> }
    | { readonly error: unknown };
  try {
    ended = { result: await handle.result() };
  } catch (error) {
    ended = { error };
  }
  // The run's end is known, and what follows is storage work (the durable run's state, then every
  // listener's reads and writes). A shutdown waits for it however long the database takes.
  await commit(async () => {
    let settlement: CatalogRunSettlement | undefined;
    if ('result' in ended) {
      const { result } = ended;
      settlement = {
        runId: handle.id,
        agentName,
        status: settledTaskState('completed', result.finishReason),
        finishReason: result.finishReason ?? null,
        message:
          result.error === undefined || result.error === null
            ? null
            : serializeUnknownError(result.error).slice(0, 1000),
        content: result.content,
        recovered: false,
      };
    } else {
      settlement = await settlementForRejection({
        runId: handle.id,
        agentName,
        error: ended.error,
        recovered: false,
        durableEnd: options.durableEnd,
      });
    }
    if (settlement === undefined) return;
    if (settlement.status === 'canceled') options.followCleanup(handle.closed());
    await hook.publish(settlement);
  });
}
