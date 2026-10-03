import { describe, expect, it } from 'bun:test';

import {
  createGoalEngine,
  createHarness,
  finishAttempt,
  GOAL_RUN_ID,
  GOAL_WORKFLOW_ID,
  type GoalHarness,
  pollUntil,
  startGoalWorkflow,
  statusesOf,
} from './goal-workflow-fixtures';
import { GOAL_CANCEL_SIGNAL, type GoalWorkflowResult } from './goal-workflow-ports';

/** Runs a goal to its result on one engine, driving the attempts with `drive`. */
async function runGoal(
  harness: GoalHarness,
  drive: (engine: Awaited<ReturnType<typeof createGoalEngine>>) => Promise<void>,
): Promise<GoalWorkflowResult> {
  const run = await createGoalEngine(harness);
  try {
    const handle = await startGoalWorkflow(run);
    await drive(run);
    return (await handle.result()) as GoalWorkflowResult;
  } finally {
    run.engine[Symbol.dispose]();
  }
}

const attemptRunning = (harness: GoalHarness, index: number) => () =>
  harness.world.record().attempts[index]?.status === 'running';

describe('createGoalWorkflow', () => {
  describe('a passing goal', () => {
    it('commits one transition per decision point, in the documented slot order', async () => {
      const harness = createHarness();
      const result = await runGoal(harness, async (run) => {
        await pollUntil(attemptRunning(harness, 0));
        await finishAttempt(run, 0);
      });

      expect(result).toEqual({
        schemaVersion: 1,
        outcome: 'terminal',
        goalRunId: GOAL_RUN_ID,
        status: 'succeeded',
        terminalReason: 'validator-passed',
        transitionSeq: 3,
      });
      expect(statusesOf(harness.world)).toEqual(['running', 'evaluating', 'succeeded']);
      // The header's slot sequence: L S C | R L2 C | V L2 C | L(terminal).
      expect(harness.world.calls).toEqual([
        'load',
        'start:0',
        'commit:running:applied',
        'load',
        'load',
        'commit:evaluating:applied',
        'load',
        'validate:0',
        'load',
        'commit:succeeded:applied',
        'load',
      ]);
      const record = harness.world.record();
      expect(record.attempts[0]).toMatchObject({
        attemptId: `${GOAL_RUN_ID}:a0`,
        runId: `goal-${GOAL_RUN_ID}-a0`,
        status: 'passed',
        finishReason: 'stop-condition',
        usage: { steps: 2, tokens: 100 },
        validation: { decisionId: `${GOAL_RUN_ID}:a0:decision`, outcome: { kind: 'pass' } },
      });
      expect(record.usage).toMatchObject({ attempts: 1, steps: 2, tokens: 100 });
      expect(record.active).toBeUndefined();
    });

    it('is addressable by its workflow id and starts the attempt exactly once', async () => {
      const harness = createHarness();
      await runGoal(harness, async (run) => {
        await pollUntil(attemptRunning(harness, 0));
        await finishAttempt(run, 0);
      });
      expect(harness.world.startedRuns).toEqual([`goal-${GOAL_RUN_ID}-a0`]);
      expect(GOAL_WORKFLOW_ID).toBe(`goal:${GOAL_RUN_ID}`);
    });
  });

  describe('retry', () => {
    it('feeds a retryable failure back into the next attempt and then passes', async () => {
      const harness = createHarness({
        bounds: { maximumAttempts: 3, maximumTotalDurationMs: 3_600_000 },
        retryOn: ['validator-fail-retryable'],
      });
      harness.world.validatorOutcomes.push(
        { kind: 'fail', feedback: 'the tests still fail', evidence: [], retryable: true },
        { kind: 'pass', evidence: [] },
      );
      const result = await runGoal(harness, async (run) => {
        await pollUntil(attemptRunning(harness, 0));
        await finishAttempt(run, 0);
        await pollUntil(attemptRunning(harness, 1));
        await finishAttempt(run, 1);
      });

      expect(result).toMatchObject({ status: 'succeeded', terminalReason: 'validator-passed' });
      expect(statusesOf(harness.world)).toEqual([
        'running',
        'evaluating',
        'retrying',
        'running',
        'evaluating',
        'succeeded',
      ]);
      expect(harness.world.startFeedback.get(0)).toBeUndefined();
      expect(harness.world.startFeedback.get(1)).toBe('the tests still fail');
      const record = harness.world.record();
      expect(record.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'passed']);
      expect(record.attempts[0]?.feedback).toBe('the tests still fail');
      expect(record.usage).toMatchObject({ attempts: 2, steps: 4, tokens: 200 });
    });

    it('carries the earlier feedback forward when a later attempt ends unavailable', async () => {
      const harness = createHarness({
        bounds: { maximumAttempts: 4, maximumTotalDurationMs: 3_600_000 },
        retryOn: ['validator-fail-retryable', 'validator-unavailable'],
      });
      harness.world.validatorOutcomes.push(
        { kind: 'fail', feedback: 'first feedback', evidence: [], retryable: true },
        {
          kind: 'unavailable',
          error: { kind: 'execute', code: 'DOWN', message: 'validator is down' },
          reason: 'down',
        },
        { kind: 'pass', evidence: [] },
      );
      await runGoal(harness, async (run) => {
        for (const index of [0, 1, 2]) {
          await pollUntil(attemptRunning(harness, index));
          await finishAttempt(run, index);
        }
      });
      expect(harness.world.startFeedback.get(1)).toBe('first feedback');
      // The unavailable attempt produced no verdict, so attempt 2 resumes from the input attempt 1 had.
      expect(harness.world.startFeedback.get(2)).toBe('first feedback');
    });
  });

  describe('exhaustion and failure', () => {
    it('exhausts as attempt-limit-reached when the last allowed attempt fails retryably', async () => {
      const harness = createHarness({
        bounds: { maximumAttempts: 1, maximumTotalDurationMs: 3_600_000 },
        retryOn: ['validator-fail-retryable'],
      });
      harness.world.validatorOutcomes.push({
        kind: 'fail',
        feedback: 'nope',
        evidence: [],
        retryable: true,
      });
      const result = await runGoal(harness, async (run) => {
        await pollUntil(attemptRunning(harness, 0));
        await finishAttempt(run, 0);
      });
      expect(result).toMatchObject({
        status: 'exhausted',
        terminalReason: 'attempt-limit-reached',
      });
      expect(statusesOf(harness.world)).toEqual(['running', 'evaluating', 'exhausted']);
    });

    it('exhausts as aggregate-budget-exceeded, ahead of the attempt limit, when tokens cross the bound', async () => {
      const harness = createHarness({
        bounds: { maximumAttempts: 1, maximumTotalTokens: 50 },
        retryOn: ['validator-fail-retryable'],
      });
      harness.world.validatorOutcomes.push({
        kind: 'fail',
        feedback: 'nope',
        evidence: [],
        retryable: true,
      });
      const result = await runGoal(harness, async (run) => {
        await pollUntil(attemptRunning(harness, 0));
        await finishAttempt(run, 0, { tokens: 100 });
      });
      expect(result).toMatchObject({
        status: 'exhausted',
        terminalReason: 'aggregate-budget-exceeded',
      });
    });

    it('fails without retrying when the validator fails non-retryably', async () => {
      const harness = createHarness({ retryOn: ['validator-fail-retryable'] });
      harness.world.validatorOutcomes.push({
        kind: 'fail',
        feedback: 'wrong',
        evidence: [],
        retryable: false,
      });
      const result = await runGoal(harness, async (run) => {
        await pollUntil(attemptRunning(harness, 0));
        await finishAttempt(run, 0);
      });
      expect(result).toMatchObject({
        status: 'failed',
        terminalReason: 'validator-fail-non-retryable',
      });
    });

    it('fails as validator-infrastructure-error on a validator error outcome', async () => {
      const harness = createHarness();
      harness.world.validatorOutcomes.push({
        kind: 'error',
        error: { kind: 'execute', code: 'THREW', message: 'boom' },
      });
      const result = await runGoal(harness, async (run) => {
        await pollUntil(attemptRunning(harness, 0));
        await finishAttempt(run, 0);
      });
      expect(result).toMatchObject({
        status: 'failed',
        terminalReason: 'validator-infrastructure-error',
      });
      expect(harness.world.record().attempts[0]?.validation?.outcome).toMatchObject({
        kind: 'error',
      });
    });

    it('skips the validator and fails as attempt-run-failed when the run did not reach a stop condition', async () => {
      const harness = createHarness();
      const result = await runGoal(harness, async (run) => {
        await pollUntil(attemptRunning(harness, 0));
        await finishAttempt(run, 0, { finishReason: 'error' });
      });
      expect(result).toMatchObject({
        status: 'failed',
        terminalReason: 'attempt-run-failed',
        failureDetail: 'The inner run finished with error.',
      });
      expect(harness.world.calls.some((call) => call.startsWith('validate'))).toBe(false);
      expect(harness.world.record().attempts[0]).toMatchObject({
        status: 'failed',
        finishReason: 'error',
      });
    });

    it('fails as attempt-run-failed when maximumTotalCostUsd is set and the attempt reported no cost', async () => {
      const harness = createHarness({ bounds: { maximumAttempts: 2, maximumTotalCostUsd: 5 } });
      const result = await runGoal(harness, async (run) => {
        await pollUntil(attemptRunning(harness, 0));
        await finishAttempt(run, 0);
      });
      expect(result).toMatchObject({ status: 'failed', terminalReason: 'attempt-run-failed' });
    });

    it('fails as attempt-run-failed, with no attempt recorded, when the run cannot be started', async () => {
      const harness = createHarness();
      harness.world.failNextStart('Starting the inner run failed: no capacity');
      const result = await runGoal(harness, () => Promise.resolve());
      expect(result).toMatchObject({
        status: 'failed',
        terminalReason: 'attempt-run-failed',
        failureDetail: 'Starting the inner run failed: no capacity',
      });
      expect(statusesOf(harness.world)).toEqual(['failed']);
      expect(harness.world.record().attempts).toEqual([]);
    });
  });

  describe('cancellation', () => {
    it('stops the attempt and ends canceled when the marker and the cancel signal arrive', async () => {
      const harness = createHarness();
      const result = await runGoal(harness, async (run) => {
        await pollUntil(attemptRunning(harness, 0));
        harness.world.requestCancellation();
        await run.engine.signal(GOAL_WORKFLOW_ID, GOAL_CANCEL_SIGNAL, null);
      });
      expect(result).toMatchObject({ status: 'canceled', terminalReason: 'goal-canceled' });
      expect(statusesOf(harness.world)).toEqual(['running', 'canceled']);
      expect(harness.world.abortedRuns).toEqual([`goal-${GOAL_RUN_ID}-a0`]);
      expect(harness.world.record().attempts[0]).toMatchObject({ status: 'aborted' });
      // The cancel path: L, A, C, then the terminal L.
      expect(harness.world.calls.slice(-4)).toEqual([
        'load',
        'abort:0',
        'commit:canceled:applied',
        'load',
      ]);
    });

    it('treats the marker as authoritative when the cancel signal never arrives', async () => {
      const harness = createHarness();
      const result = await runGoal(harness, async (run) => {
        await pollUntil(attemptRunning(harness, 0));
        harness.world.requestCancellation();
        // Only the attempt's own terminal signal wakes the controller.
        await finishAttempt(run, 0, { finishReason: 'aborted' });
      });
      expect(result).toMatchObject({ status: 'canceled', terminalReason: 'goal-canceled' });
      expect(statusesOf(harness.world)).toEqual(['running', 'canceled']);
    });

    it('ignores a cancel signal that has no marker behind it', async () => {
      const harness = createHarness();
      const result = await runGoal(harness, async (run) => {
        await pollUntil(attemptRunning(harness, 0));
        await run.engine.signal(GOAL_WORKFLOW_ID, GOAL_CANCEL_SIGNAL, null);
        await pollUntil(() => harness.world.calls.filter((call) => call === 'load').length >= 3);
        await finishAttempt(run, 0);
      });
      expect(result).toMatchObject({ status: 'succeeded' });
    });

    it('adopts the marker when it lands between the post-wake read and the commit', async () => {
      const harness = createHarness();
      harness.world.beforeNextCommit('evaluating', () => harness.world.requestCancellation());
      const result = await runGoal(harness, async (run) => {
        await pollUntil(attemptRunning(harness, 0));
        await finishAttempt(run, 0);
      });
      expect(result).toMatchObject({ status: 'canceled', terminalReason: 'goal-canceled' });
      expect(harness.world.calls).toContain('commit:evaluating:cancellation-requested');
      expect(statusesOf(harness.world)).toEqual(['running', 'canceled']);
      expect(harness.world.calls.some((call) => call.startsWith('validate'))).toBe(false);
    });

    it('cancels a goal that has not started an attempt yet', async () => {
      const harness = createHarness();
      harness.world.requestCancellation();
      const result = await runGoal(harness, () => Promise.resolve());
      expect(result).toMatchObject({ status: 'canceled' });
      expect(harness.world.startedRuns).toEqual([]);
      expect(statusesOf(harness.world)).toEqual(['canceled']);
    });
  });

  describe('the aggregate duration bound', () => {
    it('exhausts as aggregate-budget-exceeded when the deadline branch wins the race', async () => {
      const harness = createHarness({
        bounds: { maximumAttempts: 2, maximumTotalDurationMs: 25 },
      });
      const result = await runGoal(harness, async () => {
        await pollUntil(attemptRunning(harness, 0));
        // The race's sleep branch compares the engine clock, so moving the manual
        // clock past the bound is what lets its timer resolve.
        harness.clock.advance(1_000);
      });
      expect(result).toMatchObject({
        status: 'exhausted',
        terminalReason: 'aggregate-budget-exceeded',
      });
      expect(harness.world.abortedRuns).toEqual([`goal-${GOAL_RUN_ID}-a0`]);
      expect(harness.world.record().attempts[0]).toMatchObject({ status: 'aborted' });
      expect(harness.world.record().usage.durationMs).toBeGreaterThanOrEqual(25);
    });

    it('exhausts, applying no verdict, when the bound elapsed while the validator ran', async () => {
      // eslint-disable-next-line prefer-const -- the hook closes over the harness it is passed to.
      let harness: GoalHarness;
      harness = createHarness({
        bounds: { maximumAttempts: 2, maximumTotalDurationMs: 25 },
        onValidate: () => {
          harness.clock.advance(1_000);
        },
      });
      const result = await runGoal(harness, async (run) => {
        await pollUntil(attemptRunning(harness, 0));
        await finishAttempt(run, 0);
      });
      expect(result).toMatchObject({
        status: 'exhausted',
        terminalReason: 'aggregate-budget-exceeded',
      });
      expect(statusesOf(harness.world)).toEqual(['running', 'evaluating', 'exhausted']);
      expect(harness.world.record().attempts[0]?.validation).toBeUndefined();
    });

    it('exhausts at the deadline while the validator never returns', async () => {
      const harness = createHarness({
        bounds: { maximumAttempts: 2, maximumTotalDurationMs: 25 },
      });
      const hung = harness.world.crashAfter('validate');
      const result = await runGoal(harness, async (run) => {
        await pollUntil(attemptRunning(harness, 0));
        await finishAttempt(run, 0);
        await hung.reached;
        harness.clock.advance(1_000);
      });
      expect(result).toMatchObject({
        status: 'exhausted',
        terminalReason: 'aggregate-budget-exceeded',
      });
      expect(statusesOf(harness.world)).toEqual(['running', 'evaluating', 'exhausted']);
      expect(harness.world.abortedRuns).toEqual([`goal-${GOAL_RUN_ID}-a0`]);
      expect(harness.world.record().attempts[0]?.validation).toBeUndefined();
    });

    it.each([
      { configured: 10_000_000, bound: 3_600_000, expected: 3_600_000 },
      { configured: 5_000, bound: 3_600_000, expected: 5_000 },
      { configured: undefined, bound: 3_600_000, expected: 3_600_000 },
    ])(
      'tells the validator not to outlast the deadline (configured $configured)',
      async ({ configured, bound, expected }) => {
        const harness = createHarness({
          bounds: { maximumAttempts: 2, maximumTotalDurationMs: bound },
          validatorTimeoutMs: configured,
        });
        await runGoal(harness, async (run) => {
          await pollUntil(attemptRunning(harness, 0));
          await finishAttempt(run, 0);
        });
        expect(harness.world.validatorTimeouts).toEqual([expected]);
      },
    );

    it('exhausts at the deadline while an attempt start never returns', async () => {
      const harness = createHarness({
        bounds: { maximumAttempts: 2, maximumTotalDurationMs: 25 },
      });
      const hung = harness.world.crashAfter('start:started');
      const result = await runGoal(harness, async () => {
        await hung.reached;
        harness.clock.advance(1_000);
      });
      expect(result).toMatchObject({
        status: 'exhausted',
        terminalReason: 'aggregate-budget-exceeded',
      });
      // The run a start left behind is stopped by its deterministic id.
      expect(harness.world.abortedRuns).toEqual([`goal-${GOAL_RUN_ID}-a0`]);
      expect(statusesOf(harness.world)).toEqual(['exhausted']);
    });

    it('exhausts before starting an attempt when the bound already elapsed', async () => {
      const harness = createHarness({
        bounds: { maximumAttempts: 2, maximumTotalDurationMs: 25 },
      });
      harness.clock.advance(1_000);
      const result = await runGoal(harness, () => Promise.resolve());
      expect(result).toMatchObject({
        status: 'exhausted',
        terminalReason: 'aggregate-budget-exceeded',
      });
      expect(harness.world.startedRuns).toEqual([]);
    });
  });

  describe('the record', () => {
    it('returns record-unavailable when the record is missing', async () => {
      const harness = createHarness();
      harness.world.makeRecordMissing();
      const result = await runGoal(harness, () => Promise.resolve());
      expect(result).toEqual({
        schemaVersion: 1,
        outcome: 'record-unavailable',
        goalRunId: GOAL_RUN_ID,
      });
    });

    it('returns the result of an already-terminal record without committing anything', async () => {
      const harness = createHarness();
      harness.world.patchRecord({
        status: 'failed',
        terminalReason: 'validator-fail-non-retryable',
        transitionSeq: 4,
      });
      const result = await runGoal(harness, () => Promise.resolve());
      expect(result).toMatchObject({
        status: 'failed',
        terminalReason: 'validator-fail-non-retryable',
        transitionSeq: 4,
      });
      expect(harness.world.transitions).toEqual([]);
      expect(harness.world.calls).toEqual(['load']);
    });
  });
});
