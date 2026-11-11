/**
 * How the hook editor says what it holds (COR-2022): the hook as a sentence in the editor's words,
 * its title, the header's latest delivery, what a test event came to, and the compact summaries a
 * phone shows for a step.
 */
import { describe, expect, test } from 'bun:test';

import type { HookDelivery } from '../../lib/bureau-hooks.ts';
import { clockTime, dayLabel } from '../health/health-times.ts';
import { HOOKS_COPY } from './hook-copy.ts';
import {
  anyScopeOf,
  deliveryMoment,
  editorClause,
  editorSentence,
  editorTitle,
  latestDelivery,
  statusAnswer,
  summaryOf,
  testOutcome,
  thenSummary,
  whenSummary,
} from './hook-editor-presentation.ts';

const PAGER = 'https://events.pagerduty.com/v2/enqueue';

type Attempt = HookDelivery['attempts'][number];

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    number: 1,
    startedAt: 2_000,
    finishedAt: 2_312,
    outcome: 'response',
    status: 200,
    responseExcerpt: null,
    responseTruncated: null,
    error: null,
    ...overrides,
  };
}

function delivery(
  status: HookDelivery['status'],
  attempts: Attempt[] = [attempt()],
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
    createdAt: 2_000,
    updatedAt: 2_312,
    ...overrides,
  };
}

describe('a hook as the editor’s sentence', () => {
  test('says the clause of the event, what it covers, and what it does, with a full stop', () => {
    const hook = {
      events: ['run.error'],
      action: { type: 'webhook', url: PAGER },
      scope: null,
    } as const;
    expect(editorSentence(hook, 'workflow')).toBe(
      'When a run fails, for any workflow, send a webhook to events.pagerduty.com.',
    );
    expect(editorClause(hook, 'workflow')).toBe(
      'When a run fails, for any workflow, send a webhook to events.pagerduty.com',
    );
  });

  test('says nothing of what it covers when the events narrow by several kinds, or by none', () => {
    const hook = { events: ['run.error'], action: { type: 'notify' }, scope: null } as const;
    expect(editorSentence(hook, anyScopeOf(['agent', 'workflow', 'schedule']))).toBe(
      'When a run fails, notify me.',
    );
    expect(editorSentence(hook, anyScopeOf([]))).toBe('When a run fails, notify me.');
    expect(anyScopeOf(['agent'])).toBe('agent');
  });

  test('names the one subject it is limited to, in words', () => {
    expect(
      editorSentence(
        {
          events: ['review.requested'],
          action: { type: 'notify', title: null },
          scope: { kind: 'workflow', id: 'triage-inbox' },
        },
        'workflow',
      ),
    ).toBe('When a review is waiting, for the workflow Triage inbox, notify me.');
  });

  test('reads a workflow, a plugin’s action, and a webhook that has no address yet', () => {
    expect(
      editorSentence(
        {
          events: ['review.requested'],
          action: { type: 'start-workflow', workflowId: 'order-refund', input: 'payload' },
        },
        undefined,
      ),
    ).toBe('When a review is waiting, start the Order refund workflow.');
    expect(
      editorSentence(
        { events: ['run.error'], action: { type: 'plugin', plugin: 'pager', kind: 'page' } },
        undefined,
      ),
    ).toBe('When a run fails, run page from pager.');
    expect(
      editorSentence({ events: ['run.error'], action: { type: 'webhook', url: '' } }, undefined),
    ).toBe('When a run fails, send a webhook.');
  });

  test('titles a hook with its name, or with its sentence when it has none', () => {
    const hook = {
      events: ['run.error'],
      action: { type: 'notify', title: null },
      scope: null,
    } as const;
    expect(editorTitle({ ...hook, name: 'Page on-call' }, undefined)).toBe('Page on-call');
    expect(editorTitle({ ...hook, name: null }, undefined)).toBe('When a run fails, notify me');
  });
});

describe('a step as a phone’s one-line summary', () => {
  test('When reads the event and what it covers, and Then reads what it does', () => {
    expect(
      whenSummary({ events: ['run.error'], action: { type: 'notify', title: null } }, 'workflow'),
    ).toBe('A run fails, Any workflow');
    expect(
      whenSummary({ events: ['run.error'], action: { type: 'notify', title: null } }, undefined),
    ).toBe('A run fails');
    expect(thenSummary({ type: 'webhook', url: PAGER })).toBe(
      'Send a webhook to events.pagerduty.com',
    );
    expect(thenSummary({ type: 'notify', title: null })).toBe('Notify me');
  });
});

describe('what a receiver answered', () => {
  test('is the status with its words, or the number alone for one with no words', () => {
    expect(statusAnswer(410)).toBe('410 Gone');
    expect(statusAnswer(200)).toBe('200 OK');
    expect(statusAnswer(500)).toBe('500 Internal Server Error');
    expect(statusAnswer(299)).toBe('299');
  });
});

describe('the latest delivery in the header', () => {
  test('reads nothing for a hook that has sent nothing', () => {
    expect(latestDelivery([], 10_000)).toEqual({
      word: undefined,
      when: undefined,
      answer: undefined,
      failed: false,
    });
    expect(latestDelivery(undefined, 10_000).word).toBeUndefined();
  });

  test('reads the newest delivery: a hook that gave up is red with what answered', () => {
    const gaveUp = delivery('exhausted', [attempt({ status: 410, finishedAt: 2_100 })]);
    const older = delivery('delivered');
    const latest = latestDelivery([gaveUp, older], 2_400);
    expect(latest.word).toBe('Gave up');
    expect(latest.answer).toBe('410 Gone');
    expect(latest.failed).toBe(true);
    expect(latest.when).toBe(deliveryMoment(gaveUp.updatedAt, 2_400));
  });

  test('reads a delivered one as Delivered, and one that got no answer without a status', () => {
    expect(latestDelivery([delivery('delivered')], 2_400)).toMatchObject({
      word: 'Delivered',
      answer: '200 OK',
      failed: false,
    });
    const silent = delivery('failed', [
      attempt({ outcome: 'network-error', status: null, error: 'connect refused' }),
    ]);
    expect(latestDelivery([silent], 2_400)).toMatchObject({
      word: 'Failed',
      answer: undefined,
      failed: true,
    });
  });

  test('keeps what the list carries of a delivery: where it stands and how its last attempt ended', () => {
    const summary = summaryOf(delivery('delivered'));
    expect(summary).toEqual({
      id: 'delivery-1',
      kind: 'run.error',
      test: false,
      status: 'delivered',
      lastAttempt: {
        number: 1,
        startedAt: 2_000,
        finishedAt: 2_312,
        outcome: 'response',
        status: 200,
        error: null,
      },
      createdAt: 2_000,
      updatedAt: 2_312,
    });
    expect(summaryOf(delivery('pending', [])).lastAttempt).toBeNull();
  });
});

describe('a moment in the header', () => {
  test('is the clock for today, and the day with the clock for an older one', () => {
    const at = Date.UTC(2026, 9, 30, 17, 19);
    expect(deliveryMoment(at, at)).toBe(clockTime(at));
    const later = Date.UTC(2026, 10, 11, 12, 0);
    expect(deliveryMoment(at, later)).toBe(`${dayLabel(at)}, ${clockTime(at)}`);
    expect(deliveryMoment(at, later)).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM)$/);
  });
});

describe('what a test event came to', () => {
  const copy = HOOKS_COPY.editor.check;

  test('a delivered test names what answered and how long it took, and says a draft was not saved', () => {
    const sent = delivery('delivered', [attempt({ startedAt: 1_000, finishedAt: 1_312 })], {
      test: true,
    });
    expect(testOutcome(sent, PAGER, true)).toEqual({
      ok: true,
      text: 'Test event sent. events.pagerduty.com answered 200 OK in 312 ms.',
    });
    expect(testOutcome(sent, 'https://hooks.example.com/receive', false)).toEqual({
      ok: true,
      text: `Test event sent. hooks.example.com answered 200 OK in 312 ms. ${copy.testSentUnsaved}`,
    });
  });

  test('a test the receiver refused names the status and says to check the address', () => {
    const refused = delivery('exhausted', [attempt({ status: 410 })], { test: true });
    expect(testOutcome(refused, PAGER, true)).toEqual({
      ok: false,
      text: 'Test event failed. events.pagerduty.com answered 410 Gone. Check the URL, then send another test.',
    });
  });

  test('a test that got no answer says so', () => {
    const silent = delivery(
      'failed',
      [attempt({ outcome: 'network-error', status: null, error: 'connect refused' })],
      { test: true },
    );
    expect(testOutcome(silent, PAGER, true)).toEqual({
      ok: false,
      text: 'Test event failed. events.pagerduty.com didn’t answer. Check the URL, then send another test.',
    });
    expect(testOutcome(delivery('pending', []), PAGER, true).ok).toBe(false);
  });
});
