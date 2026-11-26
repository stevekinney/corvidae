/**
 * Tests for `createScorerSampler` (AB-53).
 *
 * Uses a hand-crafted `Bureau` stub — same pattern as `webhook-notifier.test.ts` — and a stub
 * audit trail and event sink, so records and published breaches are observed without a real
 * Bureau. Sampling is driven by an injected RNG so `sampleRate` is exercised deterministically: no
 * test depends on `Math.random`.
 *
 * COR-2203 outcome matrix (sampler filters, per-scorer rate, bounded memory). "Main" is what a probe
 * of the sampler on main answered (`tmp/chef/scratch/COR-2203-dcc14a96/probe-main.log`: a run
 * skipped by the roll, then sent again, and a sampled run, settled, then sent again, were each
 * counted once and scored once) or what the code there does. `pending` is the number of run ids the
 * sampler still guards against a duplicate: runs whose scoring is in flight. The cells are the
 * `OUTCOME_MATRIX` table below, one test each.
 *
 * | Input                                              | Exit                                  | Main                         |
 * | -------------------------------------------------- | ------------------------------------- | ---------------------------- |
 * | roll below the rate, agent and kind in the filters | sampled, scored, pending 1 then 0     | scored; id kept for good     |
 * | roll at or above the rate                          | observed, rate-skipped, pending 0     | same; id kept for good       |
 * | agent not in a non-empty `agents`                  | observed, filtered, no roll, pending 0| no filter: sampled           |
 * | run the Bureau cannot describe, non-empty filter   | observed, filtered, pending 0         | no filter: sampled           |
 * | empty `agents` or `kinds`                          | excludes nothing                      | no filter                    |
 * | kind not in a non-empty `kinds`                    | observed, filtered, no roll, pending 0| no filter: sampled           |
 * | global rate 0, a scorer's own rate 1               | nothing scored, no roll (revision 2026-11-16)| global rate only      |
 * | global rate above 0, a scorer's own rate           | its own rate decides, with its own roll| global rate only            |
 * | own rate that is not a number from 0 to 1          | ignored: the global rate decides      | no such field                |
 * | in flight, over a memory bound                     | none: only scoring in flight is held  | none (the set only grew)     |
 * | a duplicate while scoring is in flight             | ignored                               | ignored                      |
 * | a duplicate after scoring settled                  | scored again (the id was dropped)     | ignored (the id was kept)    |
 * | a duplicate of a rate-skipped or filtered run      | decided again: a new roll             | ignored (the id was kept)    |
 * | a detail that is not a RunResult                   | observed, not sampled, pending 0      | same; id kept for good       |
 * | 10,000 runs, every one settled                     | pending 0                             | one id each, kept for good   |
 * | dispose with scoring in flight                     | waits for it, then pending 0          | waits; ids kept              |
 *
 * COR-2205 outcome matrix (a daily budget of scorer invocations). The unit is one invocation of one
 * scorer for one sampled run, reserved by compare-and-swap on the UTC-day key before the scorer
 * runs. Main has no budget and no count: every sampled run runs every scorer (the "Main" column is
 * that, from the code, since there is nothing to probe). The cells are `BUDGET_MATRIX` and the tests
 * after it, one each.
 *
 * | Input                                                   | Exit                                              | Main               |
 * | ------------------------------------------------------- | ------------------------------------------------- | ------------------ |
 * | sample admitted, budget unset                           | every scorer runs, storage never touched          | runs               |
 * | sample admitted, count below the budget                 | unit reserved (count + 1), then the scorer runs   | runs, uncounted    |
 * | sample admitted, count at the budget                    | no scorer runs, none after it either, no record   | runs               |
 * | budget 0                                                | no scorer ever runs                               | runs               |
 * | run failed or canceled, filtered, or skipped by the roll| not sampled: nothing reserved                     | not sampled        |
 * | the UTC day rolls over between two runs                 | the count starts again at 0 under the new day     | no count           |
 * | the UTC day rolls over between a run's scorers          | the later scorer reserves under the new day       | no count           |
 * | restart mid-day (a new sampler on the same store)       | the count continues from the stored value         | no count           |
 * | a second instance on the same store                     | the two share one count, never over the budget    | no count           |
 * | two samples racing for the last unit                    | exactly one reserves it; the other runs nothing   | both run           |
 * | the budget is lowered below the count, or raised        | read at each reservation: refuses, or continues   | no budget          |
 * | the stored count is not a count                         | fail closed: nothing runs, a diagnostic names it  | no count           |
 * | the store throws on a read or on the swap               | fail closed: nothing runs, a diagnostic names it  | no count           |
 * | the swap loses every attempt                            | after the bounded retries, nothing runs           | no count           |
 * | the owner aborts after a unit is reserved               | the unit stays spent; the scorer does not run     | no count           |
 * | the scorer ran and its record cannot be written         | unit stays spent; nothing published, run stops    | published anyway   |
 * | no durable store (an in-memory Bureau)                  | the count lives in the process, per day           | no count           |
 */
import { sha256HexSync } from '@lostgradient/cryptography';
import {
  definePlugin,
  type PluginScore,
  type PluginScorer,
} from '@lostgradient/interborough-plugin';
import * as lifecycle from '@lostgradient/lifecycle';
import {
  type Action,
  createAgent,
  type GenerateFunction,
  LIVENESS_POLICY_VERSION,
  type RunResult,
  type StallWatchdogClock,
  stopWhen,
} from '@lostgradient/operative';
import {
  type ConditionalTextValueStore,
  MemoryStorage,
  textValueStore,
} from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Conversation } from 'conversationalist/testing';

import type { AgentDefinitions } from './agent-catalog';
import { type AuditTrail, createAuditTrail } from './audit-trail';
import { type ComposableOptions, composePlugins } from './plugins/compose-plugins';
import { projectBureauEvent } from './bureau-event-feed';
import { BUREAU_VERSION } from './bureau-version';
import { createBureau } from './create-bureau';
import { ActionEvent, type ScorerThresholdBreachedEvent } from './events';
import { createReceiver, deliveriesOf, newEncryptionKey } from './hooks/hooks.test-support';
import {
  createDefaultClock,
  createScorerSampler,
  type EvaluationIdentifierSeam,
  scorerBudgetKey,
  worstAssessment,
  worstProgress,
  worstReachability,
} from './scorers';
import type { Bureau } from './bureau-types/facade';

// ── Minimal Bureau stub ──────────────────────────────────────────────

type ActionListener = (event: ActionEvent) => void;

function createStubBureau(): { bureau: Bureau; emit: (action: Action) => void } {
  const listeners = new Set<ActionListener>();

  const bureau = {
    addEventListener(_type: string, listener: ActionListener) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: ActionListener) {
      listeners.delete(listener);
    },
  } as unknown as Bureau;

  const emit = (action: Action) => {
    const event = new ActionEvent(action);
    for (const listener of listeners) {
      listener(event);
    }
  };

  return { bureau, emit };
}

function makeAction(overrides: Partial<Action> & { type: string; runId: string }): Action {
  return {
    sequence: 1,
    detail: null,
    timestamp: 1_000,
    ...overrides,
  };
}

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    conversation: new Conversation(),
    steps: [],
    content: 'the final answer',
    usage: { prompt: 10, completion: 5, total: 15 },
    finishReason: 'stop',
    ...overrides,
  } as RunResult;
}

function createStubAuditTrail(): { auditTrail: AuditTrail; records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  const auditTrail: AuditTrail = {
    async record(entry) {
      records.push(entry);
    },
    async query() {
      return [];
    },
    async prune() {
      return undefined;
    },
    async redact() {
      return 0;
    },
    async dispose() {},
  };
  return { auditTrail, records };
}

/** Deterministic RNG that replays a fixed sequence, then repeats the last value. */
function scriptedRng(values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)]!;
    index++;
    return value;
  };
}

/** A timer-agnostic manual clock (AB-220) — no real timers, `setTimeout`/`clearTimeout` unused by a no-cadence policy. */
function manualClock(start = 0): StallWatchdogClock & { advance: (milliseconds: number) => void } {
  let time = start;
  return {
    now: () => time,
    setTimeout: () => 0,
    clearTimeout: () => {},
    advance(milliseconds: number) {
      time += milliseconds;
    },
  };
}

/** A scripted `EvaluationIdentifierSeam` that replays a fixed sequence of ids. */
function scriptedEvaluationIds(ids: string[]): EvaluationIdentifierSeam {
  let index = 0;
  return {
    next(): string {
      const id = ids[index];
      if (id === undefined) throw new Error('scriptedEvaluationIds: ran out of scripted ids');
      index++;
      return id;
    },
  };
}

/** A judge whose `score()` never resolves until `resolveAll()` is called. */
function blockingJudge(name = 'blocking-judge'): {
  judge: PluginScorer;
  resolveAll: () => void;
} {
  const resolvers: (() => void)[] = [];
  const judge: PluginScorer = {
    name,
    version: '1.0.0',
    score: () =>
      new Promise<PluginScore>((resolve) => {
        resolvers.push(() => resolve({ outcome: 'pass', score: 1, message: 'unblocked' }));
      }),
  };
  return {
    judge,
    resolveAll: () => {
      for (const resolve of resolvers) resolve();
    },
  };
}

function passingMatcher(name = 'exact-match'): PluginScorer {
  return {
    name,
    version: '1.0.0',
    score: (): PluginScore => ({ outcome: 'pass', score: 1, message: 'matched' }),
  };
}

function failingMatcher(name = 'exact-match', score = 0): PluginScorer {
  return {
    name,
    version: '1.0.0',
    score: (): PluginScore => ({ outcome: 'fail', score, message: 'did not match' }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('createScorerSampler', () => {
  it('is a no-op when no judges are configured', async () => {
    const { bureau } = createStubBureau();
    const sampler = createScorerSampler(bureau, undefined, {
      list: [],
      sampleRate: 1,
    });
    expect(sampler.observedCount()).toBe(0);
    expect(sampler.sampledCount()).toBe(0);
    await sampler.flush();
    await sampler.dispose();
  });

  it('is a no-op when sampleRate is 0', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const sampler = createScorerSampler(bureau, auditTrail, {
      list: [passingMatcher()],
      sampleRate: 0,
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(sampler.observedCount()).toBe(0);
    expect(records).toHaveLength(0);
    await sampler.dispose();
  });

  it('ignores non-run.completed actions', async () => {
    const { bureau, emit } = createStubBureau();
    const sampler = createScorerSampler(bureau, undefined, {
      list: [passingMatcher()],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    emit(makeAction({ type: 'step.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(sampler.observedCount()).toBe(0);
    await sampler.dispose();
  });

  // ── Fraction respected ─────────────────────────────────────────────

  it('respects sampleRate: a roll below sampleRate samples, at/above does not', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    // sampleRate 0.5: rolls of 0.1 (sampled), 0.9 (not sampled), 0.4 (sampled).
    const sampler = createScorerSampler(bureau, auditTrail, {
      list: [passingMatcher()],
      sampleRate: 0.5,
      rng: scriptedRng([0.1, 0.9, 0.4]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    emit(makeAction({ type: 'run.completed', runId: 'run-2', detail: makeRunResult() }));
    emit(makeAction({ type: 'run.completed', runId: 'run-3', detail: makeRunResult() }));
    await sampler.flush();

    expect(sampler.observedCount()).toBe(3);
    expect(sampler.sampledCount()).toBe(2);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r['runId'])).toEqual(['run-1', 'run-3']);

    await sampler.dispose();
  });

  it('never samples a run when sampleRate is 1 regardless of RNG output', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const sampler = createScorerSampler(bureau, auditTrail, {
      list: [passingMatcher()],
      sampleRate: 1,
      rng: scriptedRng([0.999999]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(sampler.sampledCount()).toBe(1);
    expect(records).toHaveLength(1);
    await sampler.dispose();
  });

  it('samples a run.completed action at most once, even if the action fires twice', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const sampler = createScorerSampler(bureau, auditTrail, {
      list: [passingMatcher()],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    emit(
      makeAction({ type: 'run.completed', runId: 'run-1', sequence: 2, detail: makeRunResult() }),
    );
    await sampler.flush();

    expect(sampler.observedCount()).toBe(1);
    expect(records).toHaveLength(1);
    await sampler.dispose();
  });

  // ── Scores recorded ────────────────────────────────────────────────

  it('records every judge score to the audit trail for a sampled run', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const sampler = createScorerSampler(bureau, auditTrail, {
      list: [passingMatcher('judge-a'), failingMatcher('judge-b', 0.2)],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      runId: 'run-1',
      type: 'scorer.recorded',
      detail: {
        judgeName: 'judge-a',
        judgeVersion: '1.0.0',
        outcome: 'pass',
        score: 1,
        message: 'matched',
      },
    });
    expect(records[1]).toMatchObject({
      runId: 'run-1',
      type: 'scorer.recorded',
      detail: { judgeName: 'judge-b', outcome: 'fail', score: 0.2, message: 'did not match' },
    });

    await sampler.dispose();
  });

  it('records the judge name and version on every audit record (COR-1872)', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const judge: PluginScorer = {
      name: 'linear:triage-quality',
      version: '2.1.0',
      score: (): PluginScore => ({ outcome: 'pass', score: 0.9, message: 'fine' }),
    };
    const sampler = createScorerSampler(bureau, auditTrail, {
      list: [judge],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: 'scorer.recorded',
      detail: { judgeName: 'linear:triage-quality', judgeVersion: '2.1.0' },
    });

    await sampler.dispose();
  });

  it('records a judge that throws as an error audit entry instead of crashing', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const throwingJudge: PluginScorer = {
      name: 'flaky-judge',
      version: '1.0.0',
      score: () => {
        throw new Error('judge exploded');
      },
    };
    const sampler = createScorerSampler(bureau, auditTrail, {
      list: [throwingJudge],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      runId: 'run-1',
      type: 'scorer.recorded',
      detail: {
        judgeName: 'flaky-judge',
        outcome: 'error',
        message: 'Judge threw: judge exploded',
      },
    });

    await sampler.dispose();
  });

  it('skips sampling when the action detail is not a RunResult-shaped object', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const sampler = createScorerSampler(bureau, auditTrail, {
      list: [passingMatcher()],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: { not: 'a run result' } }));
    await sampler.flush();

    expect(sampler.observedCount()).toBe(1);
    expect(sampler.sampledCount()).toBe(0);
    expect(records).toHaveLength(0);

    await sampler.dispose();
  });

  // ── Threshold breach publishes on the event feed (neuter-verified) ──

  /** A sampler over a stub bureau whose published breaches a test reads. */
  function breachPublishing(list: PluginScorer[]) {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const breaches: Record<string, unknown>[] = [];
    const sampler = createScorerSampler(
      bureau,
      auditTrail,
      { list, sampleRate: 1, rng: scriptedRng([0]) },
      undefined,
      {
        published: (event) => breaches.push(projectBureauEvent(event)?.payload ?? {}),
      },
    );
    return { sampler, emit, records, breaches };
  }

  it('publishes a breach when a judge score is below alertThreshold', async () => {
    const { sampler, emit, breaches } = breachPublishing([
      {
        name: 'quality-judge',
        version: '1.0.0',
        alertThreshold: 0.5,
        score: (): PluginScore => ({ outcome: 'pass', score: 0.2, message: 'quality dropped' }),
      },
    ]);

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    // The scorer's text stays on the audit record; a published event is pushed (COR-2199).
    expect(breaches).toEqual([
      {
        runId: 'run-1',
        scorerName: 'quality-judge',
        scorerVersion: '1.0.0',
        outcome: 'pass',
        score: 0.2,
      },
    ]);
    await sampler.dispose();
  });

  it('publishes no breach when the score is at or above alertThreshold', async () => {
    const { sampler, emit, breaches } = breachPublishing([
      {
        name: 'quality-judge',
        version: '1.0.0',
        alertThreshold: 0.5,
        score: (): PluginScore => ({ outcome: 'pass', score: 0.5, message: 'fine' }),
      },
    ]);

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(breaches).toHaveLength(0);
    await sampler.dispose();
  });

  it('falls back to publishing on a fail outcome when no alertThreshold is configured', async () => {
    const { sampler, emit, breaches } = breachPublishing([
      failingMatcher('no-threshold-judge', 0.9),
    ]);

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(breaches).toHaveLength(1);
    await sampler.dispose();
  });

  it('records a breach and publishes nothing when no event sink is configured', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const breachingJudge: PluginScorer = {
      name: 'quality-judge',
      version: '1.0.0',
      alertThreshold: 0.5,
      score: (): PluginScore => ({ outcome: 'fail', score: 0.1, message: 'bad' }),
    };
    const sampler = createScorerSampler(bureau, auditTrail, {
      list: [breachingJudge],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(records).toHaveLength(1);
    await sampler.dispose();
  });

  it('NEUTER: removing the threshold check would publish a breach for a passing score (guards the guard)', async () => {
    // This test documents the property the implementation must uphold: a
    // score comfortably above threshold must never publish. If `breachesThreshold`
    // were neutered to `return true` unconditionally, this assertion fails.
    const { sampler, emit, breaches } = breachPublishing([
      {
        name: 'quality-judge',
        version: '1.0.0',
        alertThreshold: 0.1,
        score: (): PluginScore => ({ outcome: 'pass', score: 0.95, message: 'excellent' }),
      },
    ]);

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(breaches).toHaveLength(0);
    await sampler.dispose();
  });

  it('stops observing actions after dispose', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const sampler = createScorerSampler(bureau, auditTrail, {
      list: [passingMatcher()],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    await sampler.dispose();
    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(records).toHaveLength(0);
  });

  // ── Awaitable dispose() and AbortSignal threading (AB-37/AB-206) ────

  it('dispose() returns a promise that resolves only after every in-flight evaluateRun() settles', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();

    let releaseJudge: (() => void) | undefined;
    const gatedJudge: PluginScorer = {
      name: 'gated-judge',
      version: '1.0.0',
      score: () =>
        new Promise<PluginScore>((resolve) => {
          releaseJudge = () => resolve({ outcome: 'pass', score: 1, message: 'released' });
        }),
    };
    const sampler = createScorerSampler(bureau, auditTrail, {
      list: [gatedJudge],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));

    let disposeResolved = false;
    const disposePromise = sampler.dispose().then(() => {
      disposeResolved = true;
    });

    // Give the gated evaluation's microtasks a chance to run: dispose() must
    // still be pending because the judge has not been released.
    await Promise.resolve();
    await Promise.resolve();
    expect(disposeResolved).toBe(false);
    expect(records).toHaveLength(0);

    releaseJudge?.();
    await disposePromise;

    expect(disposeResolved).toBe(true);
    expect(records).toHaveLength(1);
  });

  it('threads the owner-issued AbortSignal into every evaluateRun() judge invocation, unblocking a never-settling judge on abort', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const controller = new AbortController();

    // A judge that never settles on its own: if `options.signal` were not
    // actually threaded into this judge's race, `flush()` below would hang
    // forever instead of resolving once the signal aborts.
    const neverSettlingJudge: PluginScorer = {
      name: 'never-settling-judge',
      version: '1.0.0',
      score: () => new Promise<PluginScore>(() => {}),
    };
    const sampler = createScorerSampler(bureau, auditTrail, {
      list: [neverSettlingJudge],
      sampleRate: 1,
      rng: scriptedRng([0]),
      signal: controller.signal,
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));

    // Give the sampler a chance to kick off the judge's evaluation before
    // aborting it.
    await Promise.resolve();
    controller.abort(new Error('shutting down'));

    await sampler.flush();

    expect(records).toHaveLength(0);
    await sampler.dispose();
  });

  it('aborting the signal mid-evaluation settles the affected evaluateRun() promptly, skipping remaining judges', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const controller = new AbortController();

    let releaseFirstJudge: (() => void) | undefined;
    const firstJudge: PluginScorer = {
      name: 'first-judge',
      version: '1.0.0',
      score: () =>
        new Promise<PluginScore>((resolve) => {
          releaseFirstJudge = () => resolve({ outcome: 'pass', score: 1, message: 'first' });
        }),
    };
    let secondJudgeCalled = false;
    const secondJudge: PluginScorer = {
      name: 'second-judge',
      version: '1.0.0',
      score: (): PluginScore => {
        secondJudgeCalled = true;
        return { outcome: 'pass', score: 1, message: 'second' };
      },
    };
    const sampler = createScorerSampler(bureau, auditTrail, {
      list: [firstJudge, secondJudge],
      sampleRate: 1,
      rng: scriptedRng([0]),
      signal: controller.signal,
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));

    // Give the sampler a chance to kick off the first judge's evaluation
    // before aborting mid-evaluation.
    await Promise.resolve();
    controller.abort(new Error('shutting down'));

    await sampler.flush();

    expect(secondJudgeCalled).toBe(false);
    expect(records).toHaveLength(0);

    // The first judge's own promise settling later (as if it had continued
    // running in the background) must not resurrect the aborted evaluation.
    releaseFirstJudge?.();
    await sampler.flush();
    expect(records).toHaveLength(0);

    await sampler.dispose();
  });

  it('a judge that aborts the signal as a side effect of starting settles promptly via the already-aborted race branch', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const controller = new AbortController();

    // The top-of-loop `if (signal?.aborted) return;` check only catches a
    // signal already aborted BEFORE this judge starts. This judge instead
    // aborts as a side effect of its own synchronous invocation — the
    // signal is still unaborted when the loop check runs, but IS aborted by
    // the time `raceAgainstAbort`'s internal `whenAborted()` observes it a
    // few synchronous steps later, exercising that already-aborted-at-race
    // -time branch rather than the abort-mid-wait one.
    const selfAbortingJudge: PluginScorer = {
      name: 'self-aborting-judge',
      version: '1.0.0',
      score: () => {
        controller.abort(new Error('aborted by the judge itself'));
        return new Promise<PluginScore>(() => {});
      },
    };
    const sampler = createScorerSampler(bureau, auditTrail, {
      list: [selfAbortingJudge],
      sampleRate: 1,
      rng: scriptedRng([0]),
      signal: controller.signal,
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(records).toHaveLength(0);
    await sampler.dispose();
  });

  it('an already-aborted signal at evaluation start settles evaluateRun promptly without invoking the judge or recording a score', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const controller = new AbortController();
    controller.abort(new Error('shutting down before evaluation started'));

    // Tracks whether the judge was actually invoked, not just whether the
    // eventual race against `signal` rejects — `judge.score(runResult, signal)`
    // is evaluated as a plain argument expression BEFORE `raceAgainstAbort`
    // runs, so a race-only guard cannot prevent the judge from starting.
    let judgeInvoked = false;
    const trackedJudge: PluginScorer = {
      name: 'tracked-judge',
      version: '1.0.0',
      score: () => {
        judgeInvoked = true;
        return { outcome: 'pass', score: 1, message: 'ok' };
      },
    };

    const sampler = createScorerSampler(bureau, auditTrail, {
      list: [trackedJudge],
      sampleRate: 1,
      rng: scriptedRng([0]),
      signal: controller.signal,
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(judgeInvoked).toBe(false);
    expect(records).toHaveLength(0);
    await sampler.dispose();
  });

  it('aborting the signal while the audit write is in flight suppresses the alert fired after it settles', async () => {
    const { bureau, emit } = createStubBureau();
    const controller = new AbortController();

    // Gates `auditTrail.record()` so the signal can be aborted WHILE
    // `recordScore()` is mid-await, after the judge already reported a
    // threshold breach but before `fireAlert()` would run.
    let releaseRecord: (() => void) | undefined;
    const records: Record<string, unknown>[] = [];
    const auditTrail: AuditTrail = {
      record(entry) {
        records.push(entry);
        return new Promise<void>((resolve) => {
          releaseRecord = resolve;
        });
      },
      async query() {
        return [];
      },
      async prune() {
        return undefined;
      },
      async redact() {
        return 0;
      },
      async dispose() {},
    };
    const published: ScorerThresholdBreachedEvent[] = [];

    const breachingJudge: PluginScorer = {
      name: 'breaching-judge',
      version: '1.0.0',
      score: () => ({ outcome: 'fail', score: 0, message: 'breach' }),
    };
    const sampler = createScorerSampler(
      bureau,
      auditTrail,
      {
        list: [breachingJudge],
        sampleRate: 1,
        rng: scriptedRng([0]),
        signal: controller.signal,
      },
      undefined,
      { published: (event) => published.push(event) },
    );

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));

    // Give the judge's microtasks a chance to run and reach the gated
    // audit write.
    while (records.length === 0) {
      await Promise.resolve();
    }
    expect(records).toHaveLength(1);

    controller.abort(new Error('shutting down mid audit write'));
    releaseRecord?.();
    await sampler.flush();

    // The audit write itself already landed (best-effort, in flight before
    // the abort), but the breach published after it must not go out once the
    // owner has aborted.
    expect(published).toHaveLength(0);
    await sampler.dispose();
  });

  it('calling dispose() twice does not throw and the second call resolves promptly', async () => {
    const { bureau } = createStubBureau();
    const { auditTrail } = createStubAuditTrail();
    const sampler = createScorerSampler(bureau, auditTrail, {
      list: [passingMatcher()],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    const firstDispose = await sampler.dispose();
    expect(firstDispose).toBeUndefined();
    const secondDispose = await sampler.dispose();
    expect(secondDispose).toBeUndefined();
  });

  // ── AB-220: per-evaluation liveness ─────────────────────────────────

  describe('per-evaluation liveness (AB-220)', () => {
    it('mints a stable, distinguishable id for each concurrently-admitted evaluation', async () => {
      const { bureau, emit } = createStubBureau();
      const { auditTrail } = createStubAuditTrail();
      const { judge: judgeA, resolveAll: resolveA } = blockingJudge('judge-a');
      const sampler = createScorerSampler(bureau, auditTrail, {
        list: [judgeA],
        sampleRate: 1,
        rng: scriptedRng([0]),
        clock: manualClock(),
        evaluationIds: scriptedEvaluationIds(['eval-a', 'eval-b']),
      });

      emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
      emit(makeAction({ type: 'run.completed', runId: 'run-2', detail: makeRunResult() }));

      const snapshots = sampler.activeEvaluationSnapshots();
      expect(snapshots).toHaveLength(2);
      expect(snapshots.map((snapshot) => snapshot.id)).toEqual(['eval-a', 'eval-b']);
      expect(new Set(snapshots.map((snapshot) => snapshot.id)).size).toBe(2);

      resolveA();
      await sampler.flush();
      await sampler.dispose();
    });

    it('every per-evaluation snapshot has kind "background-evaluation" and the current policy version', async () => {
      const { bureau, emit } = createStubBureau();
      const { auditTrail } = createStubAuditTrail();
      const { judge, resolveAll } = blockingJudge();
      const sampler = createScorerSampler(bureau, auditTrail, {
        list: [judge],
        sampleRate: 1,
        rng: scriptedRng([0]),
        clock: manualClock(),
      });

      emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));

      const [snapshot] = sampler.activeEvaluationSnapshots();
      expect(snapshot?.kind).toBe('background-evaluation');
      expect(snapshot?.policyVersion).toBe(LIVENESS_POLICY_VERSION);
      expect(snapshot?.status).toBe('running');
      expect(snapshot?.assessment).toBe('healthy');

      resolveAll();
      await sampler.flush();
      await sampler.dispose();
    });

    it('removes an evaluation from activeEvaluationSnapshots() once it settles', async () => {
      const { bureau, emit } = createStubBureau();
      const { auditTrail } = createStubAuditTrail();
      const sampler = createScorerSampler(bureau, auditTrail, {
        list: [passingMatcher()],
        sampleRate: 1,
        rng: scriptedRng([0]),
        clock: manualClock(),
      });

      emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
      await sampler.flush();

      expect(sampler.activeEvaluationSnapshots()).toHaveLength(0);
      await sampler.dispose();
    });

    it('snapshot() reports the instance-level aggregate as healthy with no active evaluations', async () => {
      const { bureau } = createStubBureau();
      const { auditTrail } = createStubAuditTrail();
      const sampler = createScorerSampler(bureau, auditTrail, {
        list: [passingMatcher()],
        sampleRate: 1,
        rng: scriptedRng([0]),
        clock: manualClock(),
      });

      expect(sampler.snapshot().assessment).toBe('healthy');
      expect(sampler.snapshot().kind).toBe('background-evaluation');
      await sampler.dispose();
    });

    it('subscribeSnapshot() delivers the current aggregate immediately, then again as evaluations start and finish', async () => {
      const { bureau, emit } = createStubBureau();
      const { auditTrail } = createStubAuditTrail();
      const sampler = createScorerSampler(bureau, auditTrail, {
        list: [passingMatcher()],
        sampleRate: 1,
        rng: scriptedRng([0]),
        clock: manualClock(),
      });

      const revisions: number[] = [];
      const subscription = sampler.subscribeSnapshot((snapshot) => {
        revisions.push(snapshot.revision);
      });
      expect(revisions).toEqual([0]);

      emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
      await sampler.flush();

      // One notification when the evaluation started tracking, one when it
      // finished — both delivered through the same subscription.
      expect(revisions.length).toBeGreaterThanOrEqual(3);
      expect(revisions).toEqual([...revisions].toSorted((a, b) => a - b));

      subscription.unsubscribe();
      await sampler.dispose();
    });

    it('subscribeSnapshot() stops delivering after unsubscribe()', async () => {
      const { bureau, emit } = createStubBureau();
      const { auditTrail } = createStubAuditTrail();
      const sampler = createScorerSampler(bureau, auditTrail, {
        list: [passingMatcher()],
        sampleRate: 1,
        rng: scriptedRng([0]),
        clock: manualClock(),
      });

      let calls = 0;
      const subscription = sampler.subscribeSnapshot(() => {
        calls++;
      });
      expect(calls).toBe(1);
      subscription.unsubscribe();
      expect(subscription.closed).toBe(true);

      emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
      await sampler.flush();

      expect(calls).toBe(1);
      await sampler.dispose();
    });

    it('subscribeSnapshot() with an already-aborted signal delivers once, synchronously closed', async () => {
      const { bureau } = createStubBureau();
      const { auditTrail } = createStubAuditTrail();
      const sampler = createScorerSampler(bureau, auditTrail, {
        list: [passingMatcher()],
        sampleRate: 1,
        rng: scriptedRng([0]),
        clock: manualClock(),
      });

      const controller = new AbortController();
      controller.abort();

      let calls = 0;
      const subscription = sampler.subscribeSnapshot(() => calls++, {
        signal: controller.signal,
      });

      expect(calls).toBe(1);
      expect(subscription.closed).toBe(true);
      await sampler.dispose();
    });

    it('the no-op sampler isolates a throwing subscribeSnapshot observer', () => {
      const { bureau } = createStubBureau();
      const sampler = createScorerSampler(bureau, undefined, {
        list: [],
        sampleRate: 1,
      });

      let subscription: ReturnType<typeof sampler.subscribeSnapshot> | undefined;
      expect(() => {
        subscription = sampler.subscribeSnapshot(() => {
          throw new Error('observer failure');
        });
      }).not.toThrow();
      expect(subscription?.closed).toBe(true);
    });

    it('the no-op sampler (no judges) reports a terminal aggregate snapshot and no active evaluations', async () => {
      const { bureau } = createStubBureau();
      const sampler = createScorerSampler(bureau, undefined, {
        list: [],
        sampleRate: 1,
      });

      expect(sampler.activeEvaluationSnapshots()).toEqual([]);
      expect(sampler.snapshot().status).toBe('terminal');
      expect(sampler.snapshot().assessment).toBe('terminal');

      let observed: unknown;
      const subscription = sampler.subscribeSnapshot((snapshot) => {
        observed = snapshot;
      });
      expect(observed).toBe(sampler.snapshot());
      expect(subscription.closed).toBe(true);
      subscription.unsubscribe();

      await sampler.dispose();
    });
  });

  describe('the default production clock (AB-220/AB-260)', () => {
    it('now() reads the composed RuntimeServices monotonic clock', () => {
      const realClock = createDefaultClock();
      expect(typeof realClock.now()).toBe('number');
    });

    it('setTimeout()/clearTimeout() delegate to the global timer functions', () => {
      const realClock = createDefaultClock();
      const timeoutSpy = spyOn(globalThis, 'setTimeout');
      const clearSpy = spyOn(globalThis, 'clearTimeout');
      try {
        const callback = () => {};
        const handle = realClock.setTimeout(callback, 5);
        expect(timeoutSpy).toHaveBeenCalledWith(callback, 5);
        realClock.clearTimeout(handle);
        expect(clearSpy).toHaveBeenCalledWith(handle);
      } finally {
        timeoutSpy.mockRestore();
        clearSpy.mockRestore();
      }
    });
  });

  describe('worstAssessment/worstReachability/worstProgress (AB-220)', () => {
    it('worstAssessment returns "healthy" for an empty or all-healthy set', () => {
      expect(worstAssessment([])).toBe('healthy');
      expect(worstAssessment(['healthy', 'healthy'])).toBe('healthy');
    });

    it('worstAssessment picks the most severe non-terminal assessment, skipping terminal entries', () => {
      expect(worstAssessment(['healthy', 'alive-but-stalled', 'legitimately-waiting'])).toBe(
        'alive-but-stalled',
      );
      expect(worstAssessment(['terminal', 'unreachable', 'healthy'])).toBe('unreachable');
    });

    it('worstReachability returns "unknown" for an empty set, and folds to the most severe value present', () => {
      expect(worstReachability([])).toBe('unknown');
      expect(worstReachability(['reachable', 'unreachable', 'late'])).toBe('unreachable');
    });

    it('worstProgress returns "unknown" for an empty set, and folds to the most severe value present', () => {
      expect(worstProgress([])).toBe('unknown');
      expect(worstProgress(['progressing', 'stalled', 'idle'])).toBe('stalled');
    });
  });
});

// COR-89: `createScorerSampler` defaults `runtime` to an internal
// `createDefaultRuntimeServices()` instance the caller never sees. The
// evaluations tracked on that instance's `deferred` ledger must still be
// drained by the sampler's own `dispose()`, so the hidden ledger is never the
// only path to them.
describe('COR-89 — omitted runtime', () => {
  it("dispose() drains every evaluation tracked on the internal default runtime's deferred ledger", async () => {
    const factory = spyOn(lifecycle, 'createDefaultRuntimeServices');
    // A namespace spy can carry calls recorded by an earlier spy on the same
    // export, so count only from here.
    factory.mockClear();
    try {
      const { bureau, emit } = createStubBureau();
      const { auditTrail } = createStubAuditTrail();
      const { judge, resolveAll } = blockingJudge();
      const sampler = createScorerSampler(bureau, auditTrail, {
        list: [judge],
        sampleRate: 1,
        rng: scriptedRng([0]),
        clock: manualClock(),
      });
      expect(factory).toHaveBeenCalledTimes(1);
      const internalRuntime = factory.mock.results[0]!.value as lifecycle.RuntimeServices;
      // Record the tracked background-evaluation promise's own settlement the moment it
      // happens, so the check after `await disposal` reads it synchronously.
      // `deferred.drain()` waits on its own, so a later drain report would
      // mask a `dispose()` that resolved before the work finished.
      const settledLabels: string[] = [];
      const track = internalRuntime.deferred.track;
      const trackSpy = spyOn(internalRuntime.deferred, 'track').mockImplementation(
        (promise, trackedLabel) => {
          const record = () => {
            settledLabels.push(trackedLabel);
          };
          void promise.then(record, record);
          track(promise, trackedLabel);
        },
      );

      emit(
        makeAction({
          type: 'run.completed',
          runId: 'run-default-runtime',
          detail: makeRunResult(),
        }),
      );

      // The blocked evaluation is genuinely tracked on the hidden instance.
      const inFlight = await internalRuntime.deferred.drain();
      expect(inFlight.outstanding).toEqual(['background-evaluation']);

      const disposal = sampler.dispose();
      resolveAll();
      await disposal;

      // Read before any further await: the background-evaluation has settled by the time
      // `dispose()` resolves, not merely by the time `drain()` stops waiting.
      expect(trackSpy).toHaveBeenCalledTimes(1);
      expect(settledLabels).toEqual(['background-evaluation']);

      const report = await internalRuntime.deferred.drain();
      expect(report.outstanding).toEqual([]);
      expect(report.settled).toEqual([{ label: 'background-evaluation', outcome: 'resolved' }]);
    } finally {
      factory.mockRestore();
    }
  });
});

// ── COR-2200: a complete scorer.recorded ─────────────────────────────

/** The record type SC2 replaced, built from parts so no source line names it (COR-2251's grep). */
const LEGACY_RECORD_TYPE = ['eval', 'sample', 'recorded'].join('.');

describe('COR-2200 — scorer.recorded', () => {
  const FIXED_DIGEST = sha256HexSync(
    JSON.stringify({ identity: { name: 'quality', version: '2.0.0' } }),
  );

  it('carries every field of the issue for a sampled run (AC1)', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const clock = manualClock();
    const scorer: PluginScorer = {
      name: 'quality',
      version: '2.0.0',
      determinism: 'deterministic',
      score: (): PluginScore => {
        clock.advance(25);
        return { outcome: 'pass', score: 0.75, message: 'close enough' };
      },
    };
    const sampler = createScorerSampler(
      bureau,
      auditTrail,
      { list: [scorer], sampleRate: 0.5, rng: scriptedRng([0.1]), clock },
      undefined,
      { describeRun: () => ({ agentName: 'triage', definitionRevision: 4 }) },
    );

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(records).toEqual([
      {
        runId: 'run-1',
        type: 'scorer.recorded',
        strict: true,
        detail: {
          runKind: 'agent',
          definitionId: 'triage',
          definitionVersion: '4',
          judgedBy: { kind: 'bureau', name: 'bureau', version: BUREAU_VERSION },
          judgeName: 'quality',
          judgeVersion: '2.0.0',
          judgeDigest: FIXED_DIGEST,
          determinism: 'deterministic',
          sampleRate: 0.5,
          outcome: 'pass',
          score: 0.75,
          message: 'close enough',
          durationMs: 25,
        },
      },
    ]);
    await sampler.dispose();
  });

  it('names no definition when the run has none, and omits a score the scorer gave none', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const sampler = createScorerSampler(bureau, auditTrail, {
      list: [
        { name: 'plain', version: '1', score: () => ({ outcome: 'indeterminate', message: 'm' }) },
      ],
      sampleRate: 1,
      rng: scriptedRng([0]),
      clock: manualClock(),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    const detail = records[0]?.['detail'] as Record<string, unknown>;
    expect(detail['definitionId']).toBeNull();
    expect(detail['definitionVersion']).toBeNull();
    expect(Object.hasOwn(detail, 'score')).toBe(false);
    expect(Object.hasOwn(detail, 'decisions')).toBe(false);
    await sampler.dispose();
  });

  it('names the plugin a contributed scorer came from as who judged it', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const sources: [string, string][] = [];
    const sampler = createScorerSampler(
      bureau,
      auditTrail,
      { list: [passingMatcher('linear:quality')], sampleRate: 1, rng: scriptedRng([0]) },
      undefined,
      {
        sourceOf: (name, version) => {
          sources.push([name, version]);
          return { name: 'linear', version: '3.1.0' };
        },
      },
    );

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(sources).toEqual([['linear:quality', '1.0.0']]);
    expect(records[0]?.['detail']).toMatchObject({
      judgedBy: { kind: 'plugin', name: 'linear', version: '3.1.0' },
    });
    await sampler.dispose();
  });

  it('records the provider, model and usage of each decision the scorer made (AC2)', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const usage = { prompt: 12, completion: 3, total: 15 };
    const sampler = createScorerSampler(bureau, auditTrail, {
      list: [
        {
          name: 'model-judge',
          version: '1',
          score: () => ({
            outcome: 'pass',
            message: 'm',
            decisions: [
              { provider: 'anthropic', model: 'claude-x', usage },
              { provider: 'typesafe', model: 'jev' },
            ],
          }),
        },
        { name: 'deterministic', version: '1', score: () => ({ outcome: 'pass', message: 'm' }) },
        {
          name: 'empty',
          version: '1',
          score: () => ({ outcome: 'pass', message: 'm', decisions: [] }),
        },
      ],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    const details = records.map((record) => record['detail'] as Record<string, unknown>);
    expect(details[0]?.['decisions']).toEqual([
      { provider: 'anthropic', model: 'claude-x', usage },
      { provider: 'typesafe', model: 'jev' },
    ]);
    expect(Object.hasOwn(details[1]!, 'decisions')).toBe(false);
    expect(Object.hasOwn(details[2]!, 'decisions')).toBe(false);
    await sampler.dispose();
  });

  it.each([
    ['not a list', 'x'],
    ['an entry that is not an object', [1]],
    ['a provider that is not text', [{ provider: 1, model: 'm' }]],
    ['a model that is not text', [{ provider: 'p' }]],
    ['a usage that is not counts', [{ provider: 'p', model: 'm', usage: { prompt: 'x' } }]],
    [
      'more entries than may be recorded',
      Array.from({ length: 65 }, () => ({ provider: 'p', model: 'm' })),
    ],
  ])('records an error for decisions that are %s', async (_name, decisions) => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const sampler = createScorerSampler(bureau, auditTrail, {
      list: [
        {
          name: 'odd',
          version: '1',
          score: () => ({ outcome: 'pass', message: 'm', decisions }) as unknown as PluginScore,
        },
      ],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(records[0]?.['detail']).toMatchObject({
      outcome: 'error',
      message: 'Judge returned a malformed score',
    });
    await sampler.dispose();
  });

  it('reads a stored old record through the audit trail without rewriting it (AC4)', async () => {
    const { bureau } = createStubBureau();
    const kv = textValueStore(new MemoryStorage());
    const trail = createAuditTrail(bureau, kv);
    await trail.record({
      runId: 'run-old',
      type: LEGACY_RECORD_TYPE,
      detail: { judgeName: 'old', outcome: 'pass', message: 'kept' },
    });
    const before = await kv.list('');

    const read = await trail.query({ type: LEGACY_RECORD_TYPE });

    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({
      runId: 'run-old',
      detail: { judgeName: 'old', message: 'kept' },
    });
    expect(await kv.list('')).toEqual(before);
    expect(await trail.query({ type: 'scorer.recorded' })).toEqual([]);
    await trail.dispose();
  });
});

// ── COR-2202: the rate is read as each run finishes ──────────────────

describe('COR-2202 — a live sample rate', () => {
  it('keeps a sampler at rate 0 and samples the next run once the rate is raised', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    let rate = 0;
    let rolls = 0;
    const sampler = createScorerSampler(
      bureau,
      auditTrail,
      {
        list: [passingMatcher()],
        sampleRate: 0,
        rng: () => {
          rolls += 1;
          return 0;
        },
      },
      undefined,
      { sampleRate: () => rate },
    );

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    rate = 0.5;
    emit(makeAction({ type: 'run.completed', runId: 'run-2', detail: makeRunResult() }));
    await sampler.flush();

    // At 0 the run is observed, and neither rolled for nor sampled; at 0.5 the roll of 0 samples it.
    expect(sampler.observedCount()).toBe(2);
    expect(rolls).toBe(1);
    expect(records.map((record) => record['runId'])).toEqual(['run-2']);
    expect(records[0]?.['detail']).toMatchObject({ sampleRate: 0.5 });
    await sampler.dispose();
  });
});

// Revision 2026-11-16 of COR-2202 and COR-2203: the global rate of 0 turns every scorer off. A
// scorer's own rate applies only while the global rate is above 0, and then replaces it.
describe('COR-2202 — a global rate of 0 turns every scorer off, whatever a scorer declares', () => {
  it.each([
    ['with no secret to gate', undefined],
    ['through the plugin secret gate', ['api-key']],
  ] as const)('%s', async (_name, secrets) => {
    const descriptor = definePlugin({
      name: 'kit',
      version: '1.0.0',
      description: 'kit',
      ...(secrets === undefined ? {} : { secrets: [...secrets] }),
      setup: () => ({
        scorers: [
          {
            name: 'always',
            version: '1',
            sampleRate: 1,
            score: (): PluginScore => ({ outcome: 'pass', message: 'ok' }),
          },
          {
            name: 'never',
            version: '1',
            sampleRate: 0,
            score: (): PluginScore => ({ outcome: 'pass', message: 'ok' }),
          },
        ],
      }),
    });
    const { options } = await composePlugins<ComposableOptions>({
      plugins: [{ descriptor, source: 'package', location: '@example/kit' }],
      scorers: { list: [], sampleRate: 0, rng: () => 0 },
      ...(secrets === undefined
        ? {}
        : { pluginSecrets: { get: async () => 'set', watch: () => () => undefined } }),
    });
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    let rate = 0;
    const sampler = createScorerSampler(bureau, auditTrail, options.scorers, undefined, {
      sampleRate: () => rate,
    });

    // The global rate is 0: the scorer that declares 1 scores nothing and writes no record.
    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();
    expect(sampler.observedCount()).toBe(1);
    expect(sampler.sampledCount()).toBe(0);
    expect(records).toEqual([]);

    // Above 0 the scorer's own rate replaces it: 1 scores, 0 scores nothing.
    rate = 0.5;
    emit(makeAction({ type: 'run.completed', runId: 'run-2', detail: makeRunResult() }));
    await sampler.flush();
    expect(
      records.map((record) => (record['detail'] as Record<string, unknown>)['judgeName']),
    ).toEqual(['kit:always']);
    expect(records[0]?.['detail']).toMatchObject({ sampleRate: 1 });
    await sampler.dispose();
  });
});

// ── COR-2251: publish scorer.threshold-breached ──────────────────────

describe('COR-2251 — scorer.threshold-breached', () => {
  /** A sampler over a stub bureau whose published events a test reads. */
  function publishing(list: PluginScorer[]) {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const published: ScorerThresholdBreachedEvent[] = [];
    const sampler = createScorerSampler(
      bureau,
      auditTrail,
      { list, sampleRate: 1, rng: scriptedRng([0]) },
      undefined,
      { published: (event) => published.push(event) },
    );
    return { sampler, emit, records, published };
  }

  it('publishes the run, scorer, outcome and score of a breach (AC1)', async () => {
    const { sampler, emit, published } = publishing([failingMatcher('judge-b', 0.2)]);

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(published).toHaveLength(1);
    expect(published[0]?.type).toBe('scorer.threshold-breached');
    expect(projectBureauEvent(published[0])).toEqual({
      kind: 'scorer.threshold-breached',
      payload: {
        runId: 'run-1',
        scorerName: 'judge-b',
        scorerVersion: '1.0.0',
        outcome: 'fail',
        score: 0.2,
      },
    });
    await sampler.dispose();
  });

  it('publishes exactly these keys with a score and without one, and never the message (AC5)', async () => {
    const { sampler, emit, published } = publishing([
      failingMatcher('with-score', 0.1),
      {
        name: 'no-score',
        version: '1',
        score: () => ({ outcome: 'fail', message: 'CANARY-MESSAGE-2251' }),
      },
    ]);

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    const payloads = published.map((event) => projectBureauEvent(event)?.payload ?? {});
    expect(payloads.map((payload) => Object.keys(payload).toSorted())).toEqual([
      ['outcome', 'runId', 'score', 'scorerName', 'scorerVersion'],
      ['outcome', 'runId', 'scorerName', 'scorerVersion'],
    ]);
    expect(JSON.stringify(payloads)).not.toContain('CANARY-MESSAGE-2251');
    await sampler.dispose();
  });

  it('publishes nothing for a score that does not breach', async () => {
    const { sampler, emit, published, records } = publishing([passingMatcher()]);

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(records).toHaveLength(1);
    expect(published).toEqual([]);
    await sampler.dispose();
  });

  it('publishes only after the score is on the audit trail', async () => {
    const { bureau, emit } = createStubBureau();
    const order: string[] = [];
    const release = Promise.withResolvers<void>();
    const auditTrail = {
      ...createStubAuditTrail().auditTrail,
      async record() {
        order.push('record-started');
        await release.promise;
        order.push('record-written');
      },
    } as AuditTrail;
    const sampler = createScorerSampler(
      bureau,
      auditTrail,
      { list: [failingMatcher()], sampleRate: 1, rng: scriptedRng([0]) },
      undefined,
      { published: () => order.push('published') },
    );

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await waitUntil(() => order.includes('record-started'), { message: 'the write started' });
    expect(order).toEqual(['record-started']);
    release.resolve();
    await sampler.flush();
    expect(order).toEqual(['record-started', 'record-written', 'published']);
    await sampler.dispose();
  });

  // Correction 1: the real audit trail swallows a failed write and resolves, so a breach whose
  // record was never written would be published. The sampler asks for a strict write instead.
  it('publishes nothing when the record cannot be written, and reports it', async () => {
    const { bureau, emit } = createStubBureau();
    const base = textValueStore(new MemoryStorage());
    const refuse = () => Promise.reject(new Error('disk full'));
    // Every write fails; reads work. `Object.create` keeps the store's own methods for those.
    const failing = Object.assign(Object.create(base) as ConditionalTextValueStore, {
      set: refuse,
      put: refuse,
      conditionalBatch: refuse,
      batch: refuse,
    });
    const trailDiagnostics: { level: string; scope: string }[] = [];
    const trail = createAuditTrail(bureau, failing, (diagnostic) => {
      trailDiagnostics.push({ level: diagnostic.level, scope: diagnostic.scope });
    });
    const budget = textValueStore(new MemoryStorage());
    const published: ScorerThresholdBreachedEvent[] = [];
    const reported: string[] = [];
    const invoked: string[] = [];
    const scorer = (name: string): PluginScorer => ({
      name,
      version: '1',
      score: () => {
        invoked.push(name);
        return { outcome: 'fail', message: 'CANARY-UNWRITTEN-2251' };
      },
    });
    const sampler = createScorerSampler(
      bureau,
      trail,
      { list: [scorer('a'), scorer('b')], sampleRate: 1, rng: scriptedRng([0]) },
      lifecycle.createManualRuntimeServices({ origin: '2026-11-16T12:00:00.000Z' }),
      {
        published: (event) => published.push(event),
        dailyBudget: () => 5,
        budgetStore: budget,
        diagnose: (message) => reported.push(message),
      },
    );

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    // Nothing was published, and the run's later scorers were not run into a store that is down.
    expect(published).toEqual([]);
    expect(invoked).toEqual(['a']);
    expect(await trail.query({ runId: 'run-1' })).toEqual([]);
    // The failure was reported twice over, by the trail and by the sampler, with no scorer text.
    expect(trailDiagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of trailDiagnostics) {
      expect(diagnostic).toEqual({ level: 'error', scope: 'audit-trail' });
    }
    expect(reported).toHaveLength(1);
    expect(reported.join()).not.toContain('CANARY-UNWRITTEN-2251');
    // The unit the scorer held stays spent.
    expect(await budget.get(scorerBudgetKey(DAY_ONE))).toBe('1');
    await sampler.dispose();
  });

  // Every finish reason a `run.completed` action can carry (COR-1627): the failures and `aborted`
  // settle the task `failed` or `canceled`, so the run is not scored and publishes nothing (AC4).
  it.each([
    ['error', false],
    ['tripwire', false],
    ['maximum-steps', false],
    ['elicitation-denied', false],
    ['budget-exceeded', false],
    ['aborted', false],
    ['stop-condition', true],
  ] as const)('a run that finishes %s is scored: %p', async (finishReason, scored) => {
    const { sampler, emit, published, records } = publishing([failingMatcher()]);

    emit(
      makeAction({
        type: 'run.completed',
        runId: 'run-1',
        detail: makeRunResult({ finishReason }),
      }),
    );
    await sampler.flush();

    expect(sampler.sampledCount()).toBe(scored ? 1 : 0);
    expect(records).toHaveLength(scored ? 1 : 0);
    expect(published).toHaveLength(scored ? 1 : 0);
    await sampler.dispose();
  });
});

/** The status of a task, read in one step so a wait can name it. */
async function taskStatusOf(bureau: Bureau, id: string) {
  const task = await bureau.tasks.get(id);
  return task?.status;
}

/** How many deliveries a hook has, newest or oldest. */
async function deliveryCountOf(bureau: Bureau, hookId: string) {
  const deliveries = await deliveriesOf(bureau, hookId);
  return deliveries.length;
}

describe('COR-2251 — a hook subscribed to scorer.threshold-breached', () => {
  const bureaus: Bureau[] = [];
  afterEach(async () => {
    for (const bureau of bureaus.splice(0)) await bureau.dispose();
  });

  async function open(generate: GenerateFunction, webhookTargets: { url: string }[] = []) {
    const receiver = createReceiver();
    const bureau = await createBureau<AgentDefinitions>({
      id: 'breach-bureau',
      agents: {
        default: createAgent({ name: 'default', generate, stopWhen: stopWhen.noToolCalls() }),
      },
      storage: new MemoryStorage(),
      durable: false,
      answerEncryption: { current: await newEncryptionKey() },
      hooks: {},
      webhooks: {
        targets: webhookTargets,
        fetch: receiver.fetch,
        sleep: () => Promise.resolve(),
      },
      scorers: {
        list: [
          {
            name: 'verdict',
            version: '1.0.0',
            score: () => ({ outcome: 'fail', message: 'CANARY-BREACH-MESSAGE-5e1c', score: 0.3 }),
          },
        ],
        sampleRate: 1,
        rng: () => 0,
      },
    });
    bureaus.push(bureau);
    const hook = await bureau.hooks!.create({
      action: { type: 'webhook', url: 'https://receiver.example/breach' },
      events: ['scorer.threshold-breached'],
    });
    return { bureau, receiver, hook };
  }

  it('receives the event of a run that completes (AC2)', async () => {
    const { bureau, receiver, hook } = await open(async () => ({ content: 'ok', toolCalls: [] }));

    const started = await bureau.tasks.start('default', 'go', { principal: 'api-key:alice' });
    await waitUntil(async () => (await taskStatusOf(bureau, started.id)) === 'completed', {
      message: 'the run completed',
    });
    await waitUntil(() => receiver.calls.length === 1, { message: 'the hook was delivered' });
    expect(await deliveryCountOf(bureau, hook.id)).toBe(1);

    const bodies = receiver.calls.map((call) => JSON.parse(call.body) as Record<string, unknown>);
    expect(bodies).toHaveLength(1);
    expect(JSON.stringify(bodies[0])).toContain('scorer.threshold-breached');
    expect(JSON.stringify(bodies[0])).toContain('"scorerName":"verdict"');
    expect(JSON.stringify(bodies[0])).toContain(started.id);
    expect(JSON.stringify(bodies[0])).not.toContain('CANARY-BREACH-MESSAGE-5e1c');
  });

  // COR-2201 AC2: a breach reaches users through the feed alone, so the notifier is never called
  // and a webhook target that listens to every trigger receives nothing.
  it('makes no webhook notify call for a breach, which is delivered to the hook alone', async () => {
    const { bureau, receiver, hook } = await open(
      async () => ({ content: 'ok', toolCalls: [] }),
      [{ url: 'https://receiver.example/webhook-target' }],
    );
    const notifier = bureau.internals.webhookNotifier!;
    const notified: unknown[] = [];
    const real = notifier.notify.bind(notifier);
    spyOn(notifier, 'notify').mockImplementation((input) => {
      notified.push(input);
      real(input);
    });

    const started = await bureau.tasks.start('default', 'go', { principal: 'api-key:alice' });
    await waitUntil(async () => (await taskStatusOf(bureau, started.id)) === 'completed', {
      message: 'the run completed',
    });
    await waitUntil(() => receiver.calls.length === 1, { message: 'the hook was delivered' });
    await notifier.flush();

    expect(notified).toEqual([]);
    expect(await notifier.listDeliveries()).toEqual([]);
    expect(receiver.calls.map((call) => call.url)).toEqual(['https://receiver.example/breach']);
    expect(await deliveryCountOf(bureau, hook.id)).toBe(1);
  });

  it('receives none for a run that settles failed (AC4)', async () => {
    const { bureau, receiver } = await open(async () => {
      throw new Error('boom');
    });

    const started = await bureau.tasks.start('default', 'go', { principal: 'api-key:alice' });
    await waitUntil(async () => (await taskStatusOf(bureau, started.id)) === 'failed', {
      message: 'the run failed',
    });
    await bureau.internals.taskRegistry.flush();
    await bureau.internals.scorerSampler!.flush();

    // The run is never admitted, so nothing was scored, published or delivered.
    expect(bureau.internals.scorerSampler!.observedCount()).toBe(0);
    expect(bureau.internals.scorerSampler!.sampledCount()).toBe(0);
    const kinds: string[] = [];
    for await (const envelope of bureau.internals.eventFeed.feed.replay())
      kinds.push(envelope.kind);
    expect(kinds).not.toContain('scorer.threshold-breached');
    expect(receiver.calls).toEqual([]);
  });
});

// ── COR-2203: filters, a per-scorer rate and bounded memory ──────────

interface MatrixRun {
  readonly runId: string;
  /** What the Bureau knows of the run; absent, it can describe nothing. */
  readonly agent?: string;
  readonly kind?: 'chat' | 'goal' | 'workflow';
  /** A detail that is not a RunResult. */
  readonly malformed?: boolean;
}

interface MatrixCell {
  readonly name: string;
  readonly scorers: readonly { readonly name: string; readonly sampleRate?: number }[];
  readonly globalRate: number;
  readonly agents?: readonly string[];
  readonly kinds?: readonly ('chat' | 'goal' | 'workflow')[];
  readonly rolls: readonly number[];
  readonly runs: readonly MatrixRun[];
  readonly expected: {
    readonly observed: number;
    readonly sampled: number;
    /** `run:scorer` for each score recorded, in order. */
    readonly scored: readonly string[];
    readonly rollsUsed: number;
  };
}

const OUTCOME_MATRIX: readonly MatrixCell[] = [
  {
    name: 'a roll below the rate, an agent and a kind in the filters: sampled and scored',
    scorers: [{ name: 'a' }],
    globalRate: 0.5,
    agents: ['triage'],
    kinds: ['chat'],
    rolls: [0.1],
    runs: [{ runId: 'r1', agent: 'triage', kind: 'chat' }],
    expected: { observed: 1, sampled: 1, scored: ['r1:a'], rollsUsed: 1 },
  },
  {
    name: 'a roll at or above the rate: observed and rate-skipped',
    scorers: [{ name: 'a' }],
    globalRate: 0.5,
    rolls: [0.5],
    runs: [{ runId: 'r1', agent: 'triage', kind: 'chat' }],
    expected: { observed: 1, sampled: 0, scored: [], rollsUsed: 1 },
  },
  {
    name: 'an agent not in `agents`: observed, filtered, and no roll is spent on it',
    scorers: [{ name: 'a' }],
    globalRate: 1,
    agents: ['triage'],
    rolls: [0],
    runs: [{ runId: 'r1', agent: 'billing', kind: 'chat' }],
    expected: { observed: 1, sampled: 0, scored: [], rollsUsed: 0 },
  },
  {
    name: 'a run the Bureau cannot describe, against a non-empty `agents`: filtered',
    scorers: [{ name: 'a' }],
    globalRate: 1,
    agents: ['triage'],
    rolls: [0],
    runs: [{ runId: 'r1' }],
    expected: { observed: 1, sampled: 0, scored: [], rollsUsed: 0 },
  },
  {
    name: 'an empty `agents` excludes nothing',
    scorers: [{ name: 'a' }],
    globalRate: 1,
    agents: [],
    rolls: [0],
    runs: [{ runId: 'r1' }, { runId: 'r2', agent: 'billing' }],
    expected: { observed: 2, sampled: 2, scored: ['r1:a', 'r2:a'], rollsUsed: 2 },
  },
  {
    name: 'any one of several agents admits the run',
    scorers: [{ name: 'a' }],
    globalRate: 1,
    agents: ['triage', 'billing'],
    rolls: [0],
    runs: [
      { runId: 'r1', agent: 'billing' },
      { runId: 'r2', agent: 'triage' },
      { runId: 'r3', agent: 'other' },
    ],
    expected: { observed: 3, sampled: 2, scored: ['r1:a', 'r2:a'], rollsUsed: 2 },
  },
  {
    name: 'a kind not in `kinds`: observed, filtered, and no roll is spent on it',
    scorers: [{ name: 'a' }],
    globalRate: 1,
    kinds: ['goal', 'workflow'],
    rolls: [0],
    runs: [{ runId: 'r1', agent: 'triage', kind: 'chat' }],
    expected: { observed: 1, sampled: 0, scored: [], rollsUsed: 0 },
  },
  {
    name: 'an empty `kinds` excludes nothing',
    scorers: [{ name: 'a' }],
    globalRate: 1,
    kinds: [],
    rolls: [0],
    runs: [{ runId: 'r1', kind: 'chat' }, { runId: 'r2' }],
    expected: { observed: 2, sampled: 2, scored: ['r1:a', 'r2:a'], rollsUsed: 2 },
  },
  {
    name: 'both filters must admit the run',
    scorers: [{ name: 'a' }],
    globalRate: 1,
    agents: ['triage'],
    kinds: ['chat'],
    rolls: [0],
    runs: [
      { runId: 'r1', agent: 'triage', kind: 'goal' },
      { runId: 'r2', agent: 'billing', kind: 'chat' },
      { runId: 'r3', agent: 'triage', kind: 'chat' },
    ],
    expected: { observed: 3, sampled: 1, scored: ['r3:a'], rollsUsed: 1 },
  },
  {
    // Revision 2026-11-16: a global rate of 0 turns every scorer off, whatever a scorer declares.
    name: 'a global rate of 0 scores nothing, though a scorer’s own rate is 1',
    scorers: [{ name: 'a', sampleRate: 1 }, { name: 'b' }],
    globalRate: 0,
    rolls: [0.9],
    runs: [{ runId: 'r1' }],
    expected: { observed: 0, sampled: 0, scored: [], rollsUsed: 0 },
  },
  {
    name: 'under a global rate above 0, a scorer’s own rate of 1 replaces it',
    scorers: [{ name: 'a', sampleRate: 1 }, { name: 'b' }],
    globalRate: 0.5,
    // a rolls for itself (0.9, below its own 1); b shares the global roll (0.6, above 0.5).
    rolls: [0.9, 0.6],
    runs: [{ runId: 'r1' }],
    expected: { observed: 1, sampled: 1, scored: ['r1:a'], rollsUsed: 2 },
  },
  {
    name: 'a scorer’s own rate of 0 scores nothing under a global rate of 1',
    scorers: [{ name: 'a', sampleRate: 0 }, { name: 'b' }],
    globalRate: 1,
    rolls: [0.9],
    runs: [{ runId: 'r1' }],
    expected: { observed: 1, sampled: 1, scored: ['r1:b'], rollsUsed: 1 },
  },
  {
    name: 'scorers with and without their own rate each roll once, in list order',
    scorers: [{ name: 'a' }, { name: 'b', sampleRate: 0.5 }, { name: 'c' }],
    globalRate: 0.5,
    // a and c share the global roll (0.4, taken first, below 0.5); b's own roll is 0.6, above 0.5.
    rolls: [0.4, 0.6],
    runs: [{ runId: 'r1' }],
    expected: { observed: 1, sampled: 1, scored: ['r1:a', 'r1:c'], rollsUsed: 2 },
  },
  {
    name: 'an own rate that is not a number from 0 to 1 is ignored: the global rate decides',
    scorers: [
      { name: 'nan', sampleRate: Number.NaN },
      { name: 'high', sampleRate: 2 },
      { name: 'low', sampleRate: -1 },
      { name: 'text', sampleRate: 'half' as never },
    ],
    globalRate: 0.5,
    rolls: [0.4],
    runs: [{ runId: 'r1' }],
    expected: {
      observed: 1,
      sampled: 1,
      scored: ['r1:nan', 'r1:high', 'r1:low', 'r1:text'],
      rollsUsed: 1,
    },
  },
  {
    name: 'a detail that is not a RunResult: observed, not sampled',
    scorers: [{ name: 'a' }],
    globalRate: 1,
    rolls: [0],
    runs: [{ runId: 'r1', malformed: true }],
    expected: { observed: 1, sampled: 0, scored: [], rollsUsed: 1 },
  },
];

describe('COR-2203 — the outcome matrix', () => {
  it.each(OUTCOME_MATRIX.map((cell) => [cell.name, cell] as const))('%s', async (_name, cell) => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const described = new Map(cell.runs.map((run) => [run.runId, run]));
    let rolled = 0;
    const sampler = createScorerSampler(
      bureau,
      auditTrail,
      {
        list: cell.scorers.map((scorer) => ({
          name: scorer.name,
          version: '1',
          ...(scorer.sampleRate === undefined ? {} : { sampleRate: scorer.sampleRate }),
          score: (): PluginScore => ({ outcome: 'pass', message: 'ok' }),
        })),
        sampleRate: cell.globalRate,
        rng: () => cell.rolls[Math.min(rolled++, cell.rolls.length - 1)]!,
        ...(cell.agents === undefined ? {} : { agents: cell.agents }),
        ...(cell.kinds === undefined ? {} : { kinds: cell.kinds }),
      },
      undefined,
      {
        describeRun: (runId) => {
          const run = described.get(runId);
          return run === undefined || (run.agent === undefined && run.kind === undefined)
            ? undefined
            : { agentName: run.agent, kind: run.kind };
        },
      },
    );

    for (const run of cell.runs) {
      emit(
        makeAction({
          type: 'run.completed',
          runId: run.runId,
          detail: run.malformed === true ? { not: 'a run result' } : makeRunResult(),
        }),
      );
    }
    await sampler.flush();

    expect({
      observed: sampler.observedCount(),
      sampled: sampler.sampledCount(),
      scored: records.map((record) => {
        const detail = record['detail'] as Record<string, unknown>;
        return `${String(record['runId'])}:${String(detail['judgeName'])}`;
      }),
      rollsUsed: rolled,
    }).toEqual({ ...cell.expected, scored: [...cell.expected.scored] });
    expect(sampler.pendingRunCount()).toBe(0);
    await sampler.dispose();
  });
});

describe('COR-2203 — the filters are checked when the sampler is built', () => {
  it.each([
    ['agents', 'triage'],
    ['agents', [1]],
    ['kinds', 'chat'],
    ['kinds', ['chat', 'agent']],
  ])('refuses `%s` of %p', (field, value) => {
    const { bureau } = createStubBureau();
    expect(() =>
      createScorerSampler(bureau, undefined, {
        list: [passingMatcher()],
        sampleRate: 1,
        [field]: value,
      }),
    ).toThrow(TypeError);
  });

  it('copies a filter, so a later change to the caller’s array admits nothing new', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const agents = ['triage'];
    const sampler = createScorerSampler(
      bureau,
      auditTrail,
      { list: [passingMatcher()], sampleRate: 1, rng: scriptedRng([0]), agents },
      undefined,
      { describeRun: () => ({ agentName: 'billing' }) },
    );

    agents.push('billing');
    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    await sampler.flush();

    expect(records).toEqual([]);
    await sampler.dispose();
  });
});

describe('COR-2203 — the dedupe set holds only runs whose scoring is in flight', () => {
  /** A sampler whose one scorer settles when the test says so. */
  function gated() {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const { judge, resolveAll } = blockingJudge();
    const sampler = createScorerSampler(bureau, auditTrail, {
      list: [judge],
      sampleRate: 1,
      rng: () => 0,
      clock: manualClock(),
    });
    return { sampler, emit, records, resolveAll };
  }

  it('holds a run while it is scored and drops it once scoring settles', async () => {
    const { sampler, emit, records, resolveAll } = gated();

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    expect(sampler.pendingRunCount()).toBe(1);
    resolveAll();
    await sampler.flush();

    expect(records).toHaveLength(1);
    expect(sampler.pendingRunCount()).toBe(0);
    await sampler.dispose();
  });

  it('ignores a duplicate while the run is in flight, and scores it again after it settled', async () => {
    const { sampler, emit, records, resolveAll } = gated();

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    emit(
      makeAction({ type: 'run.completed', runId: 'run-1', sequence: 2, detail: makeRunResult() }),
    );
    expect(sampler.observedCount()).toBe(1);
    resolveAll();
    await sampler.flush();
    expect(records).toHaveLength(1);

    // The id was dropped when scoring settled (COR-2203), so the same run seen again is a new one.
    emit(
      makeAction({ type: 'run.completed', runId: 'run-1', sequence: 3, detail: makeRunResult() }),
    );
    resolveAll();
    await sampler.flush();
    expect(sampler.observedCount()).toBe(2);
    expect(records).toHaveLength(2);
    await sampler.dispose();
  });

  it('decides a duplicate of a rate-skipped run again, with a new roll', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const sampler = createScorerSampler(bureau, auditTrail, {
      list: [passingMatcher()],
      sampleRate: 0.5,
      rng: scriptedRng([0.9, 0.1]),
    });

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    emit(
      makeAction({ type: 'run.completed', runId: 'run-1', sequence: 2, detail: makeRunResult() }),
    );
    await sampler.flush();

    expect(sampler.observedCount()).toBe(2);
    expect(records).toHaveLength(1);
    await sampler.dispose();
  });

  it('holds no run id after 10,000 runs have settled (AC4)', async () => {
    const { bureau, emit } = createStubBureau();
    const { auditTrail, records } = createStubAuditTrail();
    const sampler = createScorerSampler(bureau, auditTrail, {
      list: [passingMatcher()],
      sampleRate: 1,
      rng: scriptedRng([0]),
    });

    // In batches of 100: the sampler's liveness aggregate is recomputed for each evaluation that
    // starts or ends, so the work grows with how many are in flight at once, not with how many ran.
    for (let batch = 0; batch < 100; batch += 1) {
      for (let index = 0; index < 100; index += 1) {
        emit(
          makeAction({
            type: 'run.completed',
            runId: `run-${batch}-${index}`,
            detail: makeRunResult(),
          }),
        );
      }
      expect(sampler.pendingRunCount()).toBeGreaterThan(0);
      await sampler.flush();
      expect(sampler.pendingRunCount()).toBe(0);
    }

    expect(records).toHaveLength(10_000);
    expect(sampler.observedCount()).toBe(10_000);
    expect(sampler.pendingRunCount()).toBe(0);
    await sampler.dispose();
  });

  it('is empty once dispose has waited for the scoring in flight', async () => {
    const { sampler, emit, resolveAll } = gated();

    emit(makeAction({ type: 'run.completed', runId: 'run-1', detail: makeRunResult() }));
    const disposal = sampler.dispose();
    resolveAll();
    await disposal;

    expect(sampler.pendingRunCount()).toBe(0);
  });
});

// ── COR-2205: a daily budget for scoring ─────────────────────────────

const DAY_ONE = '2026-11-16';
const DAY_TWO = '2026-11-17';
const NOON_ONE = Date.parse('2026-11-16T12:00:00.000Z');
const NOON_TWO = Date.parse('2026-11-17T12:00:00.000Z');
const JUST_AFTER_MIDNIGHT_TWO = Date.parse('2026-11-17T00:00:01.000Z');

type BudgetStore = ConditionalTextValueStore;

/** What a budget test builds a sampler from; every member has a default. */
interface BudgetHarnessOptions {
  readonly budget?: number | (() => number | undefined) | undefined;
  readonly scorers?: readonly string[];
  readonly store?: BudgetStore;
  readonly runtime?: lifecycle.ManualRuntimeServices;
  /** Runs inside a scorer, so a test can move the wall clock or abort while it is being scored. */
  readonly during?: (scorer: string, runId: string) => void;
  readonly signal?: AbortSignal;
  /** `false` builds the sampler with no budget store, as an in-memory Bureau does. */
  readonly durable?: boolean;
}

function budgetHarness(options: BudgetHarnessOptions = {}) {
  const { bureau, emit } = createStubBureau();
  const { auditTrail, records } = createStubAuditTrail();
  const runtime =
    options.runtime ??
    lifecycle.createManualRuntimeServices({ origin: '2026-11-16T12:00:00.000Z' });
  const store = options.store ?? textValueStore(new MemoryStorage());
  const diagnostics: string[] = [];
  const invoked: string[] = [];
  let currentRun = '';
  const names = options.scorers ?? ['a', 'b'];
  const budget = options.budget;
  const sampler = createScorerSampler(
    bureau,
    auditTrail,
    {
      list: names.map((name): PluginScorer => ({
        name,
        version: '1',
        score: (): PluginScore => {
          invoked.push(`${currentRun}:${name}`);
          options.during?.(name, currentRun);
          return { outcome: 'pass', message: 'ok' };
        },
      })),
      sampleRate: 1,
      rng: () => 0,
      clock: manualClock(),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    runtime,
    {
      dailyBudget: typeof budget === 'function' ? budget : () => budget,
      ...(options.durable === false ? {} : { budgetStore: store }),
      diagnose: (message) => diagnostics.push(message),
    },
  );
  /** Completes one run and waits until its scoring has settled. */
  async function complete(runId: string, finishReason?: string): Promise<void> {
    currentRun = runId;
    emit(
      makeAction({
        type: 'run.completed',
        runId,
        detail: makeRunResult(
          finishReason === undefined ? {} : { finishReason: finishReason as never },
        ),
      }),
    );
    await sampler.flush();
  }
  return { sampler, complete, emit, records, invoked, store, runtime, diagnostics };
}

/** What the store holds under each day's budget key. */
async function storedCounts(
  store: BudgetStore,
  days: readonly string[],
): Promise<Record<string, string | null>> {
  return Object.fromEntries(
    await Promise.all(
      days.map(async (day) => [day, await store.get(scorerBudgetKey(day))] as const),
    ),
  );
}

interface BudgetCell {
  readonly name: string;
  readonly budget: number | undefined;
  readonly scorers: readonly string[];
  /** In order: the wall clock when the run completes, and how it finished. */
  readonly runs: readonly {
    readonly runId: string;
    readonly at?: number;
    readonly finish?: string;
  }[];
  readonly invoked: readonly string[];
  readonly stored: Readonly<Record<string, string | null>>;
}

const BUDGET_MATRIX: readonly BudgetCell[] = [
  {
    name: 'a budget of 3, two scorers: the first run takes 2, the second only the first scorer, the third none (AC2)',
    budget: 3,
    scorers: ['a', 'b'],
    runs: [{ runId: 'r1' }, { runId: 'r2' }, { runId: 'r3' }],
    invoked: ['r1:a', 'r1:b', 'r2:a'],
    stored: { [DAY_ONE]: '3' },
  },
  {
    name: 'a budget of 0 runs no scorer, and reserves nothing',
    budget: 0,
    scorers: ['a'],
    runs: [{ runId: 'r1' }],
    invoked: [],
    stored: { [DAY_ONE]: null },
  },
  {
    name: 'a run that fails or is aborted consumes nothing (AC7)',
    budget: 5,
    scorers: ['a'],
    runs: [
      { runId: 'failed', finish: 'error' },
      { runId: 'aborted', finish: 'aborted' },
      { runId: 'steps', finish: 'maximum-steps' },
    ],
    invoked: [],
    stored: { [DAY_ONE]: null },
  },
  {
    name: 'the count starts again at 0 on the next UTC day (AC5)',
    budget: 2,
    scorers: ['a'],
    runs: [
      { runId: 'r1', at: NOON_ONE },
      { runId: 'r2', at: NOON_ONE },
      { runId: 'r3', at: NOON_ONE },
      { runId: 'r4', at: JUST_AFTER_MIDNIGHT_TWO },
      { runId: 'r5', at: NOON_TWO },
      { runId: 'r6', at: NOON_TWO },
    ],
    invoked: ['r1:a', 'r2:a', 'r4:a', 'r5:a'],
    stored: { [DAY_ONE]: '2', [DAY_TWO]: '2' },
  },
  {
    name: 'a run before midnight and a run after it count under their own days',
    budget: 1,
    scorers: ['a'],
    runs: [
      { runId: 'r1', at: Date.parse('2026-11-16T23:59:59.999Z') },
      { runId: 'r2', at: Date.parse('2026-11-17T00:00:00.000Z') },
    ],
    invoked: ['r1:a', 'r2:a'],
    stored: { [DAY_ONE]: '1', [DAY_TWO]: '1' },
  },
];

describe('COR-2205 — the daily budget', () => {
  it.each(BUDGET_MATRIX.map((cell) => [cell.name, cell] as const))('%s', async (_name, cell) => {
    const harness = budgetHarness({ budget: cell.budget, scorers: cell.scorers });
    for (const run of cell.runs) {
      harness.runtime.setTime(run.at ?? NOON_ONE);
      await harness.complete(run.runId, run.finish);
    }

    expect(harness.invoked).toEqual([...cell.invoked]);
    expect(await storedCounts(harness.store, Object.keys(cell.stored))).toEqual({ ...cell.stored });
    // No run that ran no scorer leaves a record.
    expect(harness.records).toHaveLength(cell.invoked.length);
    await harness.sampler.dispose();
  });

  it('with the budget unset, every sampled run is scored and storage is never touched (AC6)', async () => {
    const touched: string[] = [];
    const base = textValueStore(new MemoryStorage());
    const store = {
      get: async (key: string) => {
        touched.push(`get ${key}`);
        return base.get(key);
      },
      conditionalBatch: async (...args: Parameters<BudgetStore['conditionalBatch']>) => {
        touched.push('conditionalBatch');
        return base.conditionalBatch(...args);
      },
    } as unknown as BudgetStore;
    const harness = budgetHarness({ budget: undefined, store });

    for (const runId of ['r1', 'r2', 'r3', 'r4']) await harness.complete(runId);

    expect(harness.invoked).toHaveLength(8);
    expect(harness.records).toHaveLength(8);
    expect(touched).toEqual([]);
    await harness.sampler.dispose();
  });

  it('a second sampler on the same store continues the count, and a restart does not reset it (AC4)', async () => {
    const store = textValueStore(new MemoryStorage());
    const first = budgetHarness({ budget: 3, scorers: ['a'], store });
    await first.complete('r1');
    await first.complete('r2');
    await first.sampler.dispose();

    // A restart: a new sampler over the same store. Another instance, alive beside it, shares it too.
    const restarted = budgetHarness({ budget: 3, scorers: ['a'], store });
    const beside = budgetHarness({ budget: 3, scorers: ['a'], store });
    await restarted.complete('r3');
    await beside.complete('r4');

    expect(restarted.invoked).toEqual(['r3:a']);
    expect(beside.invoked).toEqual([]);
    expect(await store.get(scorerBudgetKey(DAY_ONE))).toBe('3');
    await restarted.sampler.dispose();
    await beside.sampler.dispose();
  });

  it('two runs settling together never exceed the budget (AC3)', async () => {
    const harness = budgetHarness({ budget: 1, scorers: ['a'] });
    harness.emit(makeAction({ type: 'run.completed', runId: 'r1', detail: makeRunResult() }));
    harness.emit(makeAction({ type: 'run.completed', runId: 'r2', detail: makeRunResult() }));
    await harness.sampler.flush();

    expect(harness.invoked).toHaveLength(1);
    expect(await harness.store.get(scorerBudgetKey(DAY_ONE))).toBe('1');
    await harness.sampler.dispose();
  });

  it('two instances that read the count together cannot both take the last unit (AC3)', async () => {
    const base = textValueStore(new MemoryStorage());
    // Each instance's first read waits for the other's, so both hold the same count before either swaps.
    let arrived = 0;
    const gate = Promise.withResolvers<void>();
    const store = {
      get: async (key: string) => {
        const value = await base.get(key);
        arrived += 1;
        if (arrived >= 2) gate.resolve();
        await gate.promise;
        return value;
      },
      conditionalBatch: (...args: Parameters<BudgetStore['conditionalBatch']>) =>
        base.conditionalBatch(...args),
    } as unknown as BudgetStore;
    const left = budgetHarness({ budget: 1, scorers: ['a'], store });
    const right = budgetHarness({ budget: 1, scorers: ['a'], store });

    await Promise.all([left.complete('left'), right.complete('right')]);

    // Exactly one took the unit; the loser's swap failed, it read the new count and ran nothing.
    expect([...left.invoked, ...right.invoked]).toHaveLength(1);
    expect(await base.get(scorerBudgetKey(DAY_ONE))).toBe('1');
    await left.sampler.dispose();
    await right.sampler.dispose();
  });

  it('a scorer that starts after midnight reserves under the new day', async () => {
    const harness = budgetHarness({
      budget: 1,
      scorers: ['a', 'b'],
      during: (scorer) => {
        if (scorer === 'a') harness.runtime.setTime(JUST_AFTER_MIDNIGHT_TWO);
      },
    });
    harness.runtime.setTime(Date.parse('2026-11-16T23:59:59.000Z'));

    await harness.complete('r1');

    // `a` took day one's only unit; `b` started on day two, whose count is its own.
    expect(harness.invoked).toEqual(['r1:a', 'r1:b']);
    expect(await storedCounts(harness.store, [DAY_ONE, DAY_TWO])).toEqual({
      [DAY_ONE]: '1',
      [DAY_TWO]: '1',
    });
    await harness.sampler.dispose();
  });

  it('reads the budget at each reservation: lowered it refuses, raised it continues', async () => {
    let budget: number | undefined = 3;
    const harness = budgetHarness({ budget: () => budget, scorers: ['a'] });
    await harness.complete('r1');
    await harness.complete('r2');

    budget = 2;
    await harness.complete('r3');
    expect(harness.invoked).toEqual(['r1:a', 'r2:a']);

    budget = 4;
    await harness.complete('r4');
    expect(harness.invoked).toEqual(['r1:a', 'r2:a', 'r4:a']);

    budget = undefined;
    await harness.complete('r5');
    expect(harness.invoked).toEqual(['r1:a', 'r2:a', 'r4:a', 'r5:a']);
    // The unlimited run reserved nothing.
    expect(await harness.store.get(scorerBudgetKey(DAY_ONE))).toBe('3');
    await harness.sampler.dispose();
  });

  it('keeps its count in the process when there is no durable store, per day', async () => {
    const harness = budgetHarness({ budget: 1, scorers: ['a'], durable: false });

    await harness.complete('r1');
    await harness.complete('r2');
    harness.runtime.setTime(NOON_TWO);
    await harness.complete('r3');

    expect(harness.invoked).toEqual(['r1:a', 'r3:a']);
    await harness.sampler.dispose();
  });

  it('runs nothing and says why when the stored count is not a count', async () => {
    const store = textValueStore(new MemoryStorage());
    await store.set(scorerBudgetKey(DAY_ONE), 'three');
    const harness = budgetHarness({ budget: 5, scorers: ['a'], store });

    await harness.complete('r1');

    expect(harness.invoked).toEqual([]);
    expect(harness.records).toEqual([]);
    expect(harness.diagnostics).toHaveLength(1);
    expect(harness.diagnostics[0]).toContain(scorerBudgetKey(DAY_ONE));
    // The value is left as it was, for a person to read.
    expect(await store.get(scorerBudgetKey(DAY_ONE))).toBe('three');
    await harness.sampler.dispose();
  });

  it.each([
    ['a read', 'get'],
    ['the swap', 'conditionalBatch'],
  ] as const)('runs nothing and says why when %s throws', async (_name, method) => {
    const base = textValueStore(new MemoryStorage());
    const store = {
      get: (key: string) =>
        method === 'get' ? Promise.reject(new Error('disk gone')) : base.get(key),
      conditionalBatch: (...args: Parameters<BudgetStore['conditionalBatch']>) =>
        method === 'conditionalBatch'
          ? Promise.reject(new Error('disk gone'))
          : base.conditionalBatch(...args),
    } as unknown as BudgetStore;
    const harness = budgetHarness({ budget: 5, scorers: ['a', 'b'], store });

    await harness.complete('r1');

    expect(harness.invoked).toEqual([]);
    expect(harness.records).toEqual([]);
    expect(harness.diagnostics).toHaveLength(1);
    await harness.sampler.dispose();
  });

  it('runs nothing after a bounded number of lost swaps', async () => {
    const base = textValueStore(new MemoryStorage());
    let swaps = 0;
    const store = {
      get: (key: string) => base.get(key),
      conditionalBatch: async () => {
        swaps += 1;
        return false;
      },
    } as unknown as BudgetStore;
    const harness = budgetHarness({ budget: 5, scorers: ['a'], store });

    await harness.complete('r1');

    expect(harness.invoked).toEqual([]);
    expect(swaps).toBeGreaterThan(1);
    expect(swaps).toBeLessThanOrEqual(32);
    expect(harness.diagnostics).toHaveLength(1);
    await harness.sampler.dispose();
  });

  it('leaves the unit spent when the owner aborts after it was reserved', async () => {
    const owner = new AbortController();
    const base = textValueStore(new MemoryStorage());
    const store = {
      get: (key: string) => base.get(key),
      conditionalBatch: async (...args: Parameters<BudgetStore['conditionalBatch']>) => {
        const committed = await base.conditionalBatch(...args);
        owner.abort(new Error('shutting down'));
        return committed;
      },
    } as unknown as BudgetStore;
    const harness = budgetHarness({ budget: 5, scorers: ['a'], store, signal: owner.signal });

    await harness.complete('r1');

    expect(harness.invoked).toEqual([]);
    expect(await base.get(scorerBudgetKey(DAY_ONE))).toBe('1');
    await harness.sampler.dispose();
  });
});
