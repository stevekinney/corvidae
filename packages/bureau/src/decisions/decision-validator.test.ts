/**
 * COR-1709 — `decisionValidator`: a goal whose validator asks a decision. A scripted `true` passes
 * the goal and a scripted `false` retries it, and the validator says it is stochastic.
 */
import { createMockGenerate } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from '../agent-catalog.ts';
import { createBureau } from '../create-bureau.ts';
import {
  answering,
  GOAL_BOUNDS,
  goalRequest,
  pollUntil,
  TERMINAL_STATUSES,
  workerAgent,
} from '../testing/goal-fixtures.test-support.ts';
import type { Bureau } from '../types.ts';
import { decisionValidator } from './decision-validator.ts';
import { MemoryStorage } from '@lostgradient/storage';

const bureaus: Bureau[] = [];
afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

const JUDGE = { name: 'judge', version: '1' } as const;

function judge() {
  const asked: string[] = [];
  const validator = decisionValidator({
    ...JUDGE,
    request: (input) => ({
      kind: 'boolean',
      question: 'Is the answer acceptable?',
      context: input.result.content,
    }),
    verdict: (decision) => {
      asked.push(`${decision.provider}/${decision.model}`);
      return decision.value === true
        ? { kind: 'pass', evidence: [{ source: 'judge', detail: { model: decision.model } }] }
        : { kind: 'fail', feedback: 'try again', evidence: [], retryable: true };
    },
  });
  return { validator, asked };
}

async function openGoalBureau(replies: readonly string[], validator = judge().validator) {
  const generate = createMockGenerate(replies.map((content) => ({ content, toolCalls: [] })));
  const bureau = await createBureau<AgentDefinitions>({
    storage: new MemoryStorage(),
    durable: true,
    agents: { worker: workerAgent(answering('an answer')) },
    models: { generate: () => generate },
    validators: [validator],
  });
  bureaus.push(bureau);
  return { bureau, generate };
}

async function ended(bureau: Bureau) {
  await pollUntil(async () => {
    const goal = await bureau.goals.get('g1');
    return (TERMINAL_STATUSES as readonly string[]).includes(goal?.status ?? '');
  });
  return (await bureau.goals.get('g1'))!;
}

describe('decisionValidator', () => {
  it('reports itself stochastic under its registered name and version', () => {
    expect(judge().validator).toMatchObject({ identity: JUDGE, determinism: 'stochastic' });
  });

  it('passes the goal on a scripted true', async () => {
    const { bureau, generate } = await openGoalBureau(['{"answer":true}']);

    await bureau.goals.create(goalRequest({ validator: JUDGE }));
    const goal = await ended(bureau);

    expect(goal.status).toBe('succeeded');
    expect(goal.usage.attempts).toBe(1);
    expect(generate.callCount).toBe(1);
  });

  it('retries the goal on a scripted false and passes on the next true', async () => {
    const { bureau, generate } = await openGoalBureau(['{"answer":false}', '{"answer":true}']);

    await bureau.goals.create(goalRequest({ validator: JUDGE, bounds: GOAL_BOUNDS }));
    const goal = await ended(bureau);

    expect(goal.status).toBe('succeeded');
    expect(goal.usage.attempts).toBe(2);
    expect(generate.callCount).toBe(2);
  });

  it('is refused by a goal that requires deterministic validation', async () => {
    const { bureau, generate } = await openGoalBureau(['{"answer":true}']);

    await bureau.goals.create(
      goalRequest({ validator: JUDGE, requireDeterministicValidation: true }),
    );
    const goal = await ended(bureau);

    expect(goal.status).toBe('failed');
    expect(generate.callCount).toBe(0);
  });

  it('is indeterminate when it is not registered with a Bureau', async () => {
    const outcome = await judge().validator.validate({} as never, new AbortController().signal);

    expect(outcome.kind).toBe('indeterminate');
  });
});
