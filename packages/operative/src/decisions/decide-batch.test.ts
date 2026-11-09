import { rejectionOf, throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';

import { assertValidDecisionBatch, decideBatch } from './decide-batch';
import { DecisionSchemaError } from './errors';
import type {
  DecideOptions,
  Decision,
  DecisionBatch,
  DecisionBatchResult,
  DecisionModel,
  DecisionQuestion,
  DecisionRequest,
} from './types';

const refund: DecisionQuestion = { kind: 'boolean', question: 'Is this a refund request?' };
const team: DecisionQuestion = {
  kind: 'choice',
  question: 'Which team?',
  options: [
    { key: 'billing', label: 'Payments' },
    { key: 'tech', label: 'Bugs' },
  ],
};

function batchOf(context: string | undefined, ...entries: [string, DecisionQuestion][]) {
  return { ...(context === undefined ? {} : { context }), questions: new Map(entries) };
}

/** A model that answers one question at a time and records every request it was asked. */
function oneAtATimeModel(answer: (request: DecisionRequest) => Decision<unknown>) {
  const asked: DecisionRequest[] = [];
  const model: DecisionModel = {
    name: 'scripted/one-at-a-time',
    kinds: new Set(['boolean', 'choice']),
    decide: async (request) => {
      asked.push(request);
      return answer(request);
    },
  };
  return { model, asked };
}

describe('decideBatch without a batch method', () => {
  it('asks each question in order with the batch context and sums the usage', async () => {
    const { model, asked } = oneAtATimeModel((request) => ({
      value: request.kind === 'boolean' ? true : 'billing',
      probability: 0.9,
      provider: 'scripted',
      model: 'scripted-1',
      usage: { prompt: 10, completion: 2, total: 12 },
    }));

    const result = await decideBatch(
      model,
      batchOf('Charged twice.', ['refund', refund], ['team', team]),
    );

    expect(asked).toEqual([
      { ...refund, context: 'Charged twice.' },
      { ...team, context: 'Charged twice.' },
    ] as DecisionRequest[]);
    expect([...result.decisions.keys()]).toEqual(['refund', 'team']);
    expect(result.decisions.get('refund')).toEqual({
      value: true,
      probability: 0.9,
      provider: 'scripted',
      model: 'scripted-1',
    });
    expect(result.decisions.get('team')?.value).toBe('billing');
    expect(result.usage).toEqual({ prompt: 20, completion: 4, total: 24 });
  });

  it('omits the context from each request when the batch has none', async () => {
    const { model, asked } = oneAtATimeModel(() => ({
      value: true,
      provider: 'scripted',
      model: 'scripted-1',
    }));

    const result = await decideBatch(model, batchOf(undefined, ['refund', refund]));

    expect(asked).toEqual([{ ...refund }] as DecisionRequest[]);
    expect('context' in asked[0]!).toBe(false);
    expect(result.usage).toBeUndefined();
  });

  it('rejects the whole batch when one question fails', async () => {
    const failure = new Error('provider down');
    const { model } = oneAtATimeModel((request) => {
      if (request.kind === 'choice') throw failure;
      return { value: true, provider: 'scripted', model: 'scripted-1' };
    });

    expect(
      await rejectionOf(decideBatch(model, batchOf('x', ['refund', refund], ['team', team]))),
    ).toBe(failure);
  });

  it('stops before asking anything when the signal is already aborted', async () => {
    const { model, asked } = oneAtATimeModel(() => ({
      value: true,
      provider: 'scripted',
      model: 'scripted-1',
    }));
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    expect(
      await throwingRejectionOf(
        decideBatch(model, batchOf('x', ['refund', refund]), { signal: controller.signal }),
      ),
    ).toThrow('cancelled');
    expect(asked).toEqual([]);
  });
});

describe('decideBatch with a batch method', () => {
  function batchingModel(
    answer: (batch: DecisionBatch, options?: DecideOptions) => DecisionBatchResult,
  ) {
    const batches: DecisionBatch[] = [];
    const model: DecisionModel = {
      name: 'scripted/batching',
      kinds: new Set(['boolean', 'choice']),
      decide: async () => {
        throw new Error('decide must not be called when the model batches');
      },
      decideBatch: async (batch, options) => {
        batches.push(batch);
        return answer(batch, options);
      },
    };
    return { model, batches };
  }

  it('sends one batch, keeps the caller order, and strips per-decision usage', async () => {
    const { model, batches } = batchingModel((batch) => ({
      decisions: new Map(
        [...batch.questions].toReversed().map(([name, question]) => [
          name,
          {
            value: question.kind === 'boolean' ? false : 'tech',
            provider: 'scripted',
            model: 'scripted-2',
            usage: { prompt: 1, completion: 1, total: 2 },
          },
        ]),
      ),
      usage: { prompt: 40, completion: 6, total: 46 },
    }));
    const questions = new Map<string, DecisionQuestion>([
      ['refund', refund],
      ['team', team],
    ]);

    const result = await decideBatch(model, { context: 'Site is down.', questions });

    expect(batches).toHaveLength(1);
    expect(batches[0]!.context).toBe('Site is down.');
    expect(batches[0]!.questions).not.toBe(questions);
    expect([...batches[0]!.questions]).toEqual([...questions]);
    expect([...result.decisions.keys()]).toEqual(['refund', 'team']);
    expect(result.decisions.get('refund')).toEqual({
      value: false,
      provider: 'scripted',
      model: 'scripted-2',
    });
    expect(result.usage).toEqual({ prompt: 40, completion: 6, total: 46 });
  });

  it('copies the questions before the first await, so the caller may reuse its map', async () => {
    let release: (result: DecisionBatchResult) => void = () => {};
    const pending = new Promise<DecisionBatchResult>((resolve) => {
      release = resolve;
    });
    const seen: DecisionBatch[] = [];
    const model: DecisionModel = {
      name: 'scripted/slow',
      kinds: new Set(['boolean']),
      decide: async () => {
        throw new Error('unused');
      },
      decideBatch: (batch) => {
        seen.push(batch);
        return pending;
      },
    };
    const questions = new Map<string, DecisionQuestion>([['refund', refund]]);

    const answer = decideBatch(model, { questions });
    questions.set('later', refund);
    release({
      decisions: new Map([['refund', { value: true, provider: 'scripted', model: 'm' }]]),
    });

    const result = await answer;
    expect([...result.decisions.keys()]).toEqual(['refund']);
    expect([...seen[0]!.questions.keys()]).toEqual(['refund']);
  });

  it('rejects with DecisionSchemaError when the model leaves a question unanswered', async () => {
    const { model } = batchingModel(() => ({
      decisions: new Map([['refund', { value: true, provider: 'scripted', model: 'm' }]]),
      usage: { prompt: 5, completion: 1, total: 6 },
    }));

    const failure = await decideBatch(
      model,
      batchOf('x', ['refund', refund], ['team', team]),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DecisionSchemaError);
    expect((failure as DecisionSchemaError).message).toContain('"team"');
    expect((failure as DecisionSchemaError).usage).toEqual({ prompt: 5, completion: 1, total: 6 });
  });
});

describe('decideBatch validation', () => {
  const { model, asked } = oneAtATimeModel(() => ({
    value: true,
    provider: 'scripted',
    model: 'scripted-1',
  }));

  it.each([
    ['a batch that is not an object', null, 'must be an object'],
    ['a non-text context', { context: 7, questions: new Map([['a', refund]]) }, 'must be text'],
    ['questions that are not a Map', { questions: { a: refund } }, 'Map with at least one'],
    ['an empty batch', { questions: new Map() }, 'Map with at least one'],
    ['a blank question name', { questions: new Map([[' ', refund]]) }, 'non-empty name'],
    [
      'a question with its own context',
      { questions: new Map([['a', { ...refund, context: 'mine' }]]) },
      'carries its own context',
    ],
    [
      'an invalid question',
      { questions: new Map([['solo', { ...team, options: [team.options[0]] }]]) },
      'Question "solo": A choice request needs at least two options.',
    ],
  ])('rejects %s before asking anything', async (_label, batch, message) => {
    expect(
      await throwingRejectionOf(decideBatch(model, batch as unknown as DecisionBatch)),
    ).toThrow(message);
    expect(() => assertValidDecisionBatch(batch as unknown as DecisionBatch)).toThrow(TypeError);
    expect(asked).toEqual([]);
  });

  it('rejects a question whose kind the model cannot answer', async () => {
    const scale: DecisionQuestion = {
      kind: 'scale',
      question: 'How urgent?',
      levels: ['low', 'high'],
    };

    expect(await throwingRejectionOf(decideBatch(model, batchOf('x', ['urgency', scale])))).toThrow(
      'scripted/one-at-a-time cannot answer the scale question "urgency".',
    );
    expect(asked).toEqual([]);
  });
});
