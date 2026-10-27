import { describe, expect, test } from 'bun:test';

import { mapWithConcurrency } from './map-with-concurrency';
import { throwingRejectionOf } from './promise-outcome.test-support.ts';
import { quietFor } from './wait-until.ts';

/** A promise the test settles by hand, so completion order is chosen rather than raced. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, resolve };
}

describe('mapWithConcurrency', () => {
  test('resolves to results in input order whatever order the transforms finish in', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const mapped = mapWithConcurrency([0, 1, 2], 3, async (item, index) => {
      await gates[index]!.promise;
      return item * 10;
    });
    gates[2]!.resolve();
    gates[0]!.resolve();
    gates[1]!.resolve();
    expect(await mapped).toEqual([0, 10, 20]);
  });

  test('never has more than the limit in flight, and keeps the limit saturated', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 25 }, (_, index) => index);
    const results = await mapWithConcurrency(items, 4, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // load-proof: simulated work: the assertions are the peak count of items in flight, which the scheduler fixes before any item's await returns, whatever the duration of that await
      await Bun.sleep(1);
      inFlight -= 1;
      return item;
    });
    expect(results).toEqual(items);
    expect(peak).toBe(4);
  });

  test('rejects with the first failure and starts nothing after it', async () => {
    const started: number[] = [];
    const mapped = mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (item) => {
      started.push(item);
      if (item === 1) throw new Error('item 1 failed');
      // load-proof: simulated work: what is asserted is which items started after the first failure, which the scheduler decides before any item's await returns
      await Bun.sleep(1);
      return item;
    });
    expect(await throwingRejectionOf(mapped)).toThrow('item 1 failed');
    await quietFor(10);
    expect(started).toEqual([0, 1]);
  });

  test('resolves an empty input without calling the transform', async () => {
    let calls = 0;
    const results = await mapWithConcurrency([], 8, async () => {
      calls += 1;
    });
    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });

  test('refuses a limit that could never make progress', async () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(
        await throwingRejectionOf(mapWithConcurrency([1], limit, async (item) => item)),
      ).toThrow(RangeError);
    }
  });
});
