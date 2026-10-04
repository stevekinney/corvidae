import { describe, expect, it } from 'bun:test';

import { memoizeUntilRejected } from './retryable-promise.ts';

describe('memoizeUntilRejected', () => {
  it('shares one in-flight attempt between concurrent callers', async () => {
    let attempts = 0;
    const load = memoizeUntilRejected(async () => {
      attempts += 1;
      return 'loaded';
    });

    const [first, second] = await Promise.all([load(), load()]);

    expect(first).toBe('loaded');
    expect(second).toBe('loaded');
    expect(attempts).toBe(1);
  });

  it('keeps a successful result for every later caller', async () => {
    let attempts = 0;
    const load = memoizeUntilRejected(async () => {
      attempts += 1;
      return attempts;
    });

    expect(await load()).toBe(1);
    expect(await load()).toBe(1);
    expect(attempts).toBe(1);
  });

  it('retries after a rejection instead of replaying it', async () => {
    let attempts = 0;
    const load = memoizeUntilRejected(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('chunk request failed');
      return 'recovered';
    });

    const failed = await load().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(Error);

    expect(await load()).toBe('recovered');
    expect(attempts).toBe(2);
  });

  it('does not clear a newer attempt when an older one rejects late', async () => {
    const releases: ((outcome: 'reject' | 'resolve') => void)[] = [];
    let attempts = 0;
    const load = memoizeUntilRejected(
      () =>
        new Promise<string>((resolve, reject) => {
          attempts += 1;
          releases.push((outcome) =>
            outcome === 'resolve' ? resolve(`attempt ${attempts}`) : reject(new Error('late')),
          );
        }),
    );

    const first = load();
    const firstOutcome = first.then(
      () => 'resolved',
      () => 'rejected',
    );
    releases[0]!('reject');
    expect(await firstOutcome).toBe('rejected');

    const second = load();
    expect(attempts).toBe(2);
    releases[1]!('resolve');
    expect(await second).toBe('attempt 2');
    expect(await load()).toBe('attempt 2');
    expect(attempts).toBe(2);
  });
});
