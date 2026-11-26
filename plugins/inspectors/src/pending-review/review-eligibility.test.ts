import { expect, test } from 'bun:test';
import { readReviewEligibility } from './review-eligibility.ts';

test('only accepts own identifiers with a valid nonnegative round', () => {
  expect([
    ...readReviewEligibility([
      { id: 'review', round: 2 },
      { id: '', round: 0 },
      { id: 'negative', round: -1 },
      { id: 'fraction', round: 1.5 },
      { id: 'missing' },
      Object.create({ id: 'inherited', round: 1 }),
    ]),
  ]).toEqual([['review', 2]]);
  expect(readReviewEligibility({ id: 'review', round: 2 }).size).toBe(0);
});
