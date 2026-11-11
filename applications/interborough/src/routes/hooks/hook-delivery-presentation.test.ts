/**
 * How the delivery log says what one delivery holds (COR-2022, rows 84u to 84y, 85k and 86a to
 * 86c): its status word, the cause of a failure, the facts, the tries, the payload, and whether it
 * can be sent again.
 */
import { HttpClientError } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import type { HookDelivery } from '../../lib/bureau-hooks.ts';
import { ServerUnreachableError } from '../../lib/faults.ts';
import { clockTime, dayLabel } from '../health/health-times.ts';
import { HOOKS_COPY } from './hook-copy.ts';
import {
  ATTEMPTS_SHOWN,
  attemptAnswer,
  attemptList,
  deliveryCause,
  deliveryFacts,
  deliveryLogFailure,
  deliveryPayload,
  deliveryStamp,
  deliveryStatusWord,
  deliverySubject,
  nextTryWords,
  payloadFieldText,
  retryKind,
} from './hook-delivery-presentation.ts';

const COPY = HOOKS_COPY.editor.deliveries;
const PAGER = 'https://events.pagerduty.com/v2/enqueue';
const START = Date.UTC(2026, 9, 30, 17, 0);

type Attempt = HookDelivery['attempts'][number];

function attempt(number: number, overrides: Partial<Attempt> = {}): Attempt {
  return {
    number,
    startedAt: START + number * 60_000,
    finishedAt: START + number * 60_000 + 300,
    outcome: 'response',
    status: 410,
    responseExcerpt: null,
    responseTruncated: null,
    error: null,
    ...overrides,
  };
}

function delivery(
  status: HookDelivery['status'],
  attempts: Attempt[],
  overrides: Partial<HookDelivery> = {},
): HookDelivery {
  return {
    id: 'delivery-1',
    hookId: 'hook-1',
    actionType: 'webhook',
    kind: 'run.error',
    test: false,
    status,
    request: { url: PAGER, headers: {}, body: '{}' },
    attempts,
    maxAttempts: 8,
    nextAttemptAt: null,
    createdAt: START,
    updatedAt: START + 8 * 60_000,
    ...overrides,
  };
}

/** Eight tries that all met a 410 Gone: the delivery of the design's failed hook. */
function gaveUp(): HookDelivery {
  return delivery(
    'exhausted',
    Array.from({ length: 8 }, (_unused, index) => attempt(index + 1)),
  );
}

describe('a delivery’s status word', () => {
  test('says Gave up for a delivery that ran out of tries, with no qualifier', () => {
    expect(deliveryStatusWord(gaveUp())).toBe('Gave up');
  });

  test('says what the receiver answered after Delivered', () => {
    const delivered = delivery('delivered', [attempt(1, { status: 200 })]);
    expect(deliveryStatusWord(delivered)).toBe('Delivered, 200 OK');
  });

  test('says the try it is on after Retrying', () => {
    const waiting = delivery(
      'pending',
      [attempt(1, { status: 503 }), attempt(2, { status: 503 }), attempt(3, { status: 503 })],
      { nextAttemptAt: START + 40_000 },
    );
    expect(deliveryStatusWord(waiting)).toBe('Retrying, try 3 of 8');
  });

  test('says Waiting before a first try and Running while one is being sent', () => {
    expect(deliveryStatusWord(delivery('pending', []))).toBe('Waiting');
    expect(deliveryStatusWord(delivery('pending', [attempt(1, { outcome: 'sending' })]))).toBe(
      'Running',
    );
  });
});

describe('a delivery’s line', () => {
  test('says the event in words, or that it was a test', () => {
    expect(deliverySubject(gaveUp())).toBe('A run fails');
    expect(deliverySubject({ test: true, kind: 'hook.test' })).toBe(COPY.testEvent);
  });

  test('writes a moment with its weekday, the day, and the clock', () => {
    const stamp = deliveryStamp(START);
    expect(stamp).toContain(`${dayLabel(START)}, ${clockTime(START)}`);
    expect(stamp).toMatch(/^[A-Z][a-z]{2} /);
  });
});

describe('the cause of a failed delivery', () => {
  test('names the receiver, the answer on every try, and what to do', () => {
    expect(deliveryCause(gaveUp())).toBe(
      'events.pagerduty.com answered 410 Gone on all 8 tries, so Interborough stopped. The webhook URL may have been removed. Check the URL, then retry.',
    );
  });

  test('names the last answer when the tries did not all end the same way', () => {
    const mixed = delivery('exhausted', [attempt(1, { status: 502 }), attempt(2, { status: 503 })]);
    expect(deliveryCause(mixed)).toBe(
      'events.pagerduty.com answered 503 Service Unavailable on its last of 2 tries, so Interborough stopped. Check the receiver, then retry.',
    );
  });

  test('says the receiver did not answer when no try got an answer', () => {
    const silent = delivery('exhausted', [
      attempt(1, { outcome: 'network-error', status: null, error: 'connect refused' }),
      attempt(2, { outcome: 'network-error', status: null, error: 'connect refused' }),
    ]);
    expect(deliveryCause(silent)).toBe(
      'events.pagerduty.com didn’t answer any of the 2 tries, so Interborough stopped. Check the receiver, then retry.',
    );
  });

  test('points at the signing secret for a refused signature, and says the secret was missing for failed-secret', () => {
    const refused = delivery('exhausted', [attempt(1, { status: 401 })]);
    expect(deliveryCause(refused)).toContain(COPY.cause.hintSignature);
    expect(deliveryCause(delivery('failed-secret', []))).toBe(COPY.cause.secretMissing);
  });

  test('says nothing for a delivery that arrived or is still going, and says why one was stopped', () => {
    expect(deliveryCause(delivery('delivered', [attempt(1, { status: 200 })]))).toBeUndefined();
    expect(deliveryCause(delivery('pending', []))).toBeUndefined();
    expect(deliveryCause(delivery('aborted', []))).toBe(HOOKS_COPY.attempt.aborted);
  });

  test('names a delivery with no request by "The receiver"', () => {
    const noRequest = delivery('exhausted', [attempt(1, { status: 500 })], {
      actionType: 'notify',
      request: null,
    });
    expect(deliveryCause(noRequest)?.startsWith('The receiver answered 500')).toBe(true);
  });
});

describe('the facts of an open delivery', () => {
  test('are the event with its kind, where it went, and the last answer with its time', () => {
    const facts = deliveryFacts(gaveUp());
    expect(facts.map((fact) => fact.label)).toEqual(['Event', 'Sent to', 'Last response']);
    expect(facts[0]).toEqual({ label: 'Event', value: 'A run fails', code: 'run.error' });
    expect(facts[1]?.value).toBe('events.pagerduty.com');
    expect(facts[2]?.value).toBe(`410 Gone, ${deliveryStamp(START + 8 * 60_000 + 300)}`);
    expect(facts.map((fact) => fact.value).join('')).not.toContain(String.fromCodePoint(0xb7));
  });

  test('call a test event a test event and leave out the last answer of a try still being sent', () => {
    const sending = delivery('pending', [attempt(1, { outcome: 'sending' })], { test: true });
    expect(deliveryFacts(sending).map((fact) => fact.label)).toEqual(['Event', 'Sent to']);
    expect(deliveryFacts(sending)[0]?.value).toBe(COPY.testEvent);
  });
});

describe('the tries of a delivery', () => {
  test('lists the first three and folds the rest, saying how they all ended', () => {
    const list = attemptList(gaveUp(), false);
    expect(list.shown.map((shown) => shown.number)).toEqual([1, 2, 3]);
    expect(list.folded).toBe('5 more tries, all 410 Gone.');
    expect(ATTEMPTS_SHOWN).toBe(3);
  });

  test('says only how many are folded when they did not all end the same way', () => {
    const attempts = [1, 2, 3, 4, 5].map((number) =>
      attempt(number, { status: number === 5 ? 500 : 410 }),
    );
    expect(attemptList(delivery('exhausted', attempts), false).folded).toBe('2 more tries.');
  });

  test('lists every try once all are asked for, and folds nothing from a short list', () => {
    expect(attemptList(gaveUp(), true)).toEqual({ shown: gaveUp().attempts, folded: undefined });
    const short = attemptList(delivery('delivered', [attempt(1, { status: 200 })]), false);
    expect(short.folded).toBeUndefined();
  });

  test('writes a try’s answer short', () => {
    expect(attemptAnswer(attempt(1))).toBe('410 Gone');
    expect(attemptAnswer(attempt(1, { outcome: 'network-error', status: null }))).toBe(
      COPY.answer.noAnswer,
    );
    expect(attemptAnswer(attempt(1, { outcome: 'refused', status: null }))).toBe(
      COPY.answer.refused,
    );
  });
});

describe('sending a delivery again', () => {
  test('offers Retry delivery for one that failed and Retry now for one waiting on its next try', () => {
    expect(retryKind(gaveUp())).toBe('retry');
    expect(retryKind(delivery('failed', [attempt(1)]))).toBe('retry');
    const waiting = delivery('pending', [attempt(1, { status: 503 })], {
      nextAttemptAt: START + 40_000,
    });
    expect(retryKind(waiting)).toBe('retry-now');
  });

  test('offers nothing for a delivered, stopped or mid-send delivery, or one with no try due', () => {
    expect(retryKind(delivery('delivered', [attempt(1, { status: 200 })]))).toBeUndefined();
    expect(retryKind(delivery('aborted', []))).toBeUndefined();
    expect(retryKind(delivery('pending', [attempt(1, { status: 503 })]))).toBeUndefined();
    const sending = delivery('pending', [attempt(1, { outcome: 'sending' })], {
      nextAttemptAt: START,
    });
    expect(retryKind(sending)).toBeUndefined();
  });

  test('says how long until the next try, in words', () => {
    expect(nextTryWords(START + 40_000, START)).toBe('40 seconds');
    expect(nextTryWords(START + 1_000, START)).toBe('1 second');
    expect(nextTryWords(START + 5 * 60_000, START)).toBe('5 minutes');
    expect(nextTryWords(START + 3 * 3_600_000, START)).toBe('3 hours');
    expect(nextTryWords(START - 5_000, START)).toBe(COPY.nextTryDue);
  });
});

describe('the payload a delivery sent', () => {
  const body = (value: unknown) => JSON.stringify(value);

  test('is the event and the fields of the envelope’s payload', () => {
    const sent = delivery('delivered', [attempt(1, { status: 200 })], {
      request: {
        url: PAGER,
        headers: {},
        body: body({ id: 'x', kind: 'run.error', payload: { runId: 'run-1', step: 2 } }),
      },
    });
    expect(deliveryPayload(sent)).toEqual({
      kind: 'fields',
      value: { event: 'run.error', runId: 'run-1', step: 2 },
    });
  });

  test('is the event alone when the envelope carries no fields', () => {
    const sent = delivery('delivered', [], {
      request: { url: PAGER, headers: {}, body: body({ kind: 'hook.test', payload: {} }) },
    });
    expect(deliveryPayload(sent)).toEqual({ kind: 'fields', value: { event: 'hook.test' } });
  });

  test('is a body that is not an envelope as it is, a body that is not JSON as text, and none without a request', () => {
    const plain = delivery('delivered', [], {
      request: { url: PAGER, headers: {}, body: body({ hello: 'world' }) },
    });
    expect(deliveryPayload(plain)).toEqual({ kind: 'fields', value: { hello: 'world' } });
    const text = delivery('delivered', [], {
      request: { url: PAGER, headers: {}, body: 'not json' },
    });
    expect(deliveryPayload(text)).toEqual({ kind: 'text', value: 'not json' });
    expect(deliveryPayload(delivery('delivered', [], { request: null }))).toEqual({
      kind: 'none',
    });
  });

  test('writes the event field as its words and kind, and leaves every other field alone', () => {
    expect(payloadFieldText(['event'], 'run.error')).toBe('A run fails (run.error)');
    expect(payloadFieldText(['runId'], 'run-1')).toBeUndefined();
    expect(payloadFieldText(['payload', 'event'], 'run.error')).toBeUndefined();
  });
});

describe('a delivery log that could not be read', () => {
  test('says the status the server answered with, and that the hook is unchanged', () => {
    expect(deliveryLogFailure(new HttpClientError(500, 'It broke.'))).toBe(
      'The server answered with an error (500). The hook itself is unchanged.',
    );
    expect(deliveryLogFailure(new ServerUnreachableError())).toBe(COPY.loadFailed.noAnswer);
    expect(deliveryLogFailure(new Error('odd'))).toBe(COPY.loadFailed.unknown);
  });
});
