import { describe, expect, it } from 'bun:test';

import { createMemoryGovernancePolicy } from '../../src/governance/policy';
import { retentionExpiry } from '../../src/governance/retention';

const DAY = 24 * 60 * 60 * 1000;
const rules = createMemoryGovernancePolicy({ revision: 'r' }).retention.classes;

describe('retentionExpiry (COR-806 per-class retention)', () => {
  it('expires episodic memory 90 days after its event time', () => {
    expect(retentionExpiry({ memoryClass: 'episodic', eventAt: 1000 }, rules)).toBe(
      1000 + 90 * DAY,
    );
  });

  it('keeps semantic and procedural memory until superseded, then 90 days from invalidatedAt', () => {
    for (const memoryClass of ['semantic', 'procedural'] as const) {
      expect(retentionExpiry({ memoryClass, eventAt: 1000 }, rules)).toBeUndefined();
      expect(retentionExpiry({ memoryClass, eventAt: 1000, invalidatedAt: 5000 }, rules)).toBe(
        5000 + 90 * DAY,
      );
    }
  });

  it('keeps episodic memory on its event clock after supersession', () => {
    expect(
      retentionExpiry({ memoryClass: 'episodic', eventAt: 1000, invalidatedAt: 5000 }, rules),
    ).toBe(1000 + 90 * DAY);
  });

  it('never clock-expires working, identity, or resource memory', () => {
    for (const memoryClass of ['working', 'identity', 'resource'] as const) {
      expect(
        retentionExpiry({ memoryClass, eventAt: 1000, invalidatedAt: 2000 }, rules),
      ).toBeUndefined();
    }
  });
});
