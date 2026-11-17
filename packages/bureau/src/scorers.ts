/**
 * Online evaluations — production drift detection (AB-53).
 *
 * A sampling hook that listens for `run.completed` on the bureau's action
 * stream and, for a configurable fraction of runs, scores the finished run
 * against configured judges/matchers. Every sampled score is recorded to the
 * durable audit trail (`scorer.recorded`, COR-2200) — the same surface the AB-20
 * review queue and AB-21 webhook notifier write to — so drift is visible on
 * the bureau's existing glass-box audit surface, not a bespoke store.
 *
 * A judge whose score breaches its configured `alertThreshold`, or returns a `fail`,
 * publishes `scorer.threshold-breached` on the Bureau's hook event feed once the score is recorded
 * (COR-2251), where a user's hook routes it. The webhook trigger that delivered a breach before is
 * retired (COR-2201): a breach reaches users through the feed alone.
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
import type {
  PluginScoreDecision,
  PluginScoreOutcome,
  PluginScorer,
} from '@lostgradient/interborough-plugin';
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
import {
  type ConditionalTextValueStore,
  MemoryStorage,
  textValueStore,
} from '@lostgradient/storage';
import { Conversation } from 'conversationalist';

import type { AgentDefinitions } from './agent-catalog';
import type { AuditTrail } from './audit-trail';
import { type ActionEvent, ScorerThresholdBreachedEvent } from './events';
import { BUREAU_VERSION } from './bureau-version';
import type { Bureau } from './bureau-types/facade';
import { BUREAU_PLUGIN_NAME } from './plugins/bureau-plugin';
import { PluginNeedsSetupError } from './plugins/plugin-secret-gate';
import { settledTaskState } from './task-registry';
import type { VersionedCatalogSource } from './versioned-catalog';

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
  /**
   * Fraction of completed runs to sample, in `[0, 1]`. A rate of 0 turns every scorer off, whatever
   * rate a scorer asks for (`PluginScorer.sampleRate` applies only while this is above 0).
   */
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
  /**
   * Only runs of these agents are sampled (COR-2203): a run whose agent is not named, or that the
   * Bureau cannot place, is observed and not sampled. Empty or omitted, no run is excluded.
   */
  agents?: readonly string[];
  /**
   * Only runs of these kinds are sampled (COR-2203): `chat`, `goal` or `workflow`. Empty or
   * omitted, no run is excluded. Only a chat's run reaches the sampler today, because a goal's
   * attempts and a workflow's steps run as catalog runs, which never appear on the action stream.
   */
  kinds?: readonly ScoredRunKind[];
}

/** What a run was started as, for {@link ScorerSamplerOptions.kinds}. */
export type ScoredRunKind = 'chat' | 'goal' | 'workflow';

const SCORED_RUN_KINDS: ReadonlySet<string> = new Set<ScoredRunKind>(['chat', 'goal', 'workflow']);

/** Refuses a filter that is not a list of names, or of run kinds, before a sampler is built on it. */
function validateFilters(options: ScorerSamplerOptions): void {
  const { agents, kinds } = options;
  if (
    agents !== undefined &&
    (!Array.isArray(agents) || agents.some((agent) => typeof agent !== 'string'))
  ) {
    throw new TypeError('"options.scorers.agents" must be an array of agent names');
  }
  if (
    kinds !== undefined &&
    (!Array.isArray(kinds) || kinds.some((kind) => !SCORED_RUN_KINDS.has(kind)))
  ) {
    throw new TypeError('"options.scorers.kinds" must be an array of chat, goal or workflow');
  }
}

/** Who a scorer comes from, as `scorer.recorded` names it (COR-2200): the shape of a validator's source. */
export interface ScorerSource {
  /** `bureau` for a scorer the host passed to Bureau, `plugin` for a contributed one. */
  readonly kind: 'bureau' | 'plugin';
  /** `bureau`, or the contributing plugin's name. */
  readonly name: string;
  /** Bureau's own version, or the plugin's. */
  readonly version: string;
}

/** What the sampler learns about a run it samples, read once when the run completes (COR-2200). */
export interface ScoredRunDescription {
  /** The agent that ran, when the Bureau knows it. */
  readonly agentName?: string | undefined;
  /** The revision the agent's definition had when the run started, when it has one. */
  readonly definitionRevision?: number | undefined;
  /** What the run was started as, when the Bureau knows it (COR-2203). */
  readonly kind?: ScoredRunKind | undefined;
}

/**
 * What the host that builds the sampler gives it beside the user's options: read access to what
 * only the host knows about a run and a scorer. Every member is optional, so a caller that has
 * none (a test) still samples, and a record then names no definition and a `bureau` source.
 */
export interface ScorerSamplerHost {
  /**
   * What the Bureau knows about a run, called synchronously from the `run.completed` listener so
   * the answer is a snapshot (the Bureau drops a run's attribution once the run is removed).
   */
  readonly describeRun?: (runId: string) => ScoredRunDescription | undefined;
  /**
   * The plugin a scorer was contributed by, or `undefined` for one the host passed to Bureau,
   * resolved once for each scorer when the sampler is built.
   */
  readonly sourceOf?: (name: string, version: string) => VersionedCatalogSource | undefined;
  /**
   * Publishes a breach on the Bureau's event feed (COR-2251), called once a breaching score has
   * been recorded on the audit trail. Omitted, a breach publishes nothing.
   */
  readonly published?: (event: ScorerThresholdBreachedEvent) => void;
  /**
   * The fraction of finished runs to sample, read each time a run finishes (COR-2202): the
   * `scorers.sampleRate` setting. Given, the sampler runs at any rate, 0 included, so a rate raised
   * later applies to the next run; omitted, `options.sampleRate` is the rate for good.
   */
  readonly sampleRate?: () => number;
  /**
   * The most scorer invocations one UTC day may hold, read at each reservation (COR-2205): the
   * `scorers.dailyBudget` setting. `undefined` is no limit, and then no storage is touched.
   */
  readonly dailyBudget?: () => number | undefined;
  /**
   * Where the day's count is kept, shared by every Bureau on one store so a restart or a second
   * instance continues it. Omitted, the sampler keeps the count in its own process.
   */
  readonly budgetStore?: ScorerBudgetStore;
  /** Told when the budget cannot be read or reserved, so a scorer that did not run can be explained. */
  readonly diagnose?: (message: string, cause?: unknown) => void;
}

/** What the budget needs of a store: a read, and the compare-and-swap that reserves a unit. */
export type ScorerBudgetStore = Pick<ConditionalTextValueStore, 'get' | 'conditionalBatch'>;

/**
 * The prefix of the keys that hold a day's count of scorer invocations (COR-2205), one key per UTC
 * day, `bureau-scorer-budget:v1:<YYYY-MM-DD>`, whose value is the count in decimal text. Another
 * kind of value is never overwritten: the sampler reads it as an unusable count and runs nothing.
 */
export const SCORER_BUDGET_KEY_PREFIX = 'bureau-scorer-budget:v1:';

/** The key that holds the count of the UTC day named `day` (`YYYY-MM-DD`). */
export function scorerBudgetKey(day: string): string {
  return `${SCORER_BUDGET_KEY_PREFIX}${day}`;
}

/**
 * How many times a reservation re-reads the count after its swap lost to another writer before it
 * gives up and runs nothing. Each loss means another writer's reservation landed, so the budget
 * itself bounds how often this can happen to a reservation that can still succeed.
 */
const MAXIMUM_RESERVATION_CONFLICTS = 16;

/** The count in `text`, or `undefined` when it is not a count: decimal digits with no sign or padding. */
function readBudgetCount(text: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) return undefined;
  const count = Number(text);
  return Number.isSafeInteger(count) ? count : undefined;
}

/** The online eval sampler object returned by {@link createScorerSampler}. */
export interface ScorerSampler extends LivenessObservable<EvaluationLivenessSnapshot> {
  /** Number of completed runs the sampler has observed (sampled or not). */
  observedCount(): number;
  /** Number of runs actually sampled (passed the `sampleRate` roll). */
  sampledCount(): number;
  /**
   * Number of run ids the sampler still guards against a duplicate (COR-2203): the runs whose
   * scoring is in flight. A run is dropped once its scoring settles, so the count is bounded by
   * the evaluations in flight and is 0 when none is.
   */
  pendingRunCount(): number;
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

/**
 * What one scorer's run came to, as the sampler records it: the outcome, a message, and a score
 * when the scorer measured one. A scorer's return is read into this shape once, so what is recorded
 * and what decides the alert are the same values.
 */
interface RecordedScore {
  readonly outcome: PluginScoreOutcome;
  readonly message: string;
  readonly score: number | undefined;
  /** The decisions the scorer made, copied; empty when it made none. */
  readonly decisions: readonly PluginScoreDecision[];
}

/** A scorer a run's roll selected, with the rate that selected it. */
interface SelectedJudge {
  readonly entry: JudgeEntry;
  /** The scorer's own rate, or the global rate as read when the run completed. */
  readonly sampleRate: number;
}

/** A run the sampler admitted, as it is scored and recorded: a snapshot taken when the run completed. */
interface SampledRun {
  readonly runId: string;
  readonly runResult: RunResult;
  /** The scorers the run's roll selected, in list order. */
  readonly selected: readonly SelectedJudge[];
  /** The agent's name, or `null` when the Bureau does not know it. */
  readonly definitionId: string | null;
  /** The agent definition's revision as text, or `null` when it has none. */
  readonly definitionVersion: string | null;
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
  /** The scorer's own rate when it is a number from 0 to 1, else `undefined`: the global rate applies. */
  readonly sampleRate: number | undefined;
  /** Who contributed the scorer (COR-2200). */
  readonly source: ScorerSource;
}

/** The source of a scorer passed to Bureau's options rather than contributed by a plugin. */
const HOST_SCORER_SOURCE: ScorerSource = Object.freeze({
  kind: 'bureau',
  name: BUREAU_PLUGIN_NAME,
  version: BUREAU_VERSION,
});

function describeJudge(judge: PluginScorer, sourceOf: ScorerSamplerHost['sourceOf']): JudgeEntry {
  const { name, version, determinism, alertThreshold, sampleRate } = judge;
  const contributed = sourceOf?.(name, version);
  return {
    judge,
    name,
    version,
    digest: sha256HexSync(JSON.stringify({ identity: { name, version } })),
    determinism:
      determinism === 'deterministic' || determinism === 'stochastic' ? determinism : undefined,
    alertThreshold,
    sampleRate:
      typeof sampleRate === 'number' && sampleRate >= 0 && sampleRate <= 1 ? sampleRate : undefined,
    source:
      contributed?.version === undefined
        ? HOST_SCORER_SOURCE
        : Object.freeze({ kind: 'plugin', name: contributed.name, version: contributed.version }),
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
  decisions: [],
};

const DEADLINE_SCORE: RecordedScore = {
  outcome: 'canceled',
  message: `Judge exceeded its deadline of ${SCORER_DEADLINE_MILLISECONDS} milliseconds`,
  score: undefined,
  decisions: [],
};

/** The most decisions one score may record: more is a scorer in a loop, not a scorer measuring. */
export const MAXIMUM_RECORDED_DECISIONS = 64;

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Copies one decision into the fields the record keeps, or `undefined` when it is not one: a
 * provider and a model that are text, and a usage, when there is one, of finite counts. Each field
 * is read once, as a getter could answer differently twice.
 */
function readDecision(value: unknown): PluginScoreDecision | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { provider, model, usage } = value as Record<string, unknown>;
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined;
  if (usage === undefined) return { provider, model };
  if (typeof usage !== 'object' || usage === null) return undefined;
  const { prompt, completion, total, cacheCreationTokens, cacheReadTokens } = usage as Record<
    string,
    unknown
  >;
  if (!isCount(prompt) || !isCount(completion) || !isCount(total)) return undefined;
  if (cacheCreationTokens !== undefined && !isCount(cacheCreationTokens)) return undefined;
  if (cacheReadTokens !== undefined && !isCount(cacheReadTokens)) return undefined;
  return {
    provider,
    model,
    usage: {
      prompt,
      completion,
      total,
      ...(cacheCreationTokens === undefined ? {} : { cacheCreationTokens }),
      ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    },
  };
}

/** The decisions a score lists, copied, or `undefined` when the list is not one the record can hold. */
function readDecisions(value: unknown): readonly PluginScoreDecision[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAXIMUM_RECORDED_DECISIONS) return undefined;
  const decisions: PluginScoreDecision[] = [];
  for (const entry of value as unknown[]) {
    const decision = readDecision(entry);
    if (decision === undefined) return undefined;
    decisions.push(decision);
  }
  return decisions;
}

/**
 * Reads a scorer's return into a {@link RecordedScore}, or {@link MALFORMED_SCORE} for anything a
 * well-typed scorer cannot return: not an object, an outcome that is not a validator outcome kind,
 * a message that is not a string, a score that is not a finite number from 0 to 1, or decisions
 * that are not a short list of `{ provider, model, usage? }`. Each field is read once, so a getter
 * cannot answer differently for the record than for the alert.
 */
function readScore(value: unknown): RecordedScore {
  try {
    if (typeof value !== 'object' || value === null) return MALFORMED_SCORE;
    const { outcome, message, score, decisions } = value as Record<string, unknown>;
    if (typeof outcome !== 'string' || !OUTCOME_KIND_SET.has(outcome)) return MALFORMED_SCORE;
    if (typeof message !== 'string') return MALFORMED_SCORE;
    if (score !== undefined) {
      if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
        return MALFORMED_SCORE;
      }
    }
    const read = readDecisions(decisions);
    if (read === undefined) return MALFORMED_SCORE;
    return { outcome: outcome as PluginScoreOutcome, message, score, decisions: read };
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
 *   recorded here (`scorer.recorded`), best-effort — a write failure
 *   never fails the run.
 * @param options - Judges + sample rate + RNG. Returns a no-op sampler when
 *   `options` is `undefined`, `options.list` is empty, or `sampleRate` is
 *   `0`.
 * @param host - What the Bureau knows about a run and a scorer that the
 *   options do not carry (COR-2200).
 */
export function createScorerSampler<D extends AgentDefinitions = AgentDefinitions>(
  bureau: Bureau<D>,
  auditTrail: AuditTrail | undefined,
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
  host: ScorerSamplerHost = {},
): ScorerSampler {
  const judges = [...(options?.list ?? [])].map((judge) => describeJudge(judge, host.sourceOf));

  // A host that reads the rate live (COR-2202) keeps the sampler even at rate 0, since the rate may
  // rise at any run; a direct caller with no reader and a rate of 0 can never sample, because a
  // scorer's own rate never outranks a global rate of 0 (COR-2203), so it gets none.
  if (
    judges.length === 0 ||
    !options ||
    (host.sampleRate === undefined && options.sampleRate <= 0)
  ) {
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
      pendingRunCount() {
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

  validateFilters(options);
  const configuredRate = options.sampleRate;
  const rng = options.rng ?? runtime.random.next;
  const signal = options.signal;
  const clock = options.clock ?? createDefaultClock(runtime);
  const evaluationIds =
    options.evaluationIds ?? createDefaultEvaluationIdentifierSeam(runtime.identifiers);

  let observed = 0;
  let sampled = 0;
  let disposed = false;

  // Guards against scoring the same run twice at once (a duplicate `run.completed` dispatch while
  // the first is being scored). A run is in it from the moment it is admitted until its scoring
  // settles and no longer (COR-2203), so it holds one id for each evaluation in flight and nothing
  // for the runs that were filtered, skipped by the roll or have been scored.
  const inFlightRuns = new Set<string>();

  // The filters, copied once so a caller's array cannot change what the sampler admits later.
  const agentFilter: ReadonlySet<string> = new Set(options.agents);
  const kindFilter: ReadonlySet<ScoredRunKind> = new Set(options.kinds);

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

  function runTrackedEvaluation(sampledRun: SampledRun): Promise<void> {
    const tracked = beginTrackedEvaluation();
    return evaluateRun(sampledRun).finally(() => {
      endTrackedEvaluation(tracked);
      // Scoring has settled, however it ended: the id is dropped, so the set stays bounded.
      inFlightRuns.delete(sampledRun.runId);
    });
  }

  /**
   * Writes the `scorer.recorded` audit record (COR-2200): who ran, what it scored and what it
   * spent. The scorer's `message` is here and nowhere that is pushed, and the decisions' provider,
   * model and usage are here only when a decision answered.
   */
  async function recordScore(
    sampledRun: SampledRun,
    { entry, sampleRate }: SelectedJudge,
    result: RecordedScore,
    durationMs: number,
  ): Promise<void> {
    await auditTrail?.record({
      runId: sampledRun.runId,
      type: 'scorer.recorded',
      detail: {
        runKind: 'agent',
        definitionId: sampledRun.definitionId,
        definitionVersion: sampledRun.definitionVersion,
        judgedBy: entry.source,
        judgeName: entry.name,
        judgeVersion: entry.version,
        judgeDigest: entry.digest,
        ...(entry.determinism === undefined ? {} : { determinism: entry.determinism }),
        sampleRate,
        outcome: result.outcome,
        ...(result.score === undefined ? {} : { score: result.score }),
        message: result.message,
        durationMs,
        ...(result.decisions.length === 0 ? {} : { decisions: result.decisions }),
      },
      // A write that fails rejects here, instead of resolving after a diagnostic as the default
      // does, so a breach is never published for a score that was not recorded.
      strict: true,
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
    runId: string,
  ): Promise<RecordedScore | undefined> {
    const deadline = new AbortController();
    const timer = clock.setTimeout(() => {
      deadline.abort(new DOMException(DEADLINE_SCORE.message, 'TimeoutError'));
    }, SCORER_DEADLINE_MILLISECONDS);
    const scorerSignal =
      signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]);
    try {
      const returned = await raceAgainstAbort(
        // A `RunResult` has no run id, so the scorer is told it (COR-2204).
        Promise.resolve(entry.judge.score(runResult, scorerSignal, { runId })),
        scorerSignal,
      );
      return signal?.aborted ? undefined : readScore(returned);
    } catch (error) {
      if (signal?.aborted) return undefined;
      if (deadline.signal.aborted) return DEADLINE_SCORE;
      if (error instanceof PluginNeedsSetupError) {
        return { outcome: 'unavailable', message: error.message, score: undefined, decisions: [] };
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        outcome: 'error',
        message: `Judge threw: ${message}`,
        score: undefined,
        decisions: [],
      };
    } finally {
      clock.clearTimeout(timer);
    }
  }

  // ── COR-2205: the daily budget ──────────────────────────────────────

  let fallbackBudgetStore: ScorerBudgetStore | undefined;
  /** The store the count lives in: the Bureau's, or this sampler's own memory when it has none. */
  function budgetStore(): ScorerBudgetStore {
    return host.budgetStore ?? (fallbackBudgetStore ??= textValueStore(new MemoryStorage()));
  }

  /** The UTC day now, from the wall clock (the sampler's `clock` is monotonic). */
  function utcDay(): string {
    return new Date(runtime.clock.now()).toISOString().slice(0, 10);
  }

  function reportBudget(message: string, cause?: unknown): void {
    host.diagnose?.(`[bureau] Scorer budget: ${message}`, cause);
  }

  /**
   * Reserves one invocation for today: reads the count, and swaps it for one more only if it still
   * is what was read, on the exact text read. A lost swap re-reads. It never throws, and anything
   * it cannot settle (a count that is not a count, a store that fails, a swap lost to every
   * attempt) is `unavailable`, never `reserved`: a scorer runs only with a unit it holds.
   */
  async function reserveUnit(budget: number): Promise<'reserved' | 'exhausted' | 'unavailable'> {
    const key = scorerBudgetKey(utcDay());
    try {
      const store = budgetStore();
      for (let conflicts = 0; conflicts <= MAXIMUM_RESERVATION_CONFLICTS; conflicts += 1) {
        const text = await store.get(key);
        const used = text === null ? 0 : readBudgetCount(text);
        if (used === undefined) {
          reportBudget(`"${key}" does not hold a count, so no scorer runs until the day ends.`);
          return 'unavailable';
        }
        if (used >= budget) return 'exhausted';
        const next = String(used + 1);
        if (
          await store.conditionalBatch(
            [{ key, expectedValue: text }],
            [{ type: 'set', key, value: next }],
          )
        ) {
          return 'reserved';
        }
      }
      reportBudget(
        `the swap on "${key}" was lost ${MAXIMUM_RESERVATION_CONFLICTS + 1} times, so no scorer runs.`,
      );
      return 'unavailable';
    } catch (error) {
      reportBudget(`"${key}" could not be read or written, so no scorer runs.`, error);
      return 'unavailable';
    }
  }

  // Reservations of one sampler run one at a time, so runs that finish together queue here instead
  // of losing swaps to one another; the swap itself is what keeps other instances honest.
  let reservations: Promise<unknown> = Promise.resolve();
  function reserve(budget: number): Promise<'reserved' | 'exhausted' | 'unavailable'> {
    if (!Number.isSafeInteger(budget) || budget < 0) {
      reportBudget(
        `the budget ${String(budget)} is not a non-negative integer, so no scorer runs.`,
      );
      return Promise.resolve('unavailable');
    }
    const outcome = reservations.then(() => reserveUnit(budget));
    reservations = outcome;
    return outcome;
  }

  async function evaluateRun(sampledRun: SampledRun): Promise<void> {
    const { runId, runResult } = sampledRun;
    for (const selected of sampledRun.selected) {
      const { entry } = selected;
      // Checked before invoking the judge at all: `judge.score()` is
      // called synchronously as an argument expression, so `raceAgainstAbort`
      // below only ever races an ALREADY-RUNNING judge against the abort —
      // it cannot stop the judge from starting in the first place. An
      // already-aborted signal must skip the judge outright rather than
      // start (and leak) an evaluation nobody is going to wait on.
      if (signal?.aborted) return;

      // A unit of today's budget is reserved before the scorer runs, read live and held by a
      // compare-and-swap on the stored count; with no budget nothing is read or written. Once a
      // unit cannot be had, none of the run's later scorers can either, so the run stops here.
      const budget = host.dailyBudget?.();
      if (budget !== undefined && (await reserve(budget)) !== 'reserved') return;
      // The unit stays spent if the owner aborted while it was being reserved: never under-counted.
      if (signal?.aborted) return;

      const startedAt = clock.now();
      const result = await scoreOne(entry, runResult, runId);
      if (result === undefined) return;
      const durationMs = Math.max(0, clock.now() - startedAt);

      try {
        await recordScore(sampledRun, selected, result, durationMs);
      } catch (error) {
        // Nothing is published for a score that was not recorded. The unit the scorer held stays
        // spent, and the run's later scorers do not run: the store is down for them too, and each
        // would spend a unit and a model call on a score with nowhere to go. A shutdown refuses the
        // write too, and that is not a failure to report.
        if (!signal?.aborted) {
          host.diagnose?.(
            `[bureau] Scorer "${entry.name}": the score of run "${runId}" could not be recorded, so it is not published.`,
            error,
          );
        }
        return;
      }

      // Rechecked after the audit write: the owner may have aborted while
      // `recordScore()` was awaiting a slow persistent write, and firing a
      // NEW webhook off the back of an evaluation the shutdown already
      // cancelled would enqueue delivery work past the abort boundary.
      if (signal?.aborted) return;

      if (breachesThreshold(entry, result)) {
        // Published only now: the score is on the audit trail, and the owner has not aborted. A
        // breach reaches users through the hook event feed alone (COR-2201).
        host.published?.(
          new ScorerThresholdBreachedEvent({
            runId,
            scorerName: entry.name,
            scorerVersion: entry.version,
            outcome: result.outcome,
            score: result.score,
          }),
        );
      }
    }
  }

  /**
   * Whether the filters admit a run: a non-empty `agents` admits only a run of one of those agents,
   * and a non-empty `kinds` only a run of one of those kinds, and each admits nothing it cannot
   * place. An empty or absent filter excludes nothing.
   */
  function admits(description: ScoredRunDescription | undefined): boolean {
    if (agentFilter.size > 0) {
      const agent = description?.agentName;
      if (agent === undefined || !agentFilter.has(agent)) return false;
    }
    if (kindFilter.size > 0) {
      const kind = description?.kind;
      if (kind === undefined || !kindFilter.has(kind)) return false;
    }
    return true;
  }

  /**
   * The scorers a run's roll selects, in list order. A global rate that is not above 0 turns every
   * scorer off, whatever a scorer declares, and spends no roll (COR-2202, COR-2203). Above 0, a
   * scorer without a rate of its own shares one roll with the others like it (taken when the first
   * of them is reached), and a scorer with its own rate rolls for itself against that rate in place
   * of the global one; an own rate of 0 selects nothing and spends no roll.
   */
  function selectScorers(globalRate: number): SelectedJudge[] {
    const selected: SelectedJudge[] = [];
    if (!(globalRate > 0)) return selected;
    let sharedRoll: number | undefined;
    for (const entry of judges) {
      const sampleRate = entry.sampleRate ?? globalRate;
      if (!(sampleRate > 0)) continue;
      let roll: number;
      if (entry.sampleRate === undefined) {
        sharedRoll ??= rng();
        roll = sharedRoll;
      } else {
        roll = rng();
      }
      if (roll < sampleRate) selected.push({ entry, sampleRate });
    }
    return selected;
  }

  const listener = (event: ActionEvent) => {
    const { action } = event;
    if (action.type !== 'run.completed') return;
    if (disposed) return;
    if (inFlightRuns.has(action.runId)) return;

    // Only a run that settles `completed` is scored (COR-2251): the same classification the task
    // registry settles it by, so a `run.completed` action that ends in a failure finish reason
    // (`error`, `maximum-steps`, `budget-exceeded`, ...) or in `aborted` is not.
    if (
      isRunResultDetail(action.detail) &&
      settledTaskState('completed', action.detail.finishReason) !== 'completed'
    ) {
      return;
    }

    observed++;
    // Read now, before anything is awaited: the Bureau drops a run's attribution once it is removed.
    const description = host.describeRun?.(action.runId);
    if (!admits(description)) return;

    const selected = selectScorers(host.sampleRate?.() ?? configuredRate);
    if (selected.length === 0) return;
    if (!isRunResultDetail(action.detail)) return;

    sampled++;
    const revision = description?.definitionRevision;
    inFlightRuns.add(action.runId);
    trackEvaluation(
      runTrackedEvaluation({
        runId: action.runId,
        runResult: action.detail,
        selected,
        definitionId: description?.agentName ?? null,
        definitionVersion: revision === undefined ? null : String(revision),
      }),
    );
  };

  bureau.addEventListener('action', listener);

  return {
    observedCount() {
      return observed;
    },
    sampledCount() {
      return sampled;
    },
    pendingRunCount() {
      return inFlightRuns.size;
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
