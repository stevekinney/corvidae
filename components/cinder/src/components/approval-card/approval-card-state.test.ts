import { describe, expect, test } from 'bun:test';

import {
  describeExpiry,
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
