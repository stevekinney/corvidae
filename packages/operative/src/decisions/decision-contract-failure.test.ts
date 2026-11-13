import { describe, expect, test } from 'bun:test';

import { decisionContractFailure } from '../testing/decision-model-contract.test-support';
import { decisionScenarios } from '../testing/decision-scenarios';
import type { DecisionModel } from './types';

const scenario = decisionScenarios.find(({ name }) => name === 'boolean-true')!;

function answering(value: unknown, extra: Partial<DecisionModel> = {}): DecisionModel {
  return {
    name: 'scripted',
    kinds: new Set(['boolean']),
    decide: async () => ({ value: value as never, provider: 'scripted', model: 'model' }),
    ...extra,
  };
}

describe('decisionContractFailure', () => {
  test('is undefined for a model that answers the case as the contract requires', async () => {
    expect(await decisionContractFailure(answering(true), scenario)).toBeUndefined();
  });

  test('names a wrong value, a value of the wrong type, and a refusal as a message', async () => {
    expect(await decisionContractFailure(answering(false), scenario)).toContain('true');
    expect(await decisionContractFailure(answering('yes'), scenario)).toBeString();
    const refusing = answering(true, {
      decide: async () => {
        throw new Error('outage');
      },
    });
    expect(await decisionContractFailure(refusing, scenario)).toBe('outage');
  });
});
