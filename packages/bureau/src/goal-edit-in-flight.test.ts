/**
 * COR-2425 — what a goal edited while its attempt is in flight does next, over a real `createBureau`
 * and its durable controller:
 *
 * - under the `continue` conversation policy the retry opened after a prompt edit is turned with the
 *   edited prompt and then the feedback, and the retry after that is the feedback alone;
 * - a goal whose agent changed runs its next attempt as the new agent, in the session the first
 *   attempt created, and the goal's own ownership, fence and session checks accept every attempt
 *   under the agent it was opened with (a refusal would end the goal as `failed` with a detail).
 */
import { MemoryStorage } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import type { GoalState } from './goal-state';
import type { BureauGoalUpdateRequest } from './goal-types';
import {
  createCheckValidator,
  createLatch,
  goalRequest,
  pollUntil,
  scriptedGenerate,
  TERMINAL_STATUSES,
  workerAgent,
  type Latch,
} from './testing/goal-fixtures.test-support';
import type { Bureau } from './bureau-types/facade';

const open: Bureau[] = [];
afterEach(async () => {
  for (const bureau of open.splice(0)) await bureau.dispose();
});

async function boot(options: Parameters<typeof createBureau>[0]) {
  const bureau = await createBureau({ storage: new MemoryStorage(), durable: true, ...options });
  open.push(bureau);
  return bureau;
}

/** Answers like `scriptedGenerate`, but its first call waits on `latch`, which holds attempt 0 in flight. */
function heldFirstCall(latch: Latch, replies: readonly string[], seen: string[][]) {
  const inner = scriptedGenerate(replies, seen);
  let first = true;
  return async (input: Parameters<typeof inner>[0]) => {
    if (first) {
      first = false;
      await latch.promise;
    }
    return inner(input);
  };
}

async function inFlight(bureau: Bureau): Promise<void> {
  await pollUntil(async () => {
    const goal = await bureau.goals.get('g1');
    return goal?.status === 'running' && goal.active?.kind === 'attempt';
  });
}

/** Changes the goal against the revision it is at now, again when a controller write lands first. */
async function change(bureau: Bureau, request: Omit<BureauGoalUpdateRequest, 'expectedRevision'>) {
  for (;;) {
    const current = (await bureau.goals.get('g1'))!;
    const outcome = await bureau.goals.update('g1', {
      ...request,
      expectedRevision: current.revision,
    });
    if (outcome.outcome !== 'stale-revision') return outcome;
  }
}

async function ended(bureau: Bureau): Promise<GoalState> {
  let latest: GoalState | undefined;
  await pollUntil(async () => {
    latest = await bureau.goals.get('g1');
    return latest !== undefined && (TERMINAL_STATUSES as readonly string[]).includes(latest.status);
  });
  return latest!;
}

const WORK = 'user: work';
const NOPE = 'assistant: nope';
const SAY_DONE = 'user: say done';

describe('a prompt edited while an attempt is in flight, under the continue policy', () => {
  it('turns the next retry with the edited prompt and the feedback, and every retry after it with the feedback alone', async () => {
    const latch = createLatch();
    const seen: string[][] = [];
    const bureau = await boot({
      agents: { worker: workerAgent(heldFirstCall(latch, ['nope', 'nope', 'done'], seen)) },
      validators: [createCheckValidator()],
    });
    await bureau.goals.create(goalRequest({ conversationPolicy: { kind: 'continue' } }));
    await inFlight(bureau);

    expect(await change(bureau, { prompt: 'work harder' })).toMatchObject({ outcome: 'updated' });
    latch.release();
    const goal = await ended(bureau);

    expect(goal).toMatchObject({ status: 'succeeded', usage: { attempts: 3 } });
    expect(goal.failureDetail).toBeUndefined();
    expect(seen).toEqual([
      // Attempt 0 was in flight when the prompt changed, so it ran the one it started with.
      [WORK],
      // The first retry after the edit is the edited prompt, then what the check said.
      [WORK, NOPE, 'user: work harder\n\nsay done'],
      // The transcript now holds the edit, so the next retry is the feedback alone.
      [WORK, NOPE, 'user: work harder\n\nsay done', NOPE, SAY_DONE],
    ]);
    expect(goal.objective).toMatchObject({ prompt: 'work harder', promptRevisedAtAttempt: 1 });
  });

  it('leaves a goal whose prompt never changed with the feedback alone, as it was', async () => {
    const latch = createLatch();
    latch.release();
    const seen: string[][] = [];
    const bureau = await boot({
      agents: { worker: workerAgent(heldFirstCall(latch, ['nope', 'done'], seen)) },
      validators: [createCheckValidator()],
    });
    await bureau.goals.create(goalRequest({ conversationPolicy: { kind: 'continue' } }));

    const goal = await ended(bureau);

    expect(goal.status).toBe('succeeded');
    expect(goal.objective).not.toHaveProperty('promptRevisedAtAttempt');
    expect(seen).toEqual([[WORK], [WORK, NOPE, SAY_DONE]]);
  });
});

describe('a goal whose agent changed while an attempt was in flight', () => {
  it('runs its next attempt as the new agent in the session the first attempt created, and the goal still owns every attempt', async () => {
    const latch = createLatch();
    const workerSeen: string[][] = [];
    const helperSeen: string[][] = [];
    const bureau = await boot({
      agents: {
        worker: workerAgent(heldFirstCall(latch, ['nope'], workerSeen)),
        helper: workerAgent(scriptedGenerate(['done'], helperSeen), 'helper'),
      },
      validators: [createCheckValidator()],
    });
    await bureau.goals.create(goalRequest({ conversationPolicy: { kind: 'continue' } }));
    await inFlight(bureau);

    expect(await change(bureau, { agentName: 'helper' })).toMatchObject({ outcome: 'updated' });
    latch.release();
    const goal = await ended(bureau);

    // The attempt that was in flight ran as `worker` and passed its checks as the goal's own, and the
    // next attempt ran as `helper`: neither the fence, the ownership checks nor the session refused it.
    expect(goal).toMatchObject({ status: 'succeeded', usage: { attempts: 2 } });
    expect(goal.failureDetail).toBeUndefined();
    expect(goal.attempts.map((attempt) => attempt.agentName)).toEqual(['worker', 'helper']);
    expect(workerSeen).toEqual([[WORK]]);
    // The helper continued the conversation the worker began: it saw the worker's answer and the check's.
    expect(helperSeen).toEqual([[WORK, NOPE, SAY_DONE]]);
    const session = await bureau.internals.sessionStore?.load('goal-g1-s0');
    expect(session?.agentName).toBe('worker');
    expect(session?.runs.map((ref) => [ref.runId, ref.agentName])).toEqual([
      ['goal-g1-a0', 'worker'],
      ['goal-g1-a1', 'helper'],
    ]);
  });
});
