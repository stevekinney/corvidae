/**
 * COR-2117 — a validator with a configuration: a goal names the configuration with the validator,
 * the schema decides what is accepted, the parsed copy is stored in the goal's record, and the
 * validator reads that copy, also after a restart. An update changes it, and each verdict records
 * the configuration that judged it.
 */
import type { GenerateFunction, Validator, ValidatorInput } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { Bureau } from './bureau-types/facade';
import { createBureau } from './create-bureau';
import type { GoalState } from './goal-state';
import type { BureauGoalUpdateRequest } from './goal-types';
import {
  CHECK,
  createCheckValidator,
  createLatch,
  createTestDatabase,
  createUnsetTestDatabase,
  goalRequest,
  pollUntil,
  TERMINAL_STATUSES,
  type TestDatabase,
  workerAgent,
} from './testing/goal-fixtures.test-support';
import { bootOver } from './testing/goal-recovery-fixtures.test-support';

const PHRASE = z.strictObject({ phrase: z.string().min(1) });
const CONTAINS_PHRASE = { name: 'contains-phrase', version: '1' } as const;

/** Passes when the answer holds the configured phrase; the phrase is what the goal's record stores. */
function containsPhrase(calls: ValidatorInput[] = []): Validator {
  return {
    identity: CONTAINS_PHRASE,
    determinism: 'deterministic',
    configuration: PHRASE,
    validate(input) {
      calls.push(input);
      const { phrase } = PHRASE.parse(input.configuration);
      return input.result.content.includes(phrase)
        ? { kind: 'pass', evidence: [{ source: 'contains-phrase', detail: { phrase } }] }
        : { kind: 'fail', feedback: `say "${phrase}"`, evidence: [], retryable: true };
    },
  };
}

const open: Bureau[] = [];
let database: TestDatabase = createUnsetTestDatabase();
afterEach(async () => {
  for (const bureau of open.splice(0)) await bureau.dispose();
  await database.remove();
});

async function boot(options: Parameters<typeof createBureau>[0]) {
  const bureau = await createBureau({ storage: new MemoryStorage(), durable: true, ...options });
  open.push(bureau);
  return bureau;
}

const answerWith =
  (content: string): GenerateFunction =>
  () =>
    Promise.resolve({ content, toolCalls: [] });

async function ended(bureau: Bureau, goalRunId = 'g1'): Promise<GoalState> {
  let latest: GoalState | undefined;
  await pollUntil(async () => {
    latest = await bureau.goals.get(goalRunId);
    return latest !== undefined && (TERMINAL_STATUSES as readonly string[]).includes(latest.status);
  });
  return latest!;
}

async function updateNow(
  bureau: Bureau,
  goalRunId: string,
  change: Omit<BureauGoalUpdateRequest, 'expectedRevision'>,
) {
  for (;;) {
    const current = (await bureau.goals.get(goalRunId))!;
    const outcome = await bureau.goals.update(goalRunId, {
      ...change,
      expectedRevision: current.revision,
    });
    if (outcome.outcome !== 'stale-revision') return outcome;
  }
}

const NO_RETRY = { retryPolicy: undefined } as const;

describe('a goal that configures its validator', () => {
  it('passes an answer containing the configured phrase and fails one without it', async () => {
    const hit = await boot({
      agents: { worker: workerAgent(answerWith('the staging fix landed')) },
      validators: [containsPhrase()],
    });
    const created = await hit.goals.create(
      goalRequest({ validator: { ...CONTAINS_PHRASE, configuration: { phrase: 'staging fix' } } }),
    );
    expect(created.outcome).toBe('created');
    expect(await ended(hit)).toMatchObject({ status: 'succeeded' });

    const miss = await boot({
      agents: { worker: workerAgent(answerWith('nothing relevant')) },
      validators: [containsPhrase()],
    });
    expect(
      await miss.goals.create(
        goalRequest({
          ...NO_RETRY,
          validator: { ...CONTAINS_PHRASE, configuration: { phrase: 'staging fix' } },
        }),
      ),
    ).toMatchObject({ outcome: 'created' });
    expect(await ended(miss)).toMatchObject({ status: 'failed' });
  });

  it('copies the parsed configuration into the goal record, and passes the copy to the validator', async () => {
    const calls: ValidatorInput[] = [];
    const bureau = await boot({
      agents: { worker: workerAgent(answerWith('the staging fix landed')) },
      validators: [containsPhrase(calls)],
    });
    await bureau.goals.create(
      goalRequest({ validator: { ...CONTAINS_PHRASE, configuration: { phrase: 'staging fix' } } }),
    );
    const goal = await ended(bureau);

    expect(goal.validator).toEqual(CONTAINS_PHRASE);
    expect(goal.validatorConfiguration).toEqual({ phrase: 'staging fix' });
    expect(calls.map((call) => call.configuration)).toEqual([{ phrase: 'staging fix' }]);
    expect(goal.attempts[0]?.validation?.judgedBy?.configuration).toEqual({
      phrase: 'staging fix',
    });
  });

  it('refuses a configuration its schema refuses, naming the field, and writes no goal', async () => {
    const bureau = await boot({
      agents: { worker: workerAgent(answerWith('x')) },
      validators: [containsPhrase()],
    });

    const outcome = await bureau.goals.create(
      goalRequest({ validator: { ...CONTAINS_PHRASE, configuration: { phrase: '' } } }),
    );

    expect(outcome).toMatchObject({
      outcome: 'rejected',
      code: 'invalid-configuration',
      issues: [{ path: ['phrase'] }],
    });
    expect(await bureau.goals.get('g1')).toBeUndefined();
  });

  it('lets the schema decide whether an omitted configuration is allowed', async () => {
    const bureau = await boot({
      agents: { worker: workerAgent(answerWith('x')) },
      validators: [containsPhrase()],
    });

    expect(await bureau.goals.create(goalRequest({ validator: CONTAINS_PHRASE }))).toMatchObject({
      outcome: 'rejected',
      code: 'invalid-configuration',
      issues: [{ path: [] }],
    });
  });

  it('refuses a configuration for a validator that has no schema', async () => {
    const bureau = await boot({
      agents: { worker: workerAgent(answerWith('x')) },
      validators: [createCheckValidator()],
    });

    expect(
      await bureau.goals.create(
        goalRequest({ validator: { ...CHECK, configuration: { phrase: 'x' } } }),
      ),
    ).toMatchObject({
      outcome: 'rejected',
      code: 'invalid-configuration',
      issues: [{ path: [] }],
    });
    expect(await bureau.goals.get('g1')).toBeUndefined();
  });

  it('answers a repeat of the request as the same goal, and one with another configuration as a conflict', async () => {
    const bureau = await boot({
      agents: { worker: workerAgent(answerWith('the staging fix landed')) },
      validators: [containsPhrase()],
    });
    const request = goalRequest({
      validator: { ...CONTAINS_PHRASE, configuration: { phrase: 'staging fix' } },
    });
    await bureau.goals.create(request);
    await ended(bureau);

    expect(await bureau.goals.create(request)).toMatchObject({ outcome: 'existing' });
    expect(
      await bureau.goals.create(
        goalRequest({ validator: { ...CONTAINS_PHRASE, configuration: { phrase: 'other' } } }),
      ),
    ).toMatchObject({ outcome: 'conflict' });
  });

  it('reads the stored configuration after a restart, not whatever the bureau holds now', async () => {
    database = createTestDatabase('configuration-resume');
    const stuck = createLatch();
    const dead = await bootOver({
      storage: database.open(),
      agents: { worker: workerAgent(answerWith('the staging fix landed')) },
      validators: [
        { ...containsPhrase(), validate: () => stuck.promise.then(() => ({ kind: 'canceled' })) },
      ],
    });
    open.push(dead.bureau);
    await dead.bureau.goals.create(
      goalRequest({ validator: { ...CONTAINS_PHRASE, configuration: { phrase: 'staging fix' } } }),
    );
    await pollUntil(async () => {
      const goal = await dead.bureau.goals.get('g1');
      return goal?.status === 'evaluating';
    });

    const calls: ValidatorInput[] = [];
    const { bureau } = await bootOver({
      storage: database.open(),
      agents: { worker: workerAgent(answerWith('the staging fix landed')) },
      validators: [containsPhrase(calls)],
    });
    open.push(bureau);

    const goal = await ended(bureau);
    expect(goal).toMatchObject({ status: 'succeeded' });
    expect(calls.map((call) => call.configuration)).toEqual([{ phrase: 'staging fix' }]);
    stuck.release();
  });
});

// A goal stored without a configuration is decoded and run from a record `main` wrote, in
// `stored-formats.test.ts`, not from one this build writes.

describe('bureau.goals.update and the configuration', () => {
  it('changes the configuration of the validator the goal already names, parsed by its schema', async () => {
    const gate = createLatch();
    const bureau = await boot({
      agents: {
        worker: workerAgent(async () => {
          await gate.promise;
          return { content: 'the staging fix landed', toolCalls: [] };
        }),
      },
      validators: [containsPhrase()],
    });
    await bureau.goals.create(
      goalRequest({ validator: { ...CONTAINS_PHRASE, configuration: { phrase: 'never said' } } }),
    );

    expect(
      await updateNow(bureau, 'g1', {
        validator: { ...CONTAINS_PHRASE, configuration: { phrase: '' } },
      }),
    ).toMatchObject({
      outcome: 'rejected',
      code: 'invalid-configuration',
      issues: [{ path: ['phrase'] }],
    });
    expect(
      await updateNow(bureau, 'g1', {
        validator: { ...CONTAINS_PHRASE, configuration: { phrase: 'staging fix' } },
      }),
    ).toMatchObject({ outcome: 'updated' });
    expect(
      await updateNow(bureau, 'g1', {
        validator: { ...CONTAINS_PHRASE, configuration: { phrase: 'staging fix' } },
      }),
    ).toMatchObject({ outcome: 'unchanged' });
    gate.release();

    expect(await ended(bureau)).toMatchObject({
      status: 'succeeded',
      validatorConfiguration: { phrase: 'staging fix' },
    });
  });

  it('clears the stored configuration when the validator changes', async () => {
    const gate = createLatch();
    const bureau = await boot({
      agents: {
        worker: workerAgent(() => gate.promise.then(() => ({ content: 'done', toolCalls: [] }))),
      },
      validators: [containsPhrase(), createCheckValidator()],
    });
    await bureau.goals.create(
      goalRequest({ validator: { ...CONTAINS_PHRASE, configuration: { phrase: 'x' } } }),
    );

    expect(await updateNow(bureau, 'g1', { validator: CHECK })).toMatchObject({
      outcome: 'updated',
    });
    const goal = (await bureau.goals.get('g1'))!;
    expect(goal.validator).toEqual(CHECK);
    expect(goal.validatorConfiguration).toBeUndefined();
    gate.release();
  });

  it('refuses a configuration for the new validator when it has no schema', async () => {
    const gate = createLatch();
    const bureau = await boot({
      agents: {
        worker: workerAgent(() => gate.promise.then(() => ({ content: 'done', toolCalls: [] }))),
      },
      validators: [containsPhrase(), createCheckValidator()],
    });
    await bureau.goals.create(
      goalRequest({ validator: { ...CONTAINS_PHRASE, configuration: { phrase: 'x' } } }),
    );

    expect(
      await updateNow(bureau, 'g1', { validator: { ...CHECK, configuration: { phrase: 'x' } } }),
    ).toMatchObject({ outcome: 'rejected', code: 'invalid-configuration' });
    expect((await bureau.goals.get('g1'))!.validator).toEqual(CONTAINS_PHRASE);
    gate.release();
  });

  it('records on each attempt the configuration that judged it, whatever the goal is changed to after', async () => {
    const second = createLatch();
    let calls = 0;
    const generate: GenerateFunction = async () => {
      calls += 1;
      if (calls === 1) return { content: 'nothing yet', toolCalls: [] };
      await second.promise;
      return { content: 'the other phrase', toolCalls: [] };
    };
    const bureau = await boot({
      agents: { worker: workerAgent(generate) },
      validators: [containsPhrase()],
    });
    await bureau.goals.create(
      goalRequest({ validator: { ...CONTAINS_PHRASE, configuration: { phrase: 'phrase A' } } }),
    );
    await pollUntil(async () => {
      const goal = await bureau.goals.get('g1');
      return goal?.status === 'running' && goal.attempts.length === 2;
    });

    expect(
      await updateNow(bureau, 'g1', {
        validator: { ...CONTAINS_PHRASE, configuration: { phrase: 'other phrase' } },
      }),
    ).toMatchObject({ outcome: 'updated' });
    second.release();

    const goal = await ended(bureau);
    expect(goal).toMatchObject({ status: 'succeeded' });
    expect(goal.attempts.map((attempt) => attempt.validation?.judgedBy?.configuration)).toEqual([
      { phrase: 'phrase A' },
      { phrase: 'other phrase' },
    ]);
  });
});
