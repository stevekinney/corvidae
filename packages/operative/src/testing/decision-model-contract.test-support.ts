import { expect, it } from 'bun:test';

import type { DecisionModel, DecisionRequest } from '../decisions/types';

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
      const model = await create(contractCase);

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
    });
  }
}
