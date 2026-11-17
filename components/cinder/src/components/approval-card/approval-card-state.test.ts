import { describe, expect, test } from 'bun:test';

import {
  describeCountdown,
  describeDecisionTime,
  describeExpiry,
  formatRemainingTime,
  RISK_WORDS,
  STATE_DOT_STATUS,
  STATE_LABELS,
  summarizeInput,
} from './approval-card-state.ts';

describe('approval card vocabulary', () => {
  test('reads risk as Reads, Changes things and Dangerous', () => {
    expect(RISK_WORDS).toEqual({ low: 'Reads', medium: 'Changes things', high: 'Dangerous' });
  });

  test('an unavailable approval reads as a neutral word', () => {
    expect(STATE_LABELS.unavailable).toBe('Unavailable');
    expect(STATE_DOT_STATUS.unavailable).toBe('neutral');
  });
});

describe('summarizeInput', () => {
  test('writes sentence-case labels and values as text', () => {
    expect(summarizeInput({ orderId: 4471, amount: '$42.00', reason: 'Arrived damaged' })).toEqual([
      { key: 'orderId', label: 'Order ID', text: '4471', muted: false },
      { key: 'amount', label: 'Amount', text: '$42.00', muted: false },
      { key: 'reason', label: 'Reason', text: 'Arrived damaged', muted: false },
    ]);
  });

  test('reads serialized JSON the same as an object', () => {
    expect(summarizeInput('{"shippedOn":"2026-10-24","insured":true}')).toEqual([
      { key: 'shippedOn', label: 'Shipped on', text: 'Oct 24, 2026', muted: false },
      { key: 'insured', label: 'Insured', text: 'Yes', muted: false },
    ]);
  });

  test('writes null and empty text as muted stand-ins', () => {
    expect(summarizeInput({ coupon: null, giftNote: '' })).toEqual([
      { key: 'coupon', label: 'Coupon', text: 'None', muted: true },
      { key: 'giftNote', label: 'Gift note', text: 'Empty', muted: true },
    ]);
  });

  test('counts a nested value instead of spilling it onto the line', () => {
    expect(summarizeInput({ notify: { email: 'a@b.c', slack: '#x' }, tags: ['a'] })).toEqual([
      { key: 'notify', label: 'Notify', text: '2 fields', muted: false },
      { key: 'tags', label: 'Tags', text: '1 item', muted: false },
    ]);
  });

  test('never writes a secret', () => {
    const [pair] = summarizeInput({ apiToken: 'sk-live-123' });

    expect(pair?.label).toBe('API token');
    expect(pair?.text).not.toContain('sk-live-123');
  });

  test('keeps distinct keys apart when they humanize to one label', () => {
    const pairs = summarizeInput({ orderId: 4471, order_id: 4472, OrderId: 4473 });

    expect(pairs.map((pair) => pair.label)).toEqual(['Order ID', 'Order ID', 'Order ID']);
    expect(new Set(pairs.map((pair) => pair.key)).size).toBe(3);
  });

  test('has no pairs for anything but an object', () => {
    expect(summarizeInput('--force')).toEqual([]);
    expect(summarizeInput(undefined)).toEqual([]);
    expect(summarizeInput(['a'])).toEqual([{ key: '1', label: '1', text: 'a', muted: false }]);
  });
});

describe('describeExpiry', () => {
  test('says when the approval expired, with the time zone, in one sentence', () => {
    expect(describeExpiry(Date.parse('2026-11-02T10:15:00.000Z'))).toMatch(
      /^This approval expired at 10:15 AM \w+, the time its request set\.$/,
    );
  });
});

describe('describeDecisionTime', () => {
  const now = new Date('2026-11-02T12:00:00.000Z');

  test('says today for a decision made on the same day', () => {
    expect(describeDecisionTime(new Date('2026-11-02T10:33:00.000Z'), now)).toBe('10:33 AM today');
  });

  test('says yesterday for the day before', () => {
    expect(describeDecisionTime(new Date('2026-11-01T16:12:00.000Z'), now)).toBe(
      '4:12 PM yesterday',
    );
  });

  test('names the day for anything older', () => {
    expect(describeDecisionTime(new Date('2026-10-28T09:05:00.000Z'), now)).toBe(
      '9:05 AM on Wed Oct 28',
    );
  });
});

// C#12 (chat stress sweep): the hour count had no upper bound, so a far deadline read
// "Expires in 8521807h 14m".
describe('the approval countdown', () => {
  const now = Date.parse('2026-11-11T15:00:00.000Z');
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;

  test('counts minutes and seconds under an hour, and seconds under a minute', () => {
    expect(formatRemainingTime(4 * MINUTE + 10_000)).toBe('4m 10s');
    expect(formatRemainingTime(45_000)).toBe('45s');
    expect(describeCountdown(now + 4 * MINUTE + 10_000, now)).toBe('Expires in 4m 10s');
  });

  test('counts whole hours, rounded down, from an hour up to a day', () => {
    expect(describeCountdown(now + 3 * HOUR + 59 * MINUTE, now)).toBe('Expires in 3 h');
    expect(describeCountdown(now + 24 * HOUR, now)).toBe('Expires in 24 h');
  });

  test('names the deadline when it is more than a day out', () => {
    expect(describeCountdown(Date.parse('2026-11-12T18:30:00.000Z'), now)).toBe(
      'Expires tomorrow, 6:30 PM',
    );
    expect(describeCountdown(Date.parse('2026-11-20T09:30:00.000Z'), now)).toMatch(
      /^Expires \w{3} Nov 20, 9:30 AM$/,
    );
    const far = describeCountdown(now + 8_521_807 * HOUR, now);
    expect(far).not.toContain(' h');
    expect(far).toMatch(/^Expires /);
  });
});
