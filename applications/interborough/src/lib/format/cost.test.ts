import { describe, expect, it } from 'bun:test';

import { attemptsCost, formatAttemptsCost, formatCost } from './cost.ts';

const attempt = (costUsd: number | null) => ({ usage: { costUsd } });

describe('formatCost', () => {
  it('AC5: says an amount under one cent as `< $0.01`', () => {
    expect(formatCost(0.004)).toBe('< $0.01');
    expect(formatCost(0.009_999)).toBe('< $0.01');
    expect(formatCost(0.000_000_1)).toBe('< $0.01');
  });

  it('AC5: says any other amount in dollars with two decimals', () => {
    expect(formatCost(0.01)).toBe('$0.01');
    expect(formatCost(0.1)).toBe('$0.10');
    expect(formatCost(0.1234)).toBe('$0.12');
    expect(formatCost(2)).toBe('$2.00');
    expect(formatCost(1204.5)).toBe('$1,204.50');
  });

  it('AC4: has no words for a run with no cost, never `$0.00`', () => {
    expect(formatCost(null)).toBeUndefined();
    expect(formatCost(undefined)).toBeUndefined();
    expect(formatCost(Number.NaN)).toBeUndefined();
    expect(formatCost(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(formatCost(-1)).toBeUndefined();
    for (const amount of [0, 0.001, 0.01, 12]) expect(formatCost(amount)).not.toBe('$0.00');
  });
});

describe('a goal’s cost from its attempts', () => {
  it('AC3: is the sum when every attempt has a cost', () => {
    const cost = attemptsCost([attempt(0.5), attempt(0.25)]);
    expect(cost).toEqual({ costUsd: 0.75, partial: false });
    expect(formatAttemptsCost(cost)).toBe('$0.75');
  });

  it('AC3: is the sum of the attempts that have one, marked partial, when some have none', () => {
    const cost = attemptsCost([attempt(0.5), attempt(null), attempt(0.25)]);
    expect(cost).toEqual({ costUsd: 0.75, partial: true });
    expect(formatAttemptsCost(cost)).toBe('At least $0.75');
  });

  it('AC3: has no value when no attempt has a cost, or the goal made none', () => {
    expect(attemptsCost([attempt(null), attempt(null)])).toBeNull();
    expect(attemptsCost([])).toBeNull();
    expect(formatAttemptsCost(attemptsCost([attempt(null)]))).toBeUndefined();
  });

  it('says a partial sum under one cent as a floor too', () => {
    expect(formatAttemptsCost(attemptsCost([attempt(0.001), attempt(null)]))).toBe(
      'At least < $0.01',
    );
  });
});
