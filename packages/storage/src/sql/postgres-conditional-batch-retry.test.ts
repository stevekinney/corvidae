import { describe, expect, it } from 'bun:test';

import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';

import { PostgresKeyValueStorage, type PostgresPool } from './postgres-key-value-storage.ts';

/** What one `conditionalBatch` transaction attempt does when it starts. */
type AttemptOutcome = 'conflict' | 'deadlock' | 'fatal' | 'proceed';

function refusePoolFactory(): PostgresPool {
  throw new Error('an injected pool needs no factory');
}

/**
 * A pool whose transactions begin according to `outcomes` (one entry per `BEGIN`, the last
 * repeating): a `conflict` or `deadlock` aborts with the matching retryable SQLSTATE, `fatal`
 * throws an error that is not a transaction abort, and `proceed` runs the statements against an
 * empty table.
 */
function scriptedPool(outcomes: AttemptOutcome[]): {
  pool: PostgresPool;
  arm(storage: PostgresKeyValueStorage): Promise<void>;
  began(): number;
} {
  let armed = false;
  let began = 0;
  const pool: PostgresPool = {
    query: async () => ({ rows: [{ collation: 'C' }] }),
    connect: async () => ({
      query: async (sql: string) => {
        if (armed && sql.startsWith('BEGIN')) {
          const outcome = outcomes[Math.min(began, outcomes.length - 1)];
          began += 1;
          if (outcome === 'conflict') {
            throw Object.assign(new Error('could not serialize access'), { code: '40001' });
          }
          if (outcome === 'deadlock') {
            throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
          }
          if (outcome === 'fatal') throw new Error('connection reset');
        }
        return { rows: [] };
      },
      release: () => {},
    }),
    end: async () => {},
  };
  return {
    pool,
    async arm(storage) {
      await storage.has('__setup__');
      armed = true;
    },
    began: () => began,
  };
}

const writeIfAbsent = [
  [{ key: 'a', expectedValue: null }],
  [{ type: 'put' as const, key: 'a', value: new Uint8Array([1]) }],
] as const;
const writeIfPresent = [
  [{ key: 'a', expectedValue: new Uint8Array([9]) }],
  [{ type: 'put' as const, key: 'a', value: new Uint8Array([1]) }],
] as const;

/** With `random() === 0.5`, the delay before retry `n` is half of `min(320, 10 * 2 ** n)`. */
const HALF_WINDOWS = [5, 10, 20, 40, 80, 160, 160, 160, 160, 160, 160];
const MAXIMUM_ATTEMPTS = 12;

type Case = {
  name: string;
  outcomes: AttemptOutcome[];
  conditions: typeof writeIfAbsent | typeof writeIfPresent;
  expected: { result: boolean } | { error: string };
  attempts: number;
  delays: number[];
};

const exhausted = `conditionalBatch exhausted ${MAXIMUM_ATTEMPTS} attempts after retryable transaction failures`;

const cases: Case[] = [
  {
    name: 'commits on the first try without waiting',
    outcomes: ['proceed'],
    conditions: writeIfAbsent,
    expected: { result: true },
    attempts: 1,
    delays: [],
  },
  {
    name: 'waits a jittered delay after a serialization failure, then commits',
    outcomes: ['conflict', 'proceed'],
    conditions: writeIfAbsent,
    expected: { result: true },
    attempts: 2,
    delays: [5],
  },
  {
    name: 'treats a deadlock like a serialization failure and doubles the window each time',
    outcomes: ['conflict', 'deadlock', 'conflict', 'proceed'],
    conditions: writeIfAbsent,
    expected: { result: true },
    attempts: 4,
    delays: [5, 10, 20],
  },
  {
    name: 'caps the delay window and throws exhausted after the bound when every attempt aborts',
    outcomes: ['conflict'],
    conditions: writeIfAbsent,
    expected: { error: exhausted },
    attempts: MAXIMUM_ATTEMPTS,
    delays: HALF_WINDOWS,
  },
  {
    name: 'returns false without retrying when the condition fails',
    outcomes: ['proceed'],
    conditions: writeIfPresent,
    expected: { result: false },
    attempts: 1,
    delays: [],
  },
  {
    name: 'returns false after a retry when the condition fails on the re-read',
    outcomes: ['conflict', 'proceed'],
    conditions: writeIfPresent,
    expected: { result: false },
    attempts: 2,
    delays: [5],
  },
  {
    name: 'throws a non-retryable error at once without waiting',
    outcomes: ['fatal'],
    conditions: writeIfAbsent,
    expected: { error: 'connection reset' },
    attempts: 1,
    delays: [],
  },
];

describe('PostgresKeyValueStorage conditionalBatch retry lifecycle', () => {
  it.each(cases)('$name', async ({ outcomes, conditions, expected, attempts, delays }) => {
    const scripted = scriptedPool(outcomes);
    const waited: number[] = [];
    const storage = new PostgresKeyValueStorage(
      {
        pool: scripted.pool,
        serializationRetry: {
          delay: async (milliseconds) => {
            waited.push(milliseconds);
          },
          random: () => 0.5,
        },
      },
      refusePoolFactory,
    );
    await scripted.arm(storage);

    const run = storage.conditionalBatch([...conditions[0]], [...conditions[1]]);
    if ('error' in expected) {
      expect(await throwingRejectionOf(run)).toThrow(expected.error);
    } else {
      expect(await run).toBe(expected.result);
    }
    expect(scripted.began()).toBe(attempts);
    expect(waited).toEqual(delays);
  });

  it('jitters across the whole window and never waits past the cap', async () => {
    const scripted = scriptedPool(['conflict']);
    const waited: number[] = [];
    const draws = [0, 0.999999];
    let draw = 0;
    const storage = new PostgresKeyValueStorage(
      {
        pool: scripted.pool,
        serializationRetry: {
          delay: async (milliseconds) => {
            waited.push(milliseconds);
          },
          random: () => draws[draw++ % draws.length] as number,
        },
      },
      refusePoolFactory,
    );
    await scripted.arm(storage);

    await throwingRejectionOf(
      storage.conditionalBatch([...writeIfAbsent[0]], [...writeIfAbsent[1]]),
    );

    expect(waited[0]).toBe(0);
    expect(waited[1]).toBe(19);
    expect(Math.max(...waited)).toBeLessThan(320);
    expect(waited).toHaveLength(MAXIMUM_ATTEMPTS - 1);
  });

  it('waits on a real timer by default and still commits after a conflict', async () => {
    const scripted = scriptedPool(['conflict', 'proceed']);
    const storage = new PostgresKeyValueStorage({ pool: scripted.pool }, refusePoolFactory);
    await scripted.arm(storage);

    expect(await storage.conditionalBatch([...writeIfAbsent[0]], [...writeIfAbsent[1]])).toBe(true);
    expect(scripted.began()).toBe(2);
  });
});
