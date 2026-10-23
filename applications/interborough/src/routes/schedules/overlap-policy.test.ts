import { describe, expect, test } from 'bun:test';

import { OVERLAP_POLICIES, overlapConsequence } from './overlap-policy.ts';

describe('OVERLAP_POLICIES', () => {
  test('covers all four engine overlap policy values, in the source-doc order', () => {
    expect(OVERLAP_POLICIES.map((descriptor) => descriptor.value)).toEqual([
      'skip',
      'queue',
      'cancel-running',
      'allow',
    ]);
  });

  test('every consequence is non-empty prose, not the design mock copy', () => {
    for (const descriptor of OVERLAP_POLICIES) {
      expect(descriptor.consequence.length).toBeGreaterThan(20);
    }
    // The queue policy's consequence must say the queue is unbounded — the
    // design mock's "further fires while it waits are dropped" is factually
    // wrong (see this module's doc) and must never regress back in.
    const queue = OVERLAP_POLICIES.find((descriptor) => descriptor.value === 'queue');
    expect(queue?.consequence).toContain('unbounded');
  });
});

describe('overlapConsequence', () => {
  test('resolves every known policy', () => {
    expect(overlapConsequence('skip')).toContain('dropped');
    expect(overlapConsequence('queue')).toContain('queued');
    expect(overlapConsequence('cancel-running')).toContain('cancelled');
    expect(overlapConsequence('allow')).toContain('parallelize');
  });
});
