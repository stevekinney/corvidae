/**
 * Online evaluations — production drift detection (AB-53).
 *
 * A sampling hook that listens for `run.completed` on the bureau's action
 * stream and, for a configurable fraction of runs, scores the finished run
 * against configured judges/matchers. Every sampled score is recorded to the
 * durable audit trail (`eval.sample.recorded`) — the same surface the AB-20
 * review queue and AB-21 webhook notifier write to — so drift is visible on
 * the bureau's existing glass-box audit surface, not a bespoke store.
 *
 * A judge whose score breaches its configured `alertThreshold` fires a
 * webhook through AB-21's durable delivery infra
 * ({@link WebhookNotifier.notify}) — the same persist/retry/backoff pipeline
 * `createWebhookNotifier` uses for approval-pending and human-wait alerts, so
 * an eval alert survives a transient delivery failure exactly like those do.
 *
 * Sampling is driven by an injectable RNG (the composed `RuntimeServices`
 * random source by default) so `sampleRate` is deterministic and testable —
 * a fake RNG that returns a fixed sequence exercises "sampled" and
 * "not sampled" runs exactly.
 *
 * Each in-flight evaluation also gets a per-evaluation `LivenessSnapshot`
 * (AB-220), watched via `createStallWatchdog` against the
 * `background-evaluation` `StallPolicy` row (AB-214). That row has no
 * cadence or absolute deadline today (AB-88's own "absent today"
 * characterization — `evaluateRun` has no per-evaluation `timeout` field to
 * project a deadline from), so this seam gives every evaluation a stable
 * identity and a structurally-correct snapshot now, ready for real stall
 * detection once a per-evaluation deadline exists, without reopening this
 * module later to add it.
 *
 * Each scorer also runs under a deadline of its own (COR-2199,
 * {@link SCORER_DEADLINE_MILLISECONDS}) that this module enforces by aborting
 * the signal the scorer receives; the liveness row stays without a cadence,
 * since that deadline is per scorer, not per evaluation.
 *
 * A scorer speaks the same outcome vocabulary a goal's validator does. A score
 * is recorded with the outcome the scorer returned, or with one the sampler
 * chose when the scorer returned none: `error` for a throw or a malformed
 * return, `unavailable` for a plugin that needs setup, `canceled` for the
 * deadline. Only a `fail`, or a score below `alertThreshold`, raises an alert.
 */
import { sha256HexSync } from '@lostgradient/cryptography';
import type { PluginScoreOutcome, PluginScorer } from '@lostgradient/interborough-plugin';
import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';
import {
  BACKGROUND_EVALUATION_POLICY,
  createStallWatchdog,
  LIVENESS_POLICY_VERSION,
  type LivenessAssessment,
  type LivenessLifecycleStatus,
  type LivenessObservable,
  type LivenessProgressState,
  type LivenessReachability,
  type LivenessSnapshot,
  type RunResult,
  type StallWatchdog,
  type StallWatchdogClock,
  type Subscription,
} from '@lostgradient/operative';
import { Conversation } from 'conversationalist';

import type { AgentDefinitions } from './agent-catalog';
import type { AuditTrail } from './audit-trail';
import type { ActionEvent } from './events';
import type { Bureau } from './bureau-types/facade';
import { PluginNeedsSetupError } from './plugins/plugin-secret-gate';
import type { WebhookNotifier } from './webhook-notifier';
import { formatVersionedId } from './versioned-catalog';

// ── Public surface ──────────────────────────────────────────────────

/** A single background evaluation's liveness snapshot (AB-220). */
export type EvaluationLivenessSnapshot = LivenessSnapshot & { kind: 'background-evaluation' };

/**
 * Local injectable per-evaluation identifier seam (AB-220), mirroring
 * obs-01's `RunIdentifierSeam` pattern
 * (`packages/operative/src/liveness/identifiers.ts`) — a constructor-time
 * injected id-generator, never a bare real-random-UUID call reached from
 * inside evaluation-dispatch logic. AB-88's own text named
 * `RuntimeServices.identifiers` (AB-92/AB-93) as the eventual home for this
 * kind of seam; AB-260 is that landing — the default below is now backed by
 * the composed `RuntimeServices.identifiers` rather than a bespoke counter.
 */
export interface EvaluationIdentifierSeam {
  next(): string;
}

/**
 * Factory for the default seam: the composed
 * {@link RuntimeServices.identifiers} (AB-260), namespaced under the
 * `'background-evaluation'` kind. Tests inject their own
 * {@link EvaluationIdentifierSeam} instead of relying on this default's
 * output.
 */
function createDefaultEvaluationIdentifierSeam(
  identifiers: RuntimeServices['identifiers'],
): EvaluationIdentifierSeam {
  return {
    next(): string {
      return identifiers.next('background-evaluation');
    },
  };
}

/**
 * Factory for the default production clock backing each evaluation's
 * `createStallWatchdog` — driven by the composed
 * {@link RuntimeServices.monotonic}/{@link RuntimeServices.timers} (AB-260),
 * defaulting to the real-globals runtime when called with no argument (the
 * baseline behavior, unchanged from before `RuntimeServices` composition).
 * Exported for direct unit testing of `setTimeout`/`clearTimeout` (AB-220):
 * the `background-evaluation` policy row has no cadence today, so
 * `createStallWatchdog` never actually calls either through the public API
 * — see `packages/operative/src/liveness/watchdog.ts`'s `scheduleNextCheck`,
 * which no-ops when a policy isn't cadence-gated. The timer-scheduling and
 * timer-clearing members are destructured once so the returned clock reads
 * `scheduleTimeout(...)`/`cancelTimeout(...)` rather than a literal `timers`
 * method call — see `create-bureau.ts`'s equivalent pattern for why.
 */
export function createDefaultClock(
  runtime: RuntimeServices = createDefaultRuntimeServices(),
): StallWatchdogClock {
  const { setTimeout: scheduleTimeout, clearTimeout: cancelTimeout } = runtime.timers;
  return {
    now: () => runtime.monotonic.now(),
    setTimeout: (callback, ms) => scheduleTimeout(callback, ms),
    clearTimeout: (handle) => cancelTimeout(handle),
  };
}

/** The fixed id for the sampler's own instance-level aggregate snapshot. */
const AGGREGATE_EVALUATION_ID = 'online-eval-sampler';

/**
 * AB-216's child-liveness severity ordering
 * (`packages/operative/src/liveness/active-run-liveness.ts`), duplicated at
 * module-local scope rather than imported: this issue's delivery boundary
 * restricts its edit to `scorers.ts`/`webhook-notifier.ts` and their
 * tests, and the source ordering is not part of `@lostgradient/operative`'s
 * public `liveness` subpath export.
 */
const ASSESSMENT_SEVERITY: readonly Exclude<LivenessAssessment, 'terminal'>[] = [
  'unreachable',
  'alive-but-stalled',
  'aborting',
  'cleaning-up',
  'legitimately-waiting',
  'healthy',
];

/**
 * Folds a set of non-terminal assessments down to the single most severe
 * one, defaulting to `'healthy'` when empty. Exported for direct unit
 * testing (AB-220): the `background-evaluation` policy row has no cadence
 * or deadline today, so every real evaluation this module produces reports
 * `'healthy'` — the "found something worse" branch is otherwise unreachable
 * through the public API.
 */
export function worstAssessment(assessments: readonly LivenessAssessment[]): LivenessAssessment {
  let worst: LivenessAssessment = 'healthy';
  let worstRank = ASSESSMENT_SEVERITY.indexOf('healthy');
  for (const assessment of assessments) {
    if (assessment === 'terminal') continue;
    const rank = ASSESSMENT_SEVERITY.indexOf(assessment);
    if (rank === -1 || rank >= worstRank) continue;
    worstRank = rank;
    worst = assessment;
  }
  return worst;
}

const REACHABILITY_RANK: readonly LivenessReachability[] = ['reachable', 'late', 'unreachable'];

/** Exported for direct unit testing (AB-220); see {@link worstAssessment}. */
export function worstReachability(values: readonly LivenessReachability[]): LivenessReachability {
  let worst: LivenessReachability = 'unknown';
  let worstRank = -1;
  for (const value of values) {
    const rank = REACHABILITY_RANK.indexOf(value);
    if (rank > worstRank) {
      worstRank = rank;
      worst = value;
    }
  }
  return worst;
}

const PROGRESS_RANK: readonly LivenessProgressState[] = ['progressing', 'idle', 'stalled'];

/** Exported for direct unit testing (AB-220); see {@link worstAssessment}. */
export function worstProgress(values: readonly LivenessProgressState[]): LivenessProgressState {
  let worst: LivenessProgressState = 'unknown';
  let worstRank = -1;
  for (const value of values) {
    const rank = PROGRESS_RANK.indexOf(value);
    if (rank > worstRank) {
      worstRank = rank;
      worst = value;
    }
  }
  return worst;
}

/** Mirrors `active-run-liveness.ts`'s `deriveAssessment` for this module's own status dimension. */
function deriveEvaluationAssessment(
  status: LivenessLifecycleStatus,
  reachability: LivenessReachability,
  progress: LivenessProgressState,
): LivenessAssessment {
  if (status === 'terminal') return 'terminal';
  if (status === 'aborting') return 'aborting';
  if (status === 'cleaning-up') return 'cleaning-up';
  if (reachability === 'unreachable') return 'unreachable';
  if (status === 'waiting') return 'legitimately-waiting';
  if (progress === 'stalled') return 'alive-but-stalled';
  return 'healthy';
}

/**
 * How long one scorer may run before the signal it received aborts and the sampler records
 * `canceled` and moves on to the next scorer (COR-2199). Each scorer's deadline counts from its own
 * start.
 */
export const SCORER_DEADLINE_MILLISECONDS = 30_000;

/** Options for {@link createScorerSampler}. */
export interface ScorerSamplerOptions {
  /** Judges/matchers run against each sampled run. */
  list: PluginScorer[];
  /** Fraction of completed runs to sample, in `[0, 1]`. */
  sampleRate: number;
  /** Injectable RNG returning a value in `[0, 1)`. Defaults to the composed RuntimeServices random. */
  rng?: () => number;
  /**
   * Owner-issued signal threaded into every `evaluateRun()` judge invocation
   * (AB-37/AB-206). Aborting it causes the affected `evaluateRun()` call to
   * settle promptly instead of running its remaining judges to completion.
   * `dispose()` still awaits that settlement via `flush()`. Each scorer's own
   * signal aborts with it, so a scorer that honors its signal stops too.
   */
  signal?: AbortSignal;
  /**
   * Injectable timer-agnostic clock backing each evaluation's
   * `createStallWatchdog` (AB-220) and arming each scorer's deadline
   * ({@link SCORER_DEADLINE_MILLISECONDS}, COR-2199). Defaults to the composed
   * `RuntimeServices` monotonic clock and timers (AB-260). Tests inject a
   * manual clock so no real sleeps are needed.
   */
  clock?: StallWatchdogClock;
  /**
   * Injectable per-evaluation identifier seam (AB-220). Defaults to the
   * composed `RuntimeServices.identifiers` (AB-260), namespaced under
   * `'background-evaluation'`. Tests inject their own seam to assert
   * stable, distinguishable ids across concurrently-admitted evaluations.
   */
  evaluationIds?: EvaluationIdentifierSeam;
}

/** The online eval sampler object returned by {@link createScorerSampler}. */
export interface ScorerSampler extends LivenessObservable<EvaluationLivenessSnapshot> {
  /** Number of completed runs the sampler has observed (sampled or not). */
  observedCount(): number;
  /** Number of runs actually sampled (passed the `sampleRate` roll). */
  sampledCount(): number;
  /**
   * Await every judge evaluation currently in flight. Used by tests to
   * observe audit-record writes and webhook alerts deterministically without
   * racing an async judge.
   */
  flush(): Promise<void>;
  /**
   * Stop listening to bureau events and await every in-flight `evaluateRun()`
   * judge invocation tracked in `activeEvaluations` before resolving
   * (AB-37/AB-206). Safe to call more than once — the second call resolves
   * promptly.
   */
  dispose(): Promise<void>;
  /**
   * Per-evaluation `LivenessSnapshot`s for every evaluation currently in
   * flight (AB-220), most-recently-started last. `snapshot()` (from
   * {@link LivenessObservable}) reports the instance-level aggregate — the
   * worst assessment across these — for a caller holding only the sampler
   * handle.
   */
  activeEvaluationSnapshots(): EvaluationLivenessSnapshot[];
}

// ── Guards ──────────────────────────────────────────────────────────

/**
 * Narrows a `run.completed` action's `detail` to a {@link RunResult}. The
 * operative store copies `RunCompletedEvent`'s own properties verbatim onto
 * `Action.detail` (see `packages/operative/src/store/store.ts`), so a
 * genuine `run.completed` action carries a real `Conversation` instance plus
 * the run's `content`/`usage`/`finishReason` — checked here rather than cast,
 * since `Action.detail` is typed `unknown`.
 */
function isRunResultDetail(detail: unknown): detail is RunResult {
  if (typeof detail !== 'object' || detail === null) return false;
  const record = detail as Record<string, unknown>;
  return (
    record['conversation'] instanceof Conversation &&
    Array.isArray(record['steps']) &&
    typeof record['content'] === 'string' &&
    typeof record['usage'] === 'object' &&
    record['usage'] !== null
  );
}

// ── Trigger ─────────────────────────────────────────────────────────

const EVAL_ALERT_TRIGGER = 'eval.threshold-breached';

/**
 * What one scorer's run came to, as the sampler records it: the outcome, a message, and a score
 * when the scorer measured one. A scorer's return is read into this shape once, so what is recorded
 * and what decides the alert are the same values.
 */
interface RecordedScore {
  readonly outcome: PluginScoreOutcome;
  readonly message: string;
  readonly score: number | undefined;
}

/** A scorer's identity as recorded: fixed when the sampler is built, never read from the plugin again. */
interface JudgeEntry {
  readonly judge: PluginScorer;
  readonly name: string;
  readonly version: string;
  /** The host's hash of the name and version; a plugin cannot supply one. */
  readonly digest: string;
  readonly determinism: 'deterministic' | 'stochastic' | undefined;
  readonly alertThreshold: number | undefined;
}

function describeJudge(judge: PluginScorer): JudgeEntry {
  const { name, version, determinism, alertThreshold } = judge;
  return {
    judge,
    name,
    version,
    digest: sha256HexSync(JSON.stringify({ identity: { name, version } })),
    determinism:
      determinism === 'deterministic' || determinism === 'stochastic' ? determinism : undefined,
    alertThreshold,
  };
}

/** Every outcome a scorer may return: the kinds of a validator outcome. */
const OUTCOME_KINDS = {
  pass: true,
  fail: true,
  error: true,
  unavailable: true,
  canceled: true,
  indeterminate: true,
} satisfies Record<PluginScoreOutcome, true>;
const OUTCOME_KIND_SET: ReadonlySet<string> = new Set(Object.keys(OUTCOME_KINDS));

const MALFORMED_SCORE: RecordedScore = {
  outcome: 'error',
  message: 'Judge returned a malformed score',
  score: undefined,
};

const DEADLINE_SCORE: RecordedScore = {
  outcome: 'canceled',
  message: `Judge exceeded its deadline of ${SCORER_DEADLINE_MILLISECONDS} milliseconds`,
  score: undefined,
};

/**
 * Reads a scorer's return into a {@link RecordedScore}, or {@link MALFORMED_SCORE} for anything a
 * well-typed scorer cannot return: not an object, an outcome that is not a validator outcome kind,
 * a message that is not a string, or a score that is not a finite number from 0 to 1. Each field is
 * read once, so a getter cannot answer differently for the record than for the alert.
 */
function readScore(value: unknown): RecordedScore {
  try {
    if (typeof value !== 'object' || value === null) return MALFORMED_SCORE;
    const { outcome, message, score } = value as Record<string, unknown>;
    if (typeof outcome !== 'string' || !OUTCOME_KIND_SET.has(outcome)) return MALFORMED_SCORE;
    if (typeof message !== 'string') return MALFORMED_SCORE;
    if (score !== undefined) {
      if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
        return MALFORMED_SCORE;
      }
    }
    return { outcome: outcome as PluginScoreOutcome, message, score };
  } catch {
    return MALFORMED_SCORE;
  }
}

/**
 * Whether a score raises an alert: a `fail`, or any score below the scorer's `alertThreshold`. The
 * second test applies only when the scorer has both.
 */
function breachesThreshold(entry: JudgeEntry, result: RecordedScore): boolean {
  if (result.outcome === 'fail') return true;
  return (
    entry.alertThreshold !== undefined &&
    result.score !== undefined &&
    result.score < entry.alertThreshold
  );
}

// ── Abort-aware settlement ──────────────────────────────────────────

/**
 * Rejects with `signal`'s abort reason as soon as it aborts, so awaiting
 * `judge.score()` never blocks `evaluateRun()` past the owner's shutdown
 * request or the scorer's own deadline, even when the scorer ignores the
 * signal {@link PluginScorer.score} receives. `signal` may outlive any single
 * evaluation, so the listener is removed via `unregister()` once
 * the race is decided rather than relying on `{ once: true }` alone —
 * otherwise a judge that WINS the race (settles before an abort) would leave
 * its listener attached to `signal` forever, one per sampled run.
 */
function whenAborted(signal: AbortSignal): { promise: Promise<never>; unregister: () => void } {
  const reason = () => (signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(reason());
      return;
    }
    onAbort = () => reject(reason());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    promise,
    unregister: () => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    },
  };
}

async function raceAgainstAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  const { promise: abortPromise, unregister } = whenAborted(signal);
  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    unregister();
  }
}

// ── Sampler factory ─────────────────────────────────────────────────

/**
 * Creates the online eval sampler attached to `bureau`.
 *
 * @param bureau - The bureau to observe (its `action` event stream).
 * @param auditTrail - The bureau's audit trail. Every sampled score is
 *   recorded here (`eval.sample.recorded`), best-effort — a write failure
 *   never fails the run.
 * @param webhookNotifier - The bureau's AB-21 webhook notifier. A threshold
 *   breach fires through {@link WebhookNotifier.notify} using its durable
 *   delivery pipeline. `undefined` when no webhooks are configured — a
 *   breach is still recorded in the audit trail, just never delivered.
 * @param options - Judges + sample rate + RNG. Returns a no-op sampler when
 *   `options` is `undefined`, `options.list` is empty, or `sampleRate` is
 *   `0`.
 */
export function createScorerSampler<D extends AgentDefinitions = AgentDefinitions>(
  bureau: Bureau<D>,
  auditTrail: AuditTrail | undefined,
  webhookNotifier: WebhookNotifier | undefined,
  options: ScorerSamplerOptions | undefined,
  // AB-260: the bureau's single composed `RuntimeServices` instance. Defaults
  // to the real-globals runtime so every pre-existing direct caller of this
  // exported factory (including this package's own test suite) is
  // unaffected by construction. `options.rng` (this module's own
  // pre-existing injectable seam) still takes precedence when supplied.
  // COR-89: an omitted-`runtime` caller has no handle on that default
  // instance, so its `deferred` ledger is never the only path to the work
  // tracked on it: every promise passed to `runtime.deferred.track` below is
  // also held in `activeEvaluations`, which `flush()`/`dispose()` awaits.
  runtime: RuntimeServices = createDefaultRuntimeServices(),
): ScorerSampler {
  const judges = [...(options?.list ?? [])].map(describeJudge);

  if (judges.length === 0 || !options || options.sampleRate <= 0) {
    const noOpSnapshot: EvaluationLivenessSnapshot = Object.freeze({
      id: AGGREGATE_EVALUATION_ID,
      kind: 'background-evaluation',
      startedAt: runtime.clock.nowISO(),
      revision: 0,
      status: 'terminal',
      lastTransitionAt: runtime.clock.nowISO(),
      projection: 'redacted',
      ownership: 'independent',
      detached: false,
      durability: 'process-local',
      cancellable: false,
      attempt: 0,
      reachability: 'not-applicable',
      progress: 'not-applicable',
      assessment: 'terminal',
      observedAt: 0,
      missedPulseCount: 0,
      policyVersion: LIVENESS_POLICY_VERSION,
      evidence: [],
    });
    return {
      observedCount() {
        return 0;
      },
      sampledCount() {
        return 0;
      },
      async flush() {
        // Nothing was ever kicked off.
      },
      async dispose() {
        // Nothing was ever subscribed.
      },
      activeEvaluationSnapshots() {
        return [];
      },
      snapshot() {
        return noOpSnapshot;
      },
      subscribeSnapshot(observer) {
        try {
          observer(noOpSnapshot);
        } catch {
          // Same isolation as `notifyAggregate()` below: a throwing observer
          // must not escape into the subscriber.
        }
        return { unsubscribe() {}, closed: true };
      },
    };
  }

  const sampleRate = options.sampleRate;
  const rng = options.rng ?? runtime.random.next;
  const signal = options.signal;
  const clock = options.clock ?? createDefaultClock(runtime);
  const evaluationIds =
    options.evaluationIds ?? createDefaultEvaluationIdentifierSeam(runtime.identifiers);

  let observed = 0;
  let sampled = 0;
  let disposed = false;

  // Guards against sampling the same run's `run.completed` action twice
  // (e.g. a duplicate dispatch during recovery) — a sampling decision is
  // made at most once per run.
  const seenRuns = new Set<string>();

  // Every in-flight judge evaluation, so `flush()` can await terminal state
  // deterministically (tests) and a caller can drain evaluations before
  // shutdown.
  const activeEvaluations = new Set<Promise<void>>();
  function trackEvaluation(promise: Promise<void>): void {
    activeEvaluations.add(promise);
    void promise.finally(() => activeEvaluations.delete(promise));
    // AB-260: layered on top of `activeEvaluations` (never replacing it) —
    // every judge evaluation also registers with the bureau's composed
    // `RuntimeServices.deferred`, so `deferred.drain()` reports it under the
    // stable `'background-evaluation'` label alongside every other
    // subsystem's fire-and-forget work.
    runtime.deferred.track(promise, 'background-evaluation');
  }

  // ── AB-220: per-evaluation liveness ─────────────────────────────────

  interface TrackedEvaluation {
    readonly id: string;
    readonly watchdog: StallWatchdog;
    readonly startedAt: string;
  }

  const trackedEvaluations = new Map<string, TrackedEvaluation>();

  function computeEvaluationSnapshot(tracked: TrackedEvaluation): EvaluationLivenessSnapshot {
    const assessed = tracked.watchdog.assess();
    const status: LivenessLifecycleStatus = 'running';
    return Object.freeze({
      id: tracked.id,
      kind: 'background-evaluation',
      startedAt: tracked.startedAt,
      revision: 0,
      status,
      lastTransitionAt: tracked.startedAt,
      projection: 'redacted',
      ownership: 'independent',
      detached: false,
      durability: 'process-local',
      cancellable: false,
      attempt: 0,
      reachability: assessed.reachability,
      progress: assessed.progress,
      assessment: deriveEvaluationAssessment(status, assessed.reachability, assessed.progress),
      observedAt: clock.now(),
      missedPulseCount: assessed.missedPulseCount,
      policyVersion: LIVENESS_POLICY_VERSION,
      evidence: assessed.evidence,
    });
  }

  const aggregateStartedAt = runtime.clock.nowISO();
  let aggregateRevision = 0;
  let cachedAggregate: EvaluationLivenessSnapshot | undefined;
  let cachedAggregateRevision = -1;

  interface AggregateSubscriberRecord {
    readonly observer: (snapshot: EvaluationLivenessSnapshot) => void;
    closed: boolean;
    detachAbortListener: () => void;
  }

  const aggregateSubscribers = new Set<AggregateSubscriberRecord>();

  function computeAggregateSnapshot(): EvaluationLivenessSnapshot {
    const items = [...trackedEvaluations.values()].map(computeEvaluationSnapshot);
    const status: LivenessLifecycleStatus = 'running';
    const reachability = worstReachability(items.map((item) => item.reachability));
    const progress = worstProgress(items.map((item) => item.progress));
    return Object.freeze({
      id: AGGREGATE_EVALUATION_ID,
      kind: 'background-evaluation',
      startedAt: aggregateStartedAt,
      revision: aggregateRevision,
      status,
      lastTransitionAt: aggregateStartedAt,
      projection: 'redacted',
      ownership: 'independent',
      detached: false,
      durability: 'process-local',
      cancellable: false,
      attempt: 0,
      reachability,
      progress,
      assessment: worstAssessment(items.map((item) => item.assessment)),
      observedAt: clock.now(),
      missedPulseCount: items.reduce((max, item) => Math.max(max, item.missedPulseCount), 0),
      policyVersion: LIVENESS_POLICY_VERSION,
      evidence: [],
    });
  }

  function readAggregateSnapshot(): EvaluationLivenessSnapshot {
    if (cachedAggregate && cachedAggregateRevision === aggregateRevision) {
      return cachedAggregate;
    }
    cachedAggregate = computeAggregateSnapshot();
    cachedAggregateRevision = aggregateRevision;
    return cachedAggregate;
  }

  function notifyAggregate(): void {
    const current = readAggregateSnapshot();
    const currentSubscribers = [...aggregateSubscribers];
    for (const record of currentSubscribers) {
      if (record.closed) continue;
      try {
        record.observer(current);
      } catch {
        // A throwing subscriber must not escape into the caller driving this
        // revision, matching `active-run-liveness.ts`'s own isolation.
      }
    }
  }

  function advanceAggregate(): void {
    aggregateRevision += 1;
    notifyAggregate();
  }

  function beginTrackedEvaluation(): TrackedEvaluation {
    const id = evaluationIds.next();
    const watchdog = createStallWatchdog(BACKGROUND_EVALUATION_POLICY, clock);
    const tracked: TrackedEvaluation = { id, watchdog, startedAt: runtime.clock.nowISO() };
    trackedEvaluations.set(id, tracked);
    advanceAggregate();
    return tracked;
  }

  function endTrackedEvaluation(tracked: TrackedEvaluation): void {
    tracked.watchdog.dispose();
    trackedEvaluations.delete(tracked.id);
    advanceAggregate();
  }

  function runTrackedEvaluation(runId: string, runResult: RunResult): Promise<void> {
    const tracked = beginTrackedEvaluation();
    return evaluateRun(runId, runResult).finally(() => endTrackedEvaluation(tracked));
  }

  async function recordScore(
    runId: string,
    entry: JudgeEntry,
    result: RecordedScore,
  ): Promise<void> {
    await auditTrail?.record({
      runId,
      type: 'eval.sample.recorded',
      detail: {
        judgeName: entry.name,
        judgeVersion: entry.version,
        judgeDigest: entry.digest,
        ...(entry.determinism === undefined ? {} : { determinism: entry.determinism }),
        outcome: result.outcome,
        ...(result.score === undefined ? {} : { score: result.score }),
        message: result.message,
      },
    });
  }

  /**
   * Hands a breach to the webhook notifier. The alert is a pushed event, so it names the scorer, its
   * digest and the outcome and score, and never the scorer's `message`: that text stays on the
   * `eval.sample.recorded` audit record, for an authorized read (COR-2199).
   */
  function fireAlert(runId: string, entry: JudgeEntry, result: RecordedScore): void {
    webhookNotifier?.notify({
      runId,
      subjectId: `eval:${runId}:${formatVersionedId(entry.name, entry.version)}`,
      trigger: EVAL_ALERT_TRIGGER,
      detail: {
        judgeName: entry.name,
        judgeVersion: entry.version,
        judgeDigest: entry.digest,
        outcome: result.outcome,
        ...(result.score === undefined ? {} : { score: result.score }),
        threshold: entry.alertThreshold,
      },
    });
  }

  /**
   * Runs one scorer under its own deadline and reads what it came to, or `undefined` when the
   * owner aborted: shutdown is a request, not a scorer outcome, so it records nothing.
   *
   * The scorer's signal is the owner's signal and a deadline armed on the injected clock, so it
   * aborts on shutdown and at {@link SCORER_DEADLINE_MILLISECONDS}. The race decides the result: a
   * scorer that settles first is recorded as it returned, even if the deadline fires a moment
   * later, and the deadline is cleared on every exit so it never aborts a scorer that has settled.
   * After a failure the order is fixed: the owner's abort first (nothing recorded), then the
   * deadline (`canceled`, whatever the scorer threw once told to stop), then a plugin that needs
   * setup (`unavailable`), then any other throw (`error`).
   */
  async function scoreOne(
    entry: JudgeEntry,
    runResult: RunResult,
  ): Promise<RecordedScore | undefined> {
    const deadline = new AbortController();
    const timer = clock.setTimeout(() => {
      deadline.abort(new DOMException(DEADLINE_SCORE.message, 'TimeoutError'));
    }, SCORER_DEADLINE_MILLISECONDS);
    const scorerSignal =
      signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]);
    try {
      const returned = await raceAgainstAbort(
        Promise.resolve(entry.judge.score(runResult, scorerSignal)),
        scorerSignal,
      );
      return signal?.aborted ? undefined : readScore(returned);
    } catch (error) {
      if (signal?.aborted) return undefined;
      if (deadline.signal.aborted) return DEADLINE_SCORE;
      if (error instanceof PluginNeedsSetupError) {
        return { outcome: 'unavailable', message: error.message, score: undefined };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', message: `Judge threw: ${message}`, score: undefined };
    } finally {
      clock.clearTimeout(timer);
    }
  }

  async function evaluateRun(runId: string, runResult: RunResult): Promise<void> {
    for (const entry of judges) {
      // Checked before invoking the judge at all: `judge.score()` is
      // called synchronously as an argument expression, so `raceAgainstAbort`
      // below only ever races an ALREADY-RUNNING judge against the abort —
      // it cannot stop the judge from starting in the first place. An
      // already-aborted signal must skip the judge outright rather than
      // start (and leak) an evaluation nobody is going to wait on.
      if (signal?.aborted) return;

      const result = await scoreOne(entry, runResult);
      if (result === undefined) return;

      await recordScore(runId, entry, result);

      // Rechecked after the audit write: the owner may have aborted while
      // `recordScore()` was awaiting a slow persistent write, and firing a
      // NEW webhook off the back of an evaluation the shutdown already
      // cancelled would enqueue delivery work past the abort boundary.
      if (signal?.aborted) return;

      if (breachesThreshold(entry, result)) {
        fireAlert(runId, entry, result);
      }
    }
  }

  const listener = (event: ActionEvent) => {
    const { action } = event;
    if (action.type !== 'run.completed') return;
    if (disposed) return;
    if (seenRuns.has(action.runId)) return;
    seenRuns.add(action.runId);

    observed++;
    if (rng() >= sampleRate) return;
    if (!isRunResultDetail(action.detail)) return;

    sampled++;
    trackEvaluation(runTrackedEvaluation(action.runId, action.detail));
  };

  bureau.addEventListener('action', listener);

  return {
    observedCount() {
      return observed;
    },
    sampledCount() {
      return sampled;
    },
    async flush(): Promise<void> {
      await Promise.allSettled(activeEvaluations);
    },
    async dispose(): Promise<void> {
      disposed = true;
      bureau.removeEventListener('action', listener);
      await Promise.allSettled(activeEvaluations);
    },
    activeEvaluationSnapshots(): EvaluationLivenessSnapshot[] {
      return [...trackedEvaluations.values()].map(computeEvaluationSnapshot);
    },
    snapshot(): EvaluationLivenessSnapshot {
      return readAggregateSnapshot();
    },
    subscribeSnapshot(
      observer: (snapshot: EvaluationLivenessSnapshot) => void,
      subscribeOptions?: { signal?: AbortSignal },
    ): Subscription {
      const subscriptionSignal = subscribeOptions?.signal;
      const record: AggregateSubscriberRecord = {
        observer,
        closed: false,
        detachAbortListener: () => subscriptionSignal?.removeEventListener('abort', unsubscribe),
      };

      function unsubscribe(): void {
        if (record.closed) return;
        record.closed = true;
        record.detachAbortListener();
        aggregateSubscribers.delete(record);
      }

      if (subscriptionSignal?.aborted) {
        record.closed = true;
        try {
          observer(readAggregateSnapshot());
        } catch {
          // Same isolation as `notifyAggregate()` above.
        }
        return {
          unsubscribe,
          get closed() {
            return record.closed;
          },
        };
      }

      aggregateSubscribers.add(record);
      subscriptionSignal?.addEventListener('abort', unsubscribe, { once: true });

      try {
        observer(readAggregateSnapshot());
      } catch {
        // Same isolation as `notifyAggregate()` above.
      }

      return {
        unsubscribe,
        get closed() {
          return record.closed;
        },
      };
    },
  };
}
