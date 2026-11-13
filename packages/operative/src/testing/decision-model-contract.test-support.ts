import { expect, it } from 'bun:test';

import { decideBatch } from '../decisions/decide-batch';
import type { DecisionBatch, DecisionModel, DecisionRequest } from '../decisions/types';

/** One request a {@link DecisionModel} must answer, and the value it must answer with. */
export interface DecisionContractCase {
  /** The case's name, which becomes the title of its test. */
  readonly name: string;
  /** The request the model is asked to answer. */
  readonly request: DecisionRequest;
  /** The value the model's decision must carry. */
  readonly expected: unknown;
}

function assertValueMatchesKind(request: DecisionRequest, value: unknown): void {
  switch (request.kind) {
    case 'boolean':
      expect(typeof value).toBe('boolean');
      return;
    case 'choice':
      expect(request.options.map((option) => option.key)).toContain(value as string);
      return;
    case 'scale':
      expect(Number.isInteger(value)).toBe(true);
      expect(value as number).toBeGreaterThanOrEqual(0);
      expect(value as number).toBeLessThan(request.levels.length);
      return;
    case 'structured':
      expect(typeof value).toBe('object');
      return;
  }
}

/**
 * Registers the behavior every {@link DecisionModel} must share: each kind in
 * `kinds` is answered with a value of that kind's type, the provider and model
 * are named, a reported probability is a probability, and reported usage is
 * made of non-negative integers whose total covers its parts. Run inside a
 * `describe`; `create` builds a fresh model for the case about to run, or for
 * the kinds check (no case), so a scripted model can queue that case's answer.
 */
export function runDecisionModelContract(
  create: (contractCase?: DecisionContractCase) => DecisionModel | Promise<DecisionModel>,
  cases: readonly DecisionContractCase[],
): void {
  it('declares the kinds it can answer', async () => {
    const model = await create();
    expect(model.name.length).toBeGreaterThan(0);
    expect(model.kinds.size).toBeGreaterThan(0);
    for (const contractCase of cases) {
      expect(model.kinds.has(contractCase.request.kind)).toBe(true);
    }
  });

  for (const contractCase of cases) {
    it(`answers ${contractCase.name}`, async () => {
      await assertDecisionAnswer(await create(contractCase), contractCase);
    });
  }
}

/** Asks `model` the case's request and asserts the decision the contract requires. */
async function assertDecisionAnswer(
  model: DecisionModel,
  contractCase: DecisionContractCase,
): Promise<void> {
  const decision = await model.decide(contractCase.request);

  expect(decision.value).toEqual(contractCase.expected as never);
  assertValueMatchesKind(contractCase.request, decision.value);
  expect(decision.provider.length).toBeGreaterThan(0);
  expect(decision.model.length).toBeGreaterThan(0);
  if (decision.probability !== undefined) {
    expect(decision.probability).toBeGreaterThanOrEqual(0);
    expect(decision.probability).toBeLessThanOrEqual(1);
  }
  if (decision.usage !== undefined) {
    const { prompt, completion, total } = decision.usage;
    for (const count of [prompt, completion, total]) {
      expect(Number.isInteger(count)).toBe(true);
      expect(count).toBeGreaterThanOrEqual(0);
    }
    expect(total).toBeGreaterThanOrEqual(prompt + completion);
  }
}

/**
 * What {@link runDecisionModelContract} would fail on for one case, as a message, or `undefined`
 * when `model` answers it as the contract requires. For a caller that reports problems itself, such
 * as a plugin's conformance check, instead of registering tests.
 */
export async function decisionContractFailure(
  model: DecisionModel,
  contractCase: DecisionContractCase,
): Promise<string | undefined> {
  try {
    await assertDecisionAnswer(model, contractCase);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** One batch a {@link DecisionModel} must answer, and the value each question must be answered with. */
export interface DecisionBatchContractCase {
  /** The case's name, which becomes the title of its test. */
  readonly name: string;
  /** The batch the model is asked to answer through `decideBatch`. */
  readonly batch: DecisionBatch;
  /** The value each question's decision must carry, by question name. */
  readonly expected: ReadonlyMap<string, unknown>;
}

/**
 * Registers the batch behavior every {@link DecisionModel} must share when
 * answered through `decideBatch`: every question gets a decision under its own
 * name and no other, each value matches its question's kind and the expected
 * value, no decision carries usage of its own, and the batch's usage, when
 * reported, is made of non-negative integers whose total covers its parts. A
 * model without a batch method passes by being asked one question at a time.
 */
export function runDecisionBatchContract(
  create: (contractCase: DecisionBatchContractCase) => DecisionModel | Promise<DecisionModel>,
  cases: readonly DecisionBatchContractCase[],
): void {
  for (const contractCase of cases) {
    it(`answers the batch ${contractCase.name}`, async () => {
      const model = await create(contractCase);

      const result = await decideBatch(model, contractCase.batch);

      expect([...result.decisions.keys()]).toEqual([...contractCase.batch.questions.keys()]);
      for (const [name, question] of contractCase.batch.questions) {
        const decision = result.decisions.get(name)!;
        expect(decision.value).toEqual(contractCase.expected.get(name) as never);
        assertValueMatchesKind({ ...question }, decision.value);
        expect(decision.usage).toBeUndefined();
        expect(decision.provider.length).toBeGreaterThan(0);
        expect(decision.model.length).toBeGreaterThan(0);
        if (decision.probability !== undefined) {
          expect(decision.probability).toBeGreaterThanOrEqual(0);
          expect(decision.probability).toBeLessThanOrEqual(1);
        }
      }
      if (result.usage !== undefined) {
        const { prompt, completion, total } = result.usage;
        for (const count of [prompt, completion, total]) {
          expect(Number.isInteger(count)).toBe(true);
          expect(count).toBeGreaterThanOrEqual(0);
        }
        expect(total).toBeGreaterThanOrEqual(prompt + completion);
      }
    });
  }
}
