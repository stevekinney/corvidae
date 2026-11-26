/**
 * COR-851 — a session is the goal's only when every run in it is one of the
 * goal's own attempts, by the exact id the goal derives for that attempt.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { createAgentSession } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist/testing';

import { foreignSessionReason, goalSessionMetadata } from './goal-conversation';
import { createGoalState, goalAttemptRunId } from './goal-state';

const runtime = createDefaultRuntimeServices();
const MAXIMUM_ATTEMPTS = 3;

const record = createGoalState({
  goalRunId: 'g1',
  identity: { name: 'goal', version: '1' },
  objective: { agentName: 'worker', prompt: 'work' },
  validator: { name: 'check', version: '1' },
  conversationPolicy: { kind: 'continue' },
  bounds: { maximumAttempts: MAXIMUM_ATTEMPTS, maximumTotalSteps: 10 },
  now: '2026-10-02T12:00:00.000Z',
});

const sessionWithRuns = (runIds: readonly string[], agentName = 'worker') =>
  createAgentSession({
    agentName,
    conversationHistory: createConversationHistory(undefined, { runtime }),
    id: 'goal-g1-s0',
    metadata: goalSessionMetadata(record),
    runs: runIds.map((runId, sequence) => ({
      runId,
      sequence,
      status: 'completed' as const,
      startedAt: record.createdAt,
      agentName: 'worker',
    })),
    runtime,
  });

describe('goalSessionMetadata origin', () => {
  it('records that a goal started the session, so a chat list leaves it out (COR-1645)', () => {
    expect(goalSessionMetadata(record)['sessionOrigin']).toBe('goal');
  });
});

describe('foreignSessionReason and the runs a session holds', () => {
  it("refuses a session that belongs to a different agent than the goal's", () => {
    const reason = foreignSessionReason(record, sessionWithRuns([], 'other-agent'));
    expect(reason).toContain('belongs to a different agent');
  });

  it("refuses a session holding a run that was started by a different agent than the goal's", () => {
    const session = sessionWithRuns([goalAttemptRunId('g1', 0)]);
    const foreign = {
      ...session,
      runs: session.runs.map((ref) => ({ ...ref, agentName: 'other-agent' })),
    };
    expect(foreignSessionReason(record, foreign)).toContain('different agent');
  });

  it("accepts a session holding exactly the goal's own attempt run ids", () => {
    const session = sessionWithRuns([goalAttemptRunId('g1', 0), goalAttemptRunId('g1', 2)]);
    expect(foreignSessionReason(record, session)).toBeUndefined();
  });

  describe('after the goal’s agent changed (COR-2425)', () => {
    /** Attempt 0 ran as `worker`, then the goal moved to `helper` and attempt 1 ran as `helper`. */
    const attempt = (index: number, agentName: string) => ({
      attemptId: `g1-a${index}`,
      attemptIndex: index,
      runId: goalAttemptRunId('g1', index),
      sessionId: 'goal-g1-s0',
      agentName,
      startedAt: record.createdAt,
      usage: { steps: 0, tokens: 0 },
      status: 'failed' as const,
    });
    const changed = {
      ...record,
      objective: { ...record.objective, agentName: 'helper' },
      attempts: [attempt(0, 'worker'), attempt(1, 'helper')],
    };
    const ref = (index: number, agentName: string) => ({
      runId: goalAttemptRunId('g1', index),
      sequence: index,
      status: 'completed' as const,
      startedAt: record.createdAt,
      agentName,
    });
    const trunk = (runs: ReturnType<typeof ref>[], agentName = 'worker') => ({
      ...sessionWithRuns([], agentName),
      runs,
    });

    it('still owns the trunk the first attempt created, with each run under the agent it ran as', () => {
      expect(
        foreignSessionReason(changed, trunk([ref(0, 'worker'), ref(1, 'helper')])),
      ).toBeUndefined();
    });

    it('refuses a run recorded under another attempt’s agent, and a trunk of an agent no attempt ran as', () => {
      // Attempt 1 ran as `helper`: a ref that says `worker` is not its run.
      expect(foreignSessionReason(changed, trunk([ref(0, 'worker'), ref(1, 'worker')]))).toContain(
        'different agent',
      );
      // Attempt 0 ran as `worker`, so the goal's current agent does not own its run or its session.
      expect(foreignSessionReason(changed, trunk([ref(0, 'helper')]))).toContain('different agent');
      expect(foreignSessionReason(changed, trunk([], 'helper'))).toContain('different agent');
      expect(foreignSessionReason(changed, trunk([], 'intruder'))).toContain('different agent');
    });

    it('reads a record written before attempts carried an agent as the goal’s one agent', () => {
      const legacy = { ...record, attempts: [{ ...attempt(0, 'worker'), agentName: undefined }] };
      expect(foreignSessionReason(legacy, trunk([ref(0, 'worker')]))).toBeUndefined();
      expect(foreignSessionReason(legacy, trunk([ref(0, 'helper')]))).toContain('different agent');
    });
  });

  it.each([
    ['a zero-padded index', 'goal-g1-a00'],
    ['an index at the attempt limit', `goal-g1-a${MAXIMUM_ATTEMPTS}`],
    ['an index far past the attempt limit', 'goal-g1-a9999'],
    ['an index with a sign', 'goal-g1-a+1'],
    ['another goal whose id extends this one', 'goal-g1-a0-a0'],
  ])('refuses a session holding %s', (_label, runId) => {
    const reason = foreignSessionReason(record, sessionWithRuns([runId]));
    expect(reason).toContain("not one of this goal's attempts");
  });
});
