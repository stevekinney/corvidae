import { describe, expect, test } from 'bun:test';

import {
  MalformedDeadLetterError,
  MalformedTaskDeliveriesError,
  parseDeadLetter,
  parseTaskDeliveries,
  presentDelivery,
  type TaskDelivery,
} from './task-delivery-evidence.ts';

const NOW = 1_700_000_000_000;

const ACKNOWLEDGED: TaskDelivery = {
  outcome: 'acknowledged',
  disposition: 'applied',
  attempt: 1,
  attemptTokenDigest: 'sha256:t1',
  transport: 'webSocket',
  workerId: 'worker-a',
  submittedStatus: 'completed',
  receivedAt: NOW,
};

const REJECTED: TaskDelivery = {
  outcome: 'rejected',
  rejectionCode: 'stale-attempt',
  reason: 'attempt 2 owns the task',
  attemptTokenDigest: 'sha256:t0',
  transport: 'longPoll',
  submittedStatus: 'failed',
  receivedAt: NOW - 1_000,
};

const DELIVERIES = {
  operationId: 'op_1',
  deliveries: [REJECTED, ACKNOWLEDGED],
  historyLimit: 20,
  droppedCount: 0,
};

describe('parseTaskDeliveries', () => {
  test('accepts acknowledged and rejected deliveries', () => {
    expect(parseTaskDeliveries(DELIVERIES).deliveries).toHaveLength(2);
    expect(parseTaskDeliveries({ ...DELIVERIES, deliveries: [] }).deliveries).toEqual([]);
  });

  test.each([
    ['not an object', null],
    ['missing deliveries', { ...DELIVERIES, deliveries: undefined }],
    [
      'a delivery with an unknown outcome',
      { ...DELIVERIES, deliveries: [{ ...ACKNOWLEDGED, outcome: 'lost' }] },
    ],
    [
      'an acknowledgement with an unknown disposition',
      { ...DELIVERIES, deliveries: [{ ...ACKNOWLEDGED, disposition: 'ignored' }] },
    ],
    [
      'a rejection with an unknown code',
      { ...DELIVERIES, deliveries: [{ ...REJECTED, rejectionCode: 'nope' }] },
    ],
    [
      'a rejection with no reason',
      { ...DELIVERIES, deliveries: [{ ...REJECTED, reason: undefined }] },
    ],
    [
      'an unknown transport',
      { ...DELIVERIES, deliveries: [{ ...ACKNOWLEDGED, transport: 'carrier-pigeon' }] },
    ],
    [
      'an unrepresentable instant',
      { ...DELIVERIES, deliveries: [{ ...ACKNOWLEDGED, receivedAt: 1e20 }] },
    ],
    ['a negative dropped count', { ...DELIVERIES, droppedCount: -1 }],
  ])('rejects %s', (_name, value) => {
    expect(() => parseTaskDeliveries(value)).toThrow(MalformedTaskDeliveriesError);
  });
});

describe('presentDelivery', () => {
  test('spells out every outcome in text', () => {
    expect(presentDelivery(ACKNOWLEDGED)).toMatchObject({
      label: 'Acknowledged · applied',
      variant: 'success',
    });
    expect(presentDelivery({ ...ACKNOWLEDGED, disposition: 'duplicate' }).label).toBe(
      'Acknowledged · duplicate',
    );
    expect(presentDelivery({ ...ACKNOWLEDGED, disposition: 'dead-lettered' })).toMatchObject({
      label: 'Acknowledged · dead-lettered',
      variant: 'danger',
    });
    expect(presentDelivery(REJECTED)).toMatchObject({
      label: 'Rejected · stale-attempt',
      variant: 'danger',
    });
    expect(presentDelivery(REJECTED).explanation).toContain('newer attempt');
  });

  test.each([
    'worker-mismatch',
    'attempt-token-mismatch',
    'queue-mismatch',
    'revision-mismatch',
    'conflicting-content',
    'commit-rejected',
  ] as const)('explains the %s rejection', (rejectionCode) => {
    const presentation = presentDelivery({ ...REJECTED, rejectionCode });
    expect(presentation.label).toBe(`Rejected · ${rejectionCode}`);
    expect(presentation.explanation.length).toBeGreaterThan(20);
  });
});

describe('parseDeadLetter', () => {
  const RECORD = {
    operationId: 'op_1',
    workflowType: 'orders',
    activityName: 'charge',
    queue: 'payments',
    attempt: 2,
    attemptTokenDigest: 'sha256:t2',
    pendingStatus: 'completed',
    resultDigest: 'sha256:result',
    deadLetteredAt: NOW,
    persistenceFailureReason: 'storage exhausted',
    payload: { kind: 'value', value: { total: 7 }, serializedBytes: 11 },
  };

  test('accepts each payload kind', () => {
    expect(parseDeadLetter(RECORD).payload.kind).toBe('value');
    expect(parseDeadLetter({ ...RECORD, payload: { kind: 'absent' } }).payload.kind).toBe('absent');
    expect(
      parseDeadLetter({
        ...RECORD,
        payload: {
          kind: 'omitted',
          reason: 'exceeds-max-bytes',
          serializedBytes: 90_000,
          maxBytes: 65_536,
        },
      }).payload.kind,
    ).toBe('omitted');
  });

  test.each([
    ['not an object', 'dead'],
    ['an unknown payload kind', { ...RECORD, payload: { kind: 'redacted' } }],
    [
      'an omitted payload without sizes',
      { ...RECORD, payload: { kind: 'omitted', reason: 'exceeds-max-bytes' } },
    ],
    ['an unknown result status', { ...RECORD, pendingStatus: 'cancelled' }],
    ['a missing digest', { ...RECORD, resultDigest: undefined }],
  ])('rejects %s', (_name, value) => {
    expect(() => parseDeadLetter(value)).toThrow(MalformedDeadLetterError);
  });
});
