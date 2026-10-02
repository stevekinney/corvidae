/**
 * COR-851 — the durable store for `GoalState`, over Bureau's conditional
 * key-value store.
 *
 * Every write is a revision compare-and-swap against the exact stored text,
 * modeled on `child-topology-store.ts`. A lost race never throws: it is
 * re-read and re-evaluated a bounded number of times, then reported as
 * `stale` carrying whatever is stored now.
 *
 * Two kinds of writer share a record, and the store keeps them apart:
 *
 * - The goal controller commits state-machine transitions through
 *   {@link GoalStore.applyTransition}. Each carries the `transitionSeq` it
 *   produces and a `transitionId`. The store applies it only when the record
 *   is exactly one transition behind (`seq - 1`), so a replayed or
 *   duplicated delivery of the transition that is already the record's
 *   current one is a `duplicate` (success, no write), and anything late,
 *   conflicting, out of order, or illegal under COR-638's transition table
 *   is `rejected` or `stale` with no mutation. Terminal statuses have no
 *   outgoing edges, so a late attempt completion can neither double count
 *   usage nor resurrect a finished goal. Only the CURRENT transition is
 *   provably idempotent: the record keeps no history, so a replay of an
 *   older transition answers `stale` with the authoritative record, which a
 *   controller adopts.
 * - The control plane writes the cancellation marker, the controller
 *   restart count, and `closedAt`. These advance `revision` but never
 *   `transitionSeq`, so they can interleave with a controller transition;
 *   the transition's CAS loop re-reads and re-evaluates. Once a
 *   cancellation marker is present the marker wins: the only transition the
 *   store then accepts is the one to `canceled`.
 *
 * Every read fails closed: a record that does not decode to its exact shape
 * is treated as absent and reported through `onCorrupt`.
 */

import {
  canTransitionGoalRun,
  type GoalRunStatus,
  type GoalRunTerminalReason,
  TERMINAL_STATUS_BY_REASON,
} from '@lostgradient/operative';
import type { ConditionalTextValueStore } from '@lostgradient/weft';

import {
  type ActiveGoalWork,
  decodeGoalState,
  type DurableGoalAttempt,
  type DurableGoalUsage,
  GOAL_RECORD_KEY_PREFIX,
  GOAL_VALIDATION_MAXIMUM_BYTES,
  goalAttemptId,
  type GoalCancellationMarker,
  goalRecordKey,
  type GoalState,
  InvalidGoalStateError,
  isGoalState,
  isTerminalGoalStatus as isTerminal,
  validationByteLength,
} from './goal-state';

// ---------------------------------------------------------------------------
// Requests and results
// ---------------------------------------------------------------------------

/** One controller state-machine transition. */
export interface GoalTransitionRequest {
  readonly goalRunId: string;
  /** The `transitionSeq` this commit produces; the record must be at `seq - 1`. */
  readonly seq: number;
  /** Stable across replays; see `goalTransitionId`. */
  readonly transitionId: string;
  readonly to: GoalRunStatus;
  /** ISO-8601, from Bureau's runtime clock. */
  readonly at: string;
  readonly cause: string;
  /** Required exactly when `to` is terminal, and must map to `to` in COR-638's table. */
  readonly terminalReason?: GoalRunTerminalReason | undefined;
  readonly failureDetail?: string | undefined;
  /**
   * Inserts the attempt at `attempts.length` or replaces the one at its own
   * index. A replacement may not change a validation decision already
   * recorded: the first committed decision wins.
   */
  readonly attempt?: DurableGoalAttempt | undefined;
  /** The new aggregate. Omitted keeps the stored one. */
  readonly usage?: DurableGoalUsage | undefined;
  /** What is in flight after this transition. `null` clears; omitted keeps. */
  readonly active?: ActiveGoalWork | null | undefined;
}

export type GoalTransitionRejection =
  /** The record is already terminal. */
  | 'terminal'
  | 'illegal-transition'
  /** A cancellation marker is present, so only the transition to `canceled` is accepted. */
  | 'cancellation-requested'
  | 'invalid-terminal-reason'
  | 'invalid-attempt'
  /** The attempt's first committed validation decision cannot be replaced. */
  | 'decision-already-recorded'
  | 'oversized'
  /** The write would produce a record that does not decode. */
  | 'invalid-record';

export type GoalTransitionResult =
  | { readonly status: 'applied'; readonly record: GoalState }
  /** The record's current transition is this one: success, no write. */
  | { readonly status: 'duplicate'; readonly record: GoalState }
  /** Late, out of order, or conflicting: carries the authoritative record. */
  | { readonly status: 'stale'; readonly record: GoalState }
  | {
      readonly status: 'rejected';
      readonly reason: GoalTransitionRejection;
      readonly record: GoalState;
    }
  | { readonly status: 'missing' }
  | { readonly status: 'corrupt' };

export type GoalCreation =
  | { readonly status: 'created'; readonly record: GoalState }
  /** `existing` is absent when the record already stored there is unreadable. */
  | { readonly status: 'duplicate'; readonly existing?: GoalState };

export type GoalControlRejection = 'terminal' | 'not-terminal';

export type GoalControlResult =
  | { readonly status: 'updated'; readonly record: GoalState }
  /** The record already says what the call asked for. */
  | { readonly status: 'unchanged'; readonly record: GoalState }
  | {
      readonly status: 'rejected';
      readonly reason: GoalControlRejection;
      readonly record: GoalState;
    }
  /** Lost the compare-and-swap too many times in a row; carries what is stored now. */
  | { readonly status: 'stale'; readonly record: GoalState }
  | { readonly status: 'missing' }
  | { readonly status: 'corrupt' };

export interface GoalStore {
  /**
   * Create-if-absent. The record must be a fresh `pending` one (revision 1,
   * transition 0): throws `InvalidGoalStateError` otherwise.
   */
  create(state: GoalState): Promise<GoalCreation>;
  get(goalRunId: string): Promise<GoalState | undefined>;
  list(): Promise<GoalState[]>;
  applyTransition(request: GoalTransitionRequest): Promise<GoalTransitionResult>;
  /** First marker wins; later requests are `unchanged`. A terminal goal is `rejected`. */
  requestCancellation(
    goalRunId: string,
    marker: GoalCancellationMarker,
    now: string,
  ): Promise<GoalControlResult>;
  /** Increments `controllerRestarts`. A terminal goal is `rejected`. */
  recordControllerRestart(goalRunId: string, now: string): Promise<GoalControlResult>;
  /** Sets `closedAt` once. A non-terminal goal is `rejected`. */
  close(goalRunId: string, at: string): Promise<GoalControlResult>;
}

export interface GoalStoreOptions {
  /** Called once per unreadable key encountered. Defaults to a no-op. */
  readonly onCorrupt?: ((key: string) => void) | undefined;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** A re-read-and-retry bound for compare-and-swap loss; past it a write reports `stale`. */
const MAXIMUM_CAS_ATTEMPTS = 16;

type Stored =
  | { readonly kind: 'found'; readonly raw: string; readonly record: GoalState }
  | { readonly kind: 'missing' }
  | { readonly kind: 'corrupt' };

type Evaluation =
  | { readonly outcome: 'write'; readonly next: GoalState }
  | { readonly outcome: 'done'; readonly result: GoalTransitionResult | GoalControlResult };

export function createGoalStore(
  kv: ConditionalTextValueStore,
  options: GoalStoreOptions = {},
): GoalStore {
  const onCorrupt = options.onCorrupt ?? (() => {});

  async function read(key: string): Promise<Stored> {
    const raw = await kv.get(key);
    if (raw === null) return { kind: 'missing' };
    const record = decodeGoalState(raw);
    if (record === undefined) {
      onCorrupt(key);
      return { kind: 'corrupt' };
    }
    return { kind: 'found', raw, record };
  }

  /**
   * Read, evaluate, and compare-and-swap, re-reading when another writer won.
   * `evaluate` is pure: it either decides the outcome without a write or
   * names the next record, which is stamped with `revision + 1`.
   */
  async function get(goalRunId: string): Promise<GoalState | undefined> {
    const stored = await read(goalRecordKey(goalRunId));
    return stored.kind === 'found' ? stored.record : undefined;
  }

  async function mutate<Result extends GoalTransitionResult | GoalControlResult>(
    goalRunId: string,
    evaluate: (current: GoalState) => Evaluation,
    stale: (current: GoalState) => Result,
    written: (record: GoalState) => Result,
  ): Promise<Result | { status: 'missing' } | { status: 'corrupt' }> {
    const key = goalRecordKey(goalRunId);
    let latest: GoalState | undefined;
    for (let attempt = 0; attempt < MAXIMUM_CAS_ATTEMPTS; attempt += 1) {
      const stored = await read(key);
      if (stored.kind !== 'found') return { status: stored.kind };
      latest = stored.record;
      const evaluation = evaluate(stored.record);
      if (evaluation.outcome === 'done') return evaluation.result as Result;
      const record: GoalState = { ...evaluation.next, revision: stored.record.revision + 1 };
      if (!isGoalState(record)) {
        // Unreachable for a request the evaluator accepted; fail closed rather than write it.
        throw new InvalidGoalStateError(`Bureau goal "${goalRunId}" produced an invalid record.`);
      }
      const committed = await kv.conditionalBatch(
        [{ key, expectedValue: stored.raw }],
        [{ type: 'set', key, value: JSON.stringify(record) }],
      );
      if (committed) return written(record);
    }
    return stale(latest as GoalState);
  }

  const reject = (record: GoalState, reason: GoalTransitionRejection): Evaluation => ({
    outcome: 'done',
    result: { status: 'rejected', reason, record },
  });

  function evaluateTransition(request: GoalTransitionRequest, current: GoalState): Evaluation {
    const done = (result: GoalTransitionResult): Evaluation => ({ outcome: 'done', result });
    const { currentTransition } = current;
    if (currentTransition.transitionId === request.transitionId) {
      // The same id at a different target is a conflicting writer, not a replay.
      return currentTransition.to === request.to && currentTransition.seq === request.seq
        ? done({ status: 'duplicate', record: current })
        : done({ status: 'stale', record: current });
    }
    if (current.transitionSeq !== request.seq - 1) {
      return done({ status: 'stale', record: current });
    }
    if (isTerminal(current.status)) return reject(current, 'terminal');
    if (current.cancellation !== undefined && request.to !== 'canceled') {
      return reject(current, 'cancellation-requested');
    }
    if (!canTransitionGoalRun(current.status, request.to)) {
      return reject(current, 'illegal-transition');
    }
    if (!hasValidTerminalReason(request)) return reject(current, 'invalid-terminal-reason');
    const attempts = applyAttempt(current, request);
    if (typeof attempts === 'string') return reject(current, attempts);
    const next = buildNext(current, request, attempts);
    return isGoalState(next) ? { outcome: 'write', next } : reject(current, 'invalid-record');
  }

  async function control(
    goalRunId: string,
    evaluate: (current: GoalState) => Evaluation,
  ): Promise<GoalControlResult> {
    return mutate<GoalControlResult>(
      goalRunId,
      evaluate,
      (record) => ({ status: 'stale', record }),
      (record) => ({ status: 'updated', record }),
    );
  }

  const unchanged = (record: GoalState): Evaluation => ({
    outcome: 'done',
    result: { status: 'unchanged', record },
  });

  const refuse = (record: GoalState, reason: GoalControlRejection): Evaluation => ({
    outcome: 'done',
    result: { status: 'rejected', reason, record },
  });

  return {
    async create(state) {
      if (!isGoalState(state)) {
        throw new InvalidGoalStateError('Bureau goal does not describe a valid goal record.');
      }
      if (state.revision !== 1 || state.transitionSeq !== 0 || state.status !== 'pending') {
        throw new InvalidGoalStateError(
          `Bureau goal "${state.goalRunId}" must be created pending at revision 1, transition 0.`,
        );
      }
      const key = goalRecordKey(state.goalRunId);
      const committed = await kv.conditionalBatch(
        [{ key, expectedValue: null }],
        [{ type: 'set', key, value: JSON.stringify(state) }],
      );
      if (committed) return { status: 'created', record: state };
      const existing = await get(state.goalRunId);
      return existing === undefined ? { status: 'duplicate' } : { status: 'duplicate', existing };
    },
    get,
    async list() {
      const keys = await kv.list(GOAL_RECORD_KEY_PREFIX);
      const stored = await Promise.all(keys.map((key) => read(key)));
      return stored.flatMap((entry) => (entry.kind === 'found' ? [entry.record] : []));
    },
    applyTransition(request) {
      return mutate<GoalTransitionResult>(
        request.goalRunId,
        (current) => evaluateTransition(request, current),
        (record) => ({ status: 'stale', record }),
        (record) => ({ status: 'applied', record }),
      );
    },
    requestCancellation(goalRunId, marker, now) {
      return control(goalRunId, (current) => {
        if (current.cancellation !== undefined) return unchanged(current);
        if (isTerminal(current.status)) return refuse(current, 'terminal');
        return { outcome: 'write', next: { ...current, cancellation: marker, updatedAt: now } };
      });
    },
    recordControllerRestart(goalRunId, now) {
      return control(goalRunId, (current) =>
        isTerminal(current.status)
          ? refuse(current, 'terminal')
          : {
              outcome: 'write',
              next: {
                ...current,
                controllerRestarts: current.controllerRestarts + 1,
                updatedAt: now,
              },
            },
      );
    },
    close(goalRunId, at) {
      return control(goalRunId, (current) => {
        if (!isTerminal(current.status)) return refuse(current, 'not-terminal');
        if (current.closedAt !== undefined) return unchanged(current);
        return { outcome: 'write', next: { ...current, closedAt: at, updatedAt: at } };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Transition evaluation helpers
// ---------------------------------------------------------------------------

function hasValidTerminalReason(request: GoalTransitionRequest): boolean {
  if (!isTerminal(request.to)) return request.terminalReason === undefined;
  return (
    request.terminalReason !== undefined &&
    TERMINAL_STATUS_BY_REASON[request.terminalReason] === request.to
  );
}

/** The attempts after applying the request's attempt patch, or the rejection that stops it. */
function applyAttempt(
  current: GoalState,
  request: GoalTransitionRequest,
): readonly DurableGoalAttempt[] | 'invalid-attempt' | 'decision-already-recorded' | 'oversized' {
  const patch = request.attempt;
  if (patch === undefined) return current.attempts;
  const index = patch.attemptIndex;
  if (
    index > current.attempts.length ||
    patch.attemptId !== goalAttemptId(current.goalRunId, index)
  ) {
    return 'invalid-attempt';
  }
  if (
    patch.validation !== undefined &&
    validationByteLength(patch.validation) > GOAL_VALIDATION_MAXIMUM_BYTES
  ) {
    return 'oversized';
  }
  const existing = current.attempts[index];
  const recorded = existing?.validation;
  if (recorded !== undefined && recorded.decisionId !== patch.validation?.decisionId) {
    return 'decision-already-recorded';
  }
  const attempts = [...current.attempts];
  attempts[index] = patch;
  return attempts;
}

function buildNext(
  current: GoalState,
  request: GoalTransitionRequest,
  attempts: readonly DurableGoalAttempt[],
): GoalState {
  const { active: _active, terminalReason: _reason, failureDetail: _detail, ...rest } = current;
  const active = request.active === undefined ? current.active : (request.active ?? undefined);
  return {
    ...rest,
    transitionSeq: request.seq,
    status: request.to,
    currentTransition: {
      seq: request.seq,
      transitionId: request.transitionId,
      from: current.status,
      to: request.to,
      at: request.at,
      cause: request.cause,
    },
    attempts,
    usage: request.usage ?? current.usage,
    updatedAt: request.at,
    ...(request.terminalReason === undefined ? {} : { terminalReason: request.terminalReason }),
    ...(request.failureDetail === undefined ? {} : { failureDetail: request.failureDetail }),
    ...(active === undefined ? {} : { active }),
  };
}
