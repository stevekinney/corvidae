import { describe, expect, test } from 'bun:test';

import type { GenerateContext } from '@lostgradient/operative';

import { memoryLifecycleEnvelope } from './envelope';
import {
  chooseStatement,
  createReferencePolicy,
  type RecallToolRecord,
  seededRandom,
} from './policy';
import { renderTaskPrompt } from './prompt';

const TASK = {
  name: 'ship-order',
  instruction: 'Ship the order.',
  query: 'shipping address',
  slot: 'Shipping address',
  action: 'ship_order',
};

function record(
  content: string,
  observedAt: string | null,
  source: string | null = 'conversation',
): RecallToolRecord {
  return { content, observedAt, source };
}

/** A generate context over `messages`, as operative's conversation exposes them. */
function contextOf(step: number, messages: readonly Record<string, unknown>[]): GenerateContext {
  const ids = messages.map((_message, index) => `message-${index}`);
  return {
    step,
    conversation: {
      current: { ids, messages: Object.fromEntries(ids.map((id, index) => [id, messages[index]])) },
    },
  } as unknown as GenerateContext;
}

const system = { role: 'system', content: 'Instructions.' };
const user = { role: 'user', content: renderTaskPrompt(TASK) };
const recalled = (content: unknown) => ({
  role: 'tool-result',
  content: '',
  toolResult: { content },
});

describe('chooseStatement', () => {
  test('prefers the best-ranked source, then the newest statement of the slot', () => {
    const records = [
      record('Shipping address: 1 Old Road.', '2026-01-01T00:00:00.000Z'),
      record('Shipping address: 2 New Road.', '2026-06-01T00:00:00.000Z'),
      record('Shipping address: 3 Document Road.', '2026-09-01T00:00:00.000Z', 'ingested-document'),
      record('Order 12 contains a lamp.', '2026-09-02T00:00:00.000Z'),
    ];
    expect(chooseStatement(records, 'Shipping address')).toBe('2 New Road');
    expect(
      chooseStatement(
        [...records, record('Shipping address: 4 Operator Road.', null, 'operator')],
        'shipping  ADDRESS',
      ),
    ).toBe('4 Operator Road');
  });

  test('keeps recall order between statements it cannot tell apart, and ranks an unknown source lowest', () => {
    expect(
      chooseStatement(
        [
          record('Seat preference: aisle.', null, null),
          record('Seat preference: window.', null, null),
        ],
        'Seat preference',
      ),
    ).toBe('aisle');
    expect(
      chooseStatement(
        [
          record('Seat preference: aisle.', null, 'rumor'),
          record('Seat preference: window.', null),
        ],
        'Seat preference',
      ),
    ).toBe('window');
  });

  test('finds nothing when no record states the slot', () => {
    expect(chooseStatement([record('Order 12 contains a lamp.', null)], 'Shipping address')).toBe(
      undefined,
    );
  });

  test('departs from the reference choice only when the sample falls under the noise', () => {
    const records = [
      record('Shipping address: 1 Old Road.', '2026-01-01T00:00:00.000Z'),
      record('Shipping address: 2 New Road.', '2026-06-01T00:00:00.000Z'),
    ];
    const draws =
      (...values: number[]) =>
      () =>
        values.shift()!;
    expect(chooseStatement(records, 'Shipping address', draws(0.1, 0.2), 0.5)).toBe('1 Old Road');
    expect(chooseStatement(records, 'Shipping address', draws(0.9), 0.5)).toBe('2 New Road');
  });
});

describe('seededRandom', () => {
  test('draws the same sequence from the same seed, in [0, 1)', () => {
    const first = seededRandom(42);
    const second = seededRandom(42);
    const values = Array.from({ length: 50 }, () => first());
    expect(Array.from({ length: 50 }, () => second())).toEqual(values);
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(seededRandom(43)()).not.toBe(values[0]);
  });
});

describe('createReferencePolicy', () => {
  const policy = createReferencePolicy(memoryLifecycleEnvelope('deterministic'), 7);

  test('recalls the lookup first, with usage counted from what it read', async () => {
    const response = await policy(contextOf(0, [system, user]));
    expect(response.toolCalls).toEqual([
      { id: 'call-0', name: 'memory_recall', arguments: { query: 'shipping address' } },
    ]);
    expect(response.usage!.prompt).toBeGreaterThan(0);
    expect(response.usage!.total).toBe(response.usage!.prompt + response.usage!.completion);
  });

  test('acts on the chosen statement, or reports unknown when there is none', async () => {
    const acted = await policy(
      contextOf(1, [
        system,
        user,
        recalled({ records: [record('Shipping address: 17 Cedar Lane, Olympia.', null)] }),
      ]),
    );
    expect(acted.toolCalls).toEqual([
      {
        id: 'call-1',
        name: 'environment_action',
        arguments: { action: 'ship_order', value: '17 Cedar Lane, Olympia' },
      },
    ]);
    for (const content of [{ records: [] }, { error: 'refused' }, null]) {
      const unknown = await policy(contextOf(1, [system, user, recalled(content)]));
      expect(unknown.toolCalls).toEqual([
        { id: 'call-1', name: 'environment_unknown', arguments: { action: 'ship_order' } },
      ]);
    }
  });

  test('stops once the environment has answered', async () => {
    const response = await policy(
      contextOf(2, [system, user, recalled({ records: [] }), recalled({ applied: true })]),
    );
    expect(response).toMatchObject({ content: 'Done.', toolCalls: [] });
  });

  test('declines a prompt that is not a task prompt', async () => {
    for (const messages of [[system], [system, { role: 'user', content: [{ type: 'text' }] }]]) {
      const response = await policy(contextOf(0, messages));
      expect(response).toMatchObject({ content: 'I cannot read this task.', toolCalls: [] });
    }
  });

  test('samples from the trial seed in the stochastic lane', async () => {
    const records = Array.from({ length: 6 }, (_, index) =>
      record(`Shipping address: ${index} Road.`, `2026-0${index + 1}-01T00:00:00.000Z`),
    );
    const chosen = async (seed: number) => {
      const sampled = createReferencePolicy(memoryLifecycleEnvelope('stochastic'), seed);
      const response = await sampled(contextOf(1, [system, user, recalled({ records })]));
      return (response.toolCalls[0]!.arguments as { value: string }).value;
    };
    const values = await Promise.all(Array.from({ length: 40 }, (_, seed) => chosen(seed)));
    expect(new Set(values).size).toBeGreaterThan(1);
    expect(values.filter((value) => value === '5 Road').length).toBeGreaterThan(20);
    expect(await chosen(3)).toBe(values[3]!);
  });
});
