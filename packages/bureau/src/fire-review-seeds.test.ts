/**
 * COR-1622 — a fire's seed read of its review history: shared while the fire is in flight, awaited
 * by a writer of a close, retried after a failure, and gone with the fire, so an announcement after
 * the fire settled reads the history afresh.
 */
import { describe, expect, it } from 'bun:test';

import { createFireReviewSeeds } from './fire-review-seeds';
import type { BureauDiagnostic } from './types';

function seedsWith(read: (runId: string) => Promise<void>) {
  const diagnostics: BureauDiagnostic[] = [];
  return {
    diagnostics,
    seeds: createFireReviewSeeds({ read, diagnose: (diagnostic) => diagnostics.push(diagnostic) }),
  };
}

describe('the seed read of a fire', () => {
  it('is read once while the fire is in flight, and shared by every caller', async () => {
    const reads: string[] = [];
    const { seeds } = seedsWith(async (runId) => {
      reads.push(runId);
    });

    await Promise.all([seeds.ensure('fire-a'), seeds.ensure('fire-a'), seeds.pending('fire-a')]);
    await seeds.ensure('fire-a');

    expect(reads).toEqual(['fire-a']);
  });

  it('is awaited by a writer of a close while the read is under way', async () => {
    const gate = Promise.withResolvers<void>();
    const order: string[] = [];
    const { seeds } = seedsWith(async () => {
      await gate.promise;
      order.push('seed read');
    });
    void seeds.ensure('fire-a').then(() => order.push('request'));

    const closing = seeds.pending('fire-a').then(() => order.push('close'));
    await Promise.resolve();
    expect(order).toEqual([]);
    gate.resolve();
    await closing;

    expect(order).toEqual(['seed read', 'request', 'close']);
  });

  it('is read afresh by an announcement after the fire was released, and held for no fire more', async () => {
    const reads: string[] = [];
    const { seeds } = seedsWith(async (runId) => {
      reads.push(runId);
    });
    await seeds.ensure('fire-a');
    await seeds.ensure('fire-b');
    expect(seeds.size()).toBe(2);

    seeds.release('fire-a');
    expect(seeds.has('fire-a')).toBe(false);
    expect(seeds.size()).toBe(1);
    await seeds.ensure('fire-a');

    expect(reads).toEqual(['fire-a', 'fire-b', 'fire-a']);
  });

  it('is read again after a read that failed, and the failure is reported', async () => {
    let calls = 0;
    const { seeds, diagnostics } = seedsWith(async () => {
      calls += 1;
      if (calls === 1) throw new Error('storage unavailable');
    });

    await seeds.ensure('fire-a');
    expect(seeds.has('fire-a')).toBe(false);
    await seeds.ensure('fire-a');

    expect(calls).toBe(2);
    expect(diagnostics).toHaveLength(1);
    expect(seeds.has('fire-a')).toBe(true);
  });
});
