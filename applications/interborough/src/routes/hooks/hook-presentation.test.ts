/**
 * How the hooks pages say what the Bureau holds (COR-1858): an event in plain words and its area,
 * the events an action may not listen to, a hook as a sentence, and what a delivery came to.
 */
import { describe, expect, test } from 'bun:test';

import type { Hook, HookDelivery, HookEventKind } from '../../lib/bureau-hooks.ts';
import { HOOKS_COPY } from './hook-copy.ts';
import {
  deliveryFailed,
  deliveryLine,
  deliveryWord,
  eventArea,
  eventChoices,
  eventMatches,
  eventPhrase,
  eventRefusal,
  eventWords,
  failingFirst,
  hookMatches,
  hookSentence,
  onlyForWords,
  scopeKindsFor,
  scopePath,
} from './hook-presentation.ts';

const KINDS: HookEventKind[] = [
  {
    kind: 'review.requested',
    origin: 'run',
    description: 'A person is asked to decide.',
    scopes: ['agent', 'workflow', 'schedule'],
  },
  {
    kind: 'notification.created',
    origin: 'unattributed',
    description: 'A notification exists.',
    scopes: [],
  },
  {
    kind: 'schedule.missed',
    origin: 'external',
    description: 'A fire did not happen.',
    scopes: ['agent', 'workflow', 'schedule'],
  },
  {
    kind: 'session.created',
    origin: 'unattributed',
    description: 'A chat started.',
    scopes: ['agent'],
  },
];

function hook(overrides: Partial<Hook> = {}): Hook {
  return {
    id: 'hook-1',
    owner: 'anonymous:local',
    name: null,
    action: { type: 'webhook', url: 'https://example.com/a' },
    events: ['review.requested'],
    scope: null,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    ...overrides,
  };
}

function delivery(overrides: Partial<HookDelivery> = {}): HookDelivery {
  return {
    id: 'd',
    hookId: 'hook-1',
    actionType: 'webhook',
    kind: 'review.requested',
    test: false,
    status: 'delivered',
    request: { url: 'https://example.com/a' },
    attempts: [],
    maxAttempts: 5,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const attempt = (overrides: Partial<HookDelivery['attempts'][number]>) => ({
  number: 1,
  startedAt: 1,
  finishedAt: 2,
  outcome: 'response' as const,
  status: null,
  responseExcerpt: null,
  responseTruncated: null,
  error: null,
  ...overrides,
});

describe('an event in plain words', () => {
  test('reads a kind as a sentence, and names a chat a chat', () => {
    expect(eventWords('goal.attempt.started')).toBe('Goal attempt started');
    expect(eventWords('run.abort-settled')).toBe('Run abort settled');
    expect(eventWords('session.created')).toBe('Chat created');
    expect(eventWords('diagnostic')).toBe('Diagnostic');
  });

  test('is grouped by area, and a family it has no name for is Other', () => {
    expect(eventArea('review.requested')).toBe('Reviews');
    expect(eventArea('session.saved')).toBe('Chats');
    expect(eventArea('steering.accepted')).toBe('Chats');
    expect(eventArea('somethingnew.happened')).toBe('Other');
    // A family named like a property of every object is not an area.
    expect(eventArea('constructor.happened')).toBe('Other');
    expect(eventArea('__proto__.happened')).toBe('Other');
  });

  test('is offered with its raw kind beside it, sorted into its area', () => {
    const choices = eventChoices(KINDS, 'webhook');
    expect(choices.map((choice) => choice.group)).toEqual([
      'Chats',
      'Notifications',
      'Reviews',
      'Schedules',
    ]);
    expect(choices.find((choice) => choice.value === 'review.requested')).toEqual({
      value: 'review.requested',
      label: 'Review requested',
      description: 'review.requested',
      group: 'Reviews',
      disabled: false,
    });
  });
});

describe('the events an action may not listen to', () => {
  test('a notification hook may not listen to the event its own notification raises', () => {
    expect(eventRefusal('notify', KINDS[1]!)).toBeDefined();
    expect(eventRefusal('notify', KINDS[0]!)).toBeUndefined();
    expect(
      eventChoices(KINDS, 'notify').find((c) => c.value === 'notification.created'),
    ).toMatchObject({
      disabled: true,
    });
  });

  test('a workflow hook may listen only to events a run names or that no run can cause', () => {
    const disabled = eventChoices(KINDS, 'start-workflow')
      .filter((choice) => choice.disabled)
      .map((choice) => choice.value)
      .toSorted();
    expect(disabled).toEqual(['notification.created', 'session.created']);
    expect(eventRefusal('webhook', KINDS[1]!)).toBeUndefined();
  });
});

describe('searching the events', () => {
  const meanings = new Map(KINDS.map((kind) => [kind.kind, kind.description]));
  const choice = eventChoices(KINDS, 'webhook').find((c) => c.value === 'schedule.missed')!;

  test.each([
    ['the words', 'schedule missed'],
    ['the raw kind', 'schedule.missed'],
    ['the area', 'schedules'],
    ['what the event means', 'did not happen'],
    ['nothing at all', ''],
  ])('matches by %s', (_name, query) => {
    expect(eventMatches(choice, query, meanings)).toBe(true);
  });

  test('requires every word typed, in any order', () => {
    expect(eventMatches(choice, 'missed fire', meanings)).toBe(true);
    expect(eventMatches(choice, 'missed nonsense', meanings)).toBe(false);
  });
});

describe('a hook as a sentence', () => {
  test('names one event, two joined by or, or the first and how many more', () => {
    expect(eventPhrase(['review.requested'])).toBe('Review requested');
    expect(eventPhrase(['review.requested', 'goal.failed'])).toBe(
      'Review requested or Goal failed',
    );
    expect(eventPhrase(['review.requested', 'goal.failed', 'goal.canceled'])).toBe(
      'Review requested or 2 more',
    );
    expect(eventPhrase([])).toBe('no event is chosen');
  });

  test('ends with what the hook does', () => {
    expect(hookSentence(hook())).toBe(
      'When Review requested, send a signed message to https://example.com/a',
    );
    expect(
      hookSentence(
        hook({ action: { type: 'start-workflow', workflowId: 'digest', input: 'payload' } }),
      ),
    ).toBe('When Review requested, start the workflow digest');
    expect(hookSentence(hook({ action: { type: 'notify', title: null } }))).toBe(
      'When Review requested, notify me',
    );
    expect(hookSentence(hook({ action: { type: 'plugin', plugin: 'acme', kind: 'page' } }))).toBe(
      'When Review requested, run page from acme',
    );
  });

  test('reads a hook that is not finished', () => {
    expect(hookSentence({ events: [], action: { type: 'webhook', url: '' } })).toBe(
      'When no event is chosen, send a signed message',
    );
    expect(
      hookSentence({ events: ['goal.failed'], action: { type: 'start-workflow', workflowId: '' } }),
    ).toBe('When Goal failed, start a workflow');
  });

  test('is found by its words, its name and its event kinds', () => {
    const named = hook({ name: 'Page the team' });
    expect(hookMatches(named, 'page team')).toBe(true);
    expect(hookMatches(named, 'review.requested')).toBe(true);
    expect(hookMatches(named, 'example.com')).toBe(true);
    expect(hookMatches(named, 'nothing like it')).toBe(false);
    expect(hookMatches(named, '  ')).toBe(true);
  });
});

describe('what a delivery came to', () => {
  test('reads each status as one of the shared words', () => {
    expect(deliveryWord('delivered')).toBe('Done');
    expect(deliveryWord('pending')).toBe('Running');
    expect(deliveryWord('aborted')).toBe('Canceled');
    for (const status of ['exhausted', 'failed', 'failed-secret'] as const) {
      expect(deliveryWord(status)).toBe('Failed');
    }
  });

  test('calls a hook failing only when its last delivery ended in failure', () => {
    expect(deliveryFailed(null)).toBe(false);
    expect(deliveryFailed(delivery({ status: 'delivered' }))).toBe(false);
    expect(deliveryFailed(delivery({ status: 'pending' }))).toBe(false);
    expect(deliveryFailed(delivery({ status: 'exhausted' }))).toBe(true);
  });

  test.each([
    [
      'an answer',
      { status: 'delivered' as const, attempts: [attempt({ status: 200 })] },
      'Answered 200',
    ],
    [
      'no answer',
      {
        status: 'exhausted' as const,
        attempts: [attempt({ outcome: 'network-error', error: 'connect refused' })],
      },
      'No answer: connect refused',
    ],
    [
      'a refused address',
      { status: 'failed' as const, attempts: [attempt({ outcome: 'refused', error: 'private' })] },
      'The address was refused: private',
    ],
    [
      'an interrupted attempt',
      { status: 'pending' as const, attempts: [attempt({ outcome: 'interrupted' })] },
      'Stopped before an answer came',
    ],
    [
      'an attempt in flight',
      { status: 'pending' as const, attempts: [attempt({ outcome: 'sending' })] },
      'Sending',
    ],
    [
      'a delivery with no attempt',
      { status: 'pending' as const, attempts: [] },
      'Waiting for the first attempt',
    ],
    [
      'a missing secret',
      { status: 'failed-secret' as const, attempts: [] },
      'The signing secret could not be read',
    ],
    [
      'a stopped delivery',
      { status: 'aborted' as const, attempts: [attempt({ outcome: 'sending' })] },
      'Stopped: the hook was turned off or deleted',
    ],
    [
      'an action that failed',
      {
        status: 'failed' as const,
        attempts: [attempt({ outcome: 'rejected', error: 'bad input' })],
      },
      'Failed: bad input',
    ],
  ])('says %s in a line', (_name, input, line) => {
    expect(deliveryLine(delivery(input))).toBe(line);
  });
});

describe('the failing hooks first', () => {
  test('keeps the order within each group', () => {
    expect(failingFirst([1, 2, 3, 4, 5], (n) => n % 2 === 0)).toEqual([2, 4, 1, 3, 5]);
    expect(failingFirst([], () => true)).toEqual([]);
  });
});

describe('what a hook is limited to', () => {
  const kinds = [
    { kind: 'review.requested', scopes: ['agent', 'workflow', 'schedule'] },
    { kind: 'session.created', scopes: ['agent'] },
    { kind: 'diagnostic', scopes: [] },
  ] as const;
  const offered = (events: readonly string[]) =>
    scopeKindsFor(
      events,
      kinds.map((entry) => ({ kind: entry.kind, scopes: [...entry.scopes] })),
    );

  test('offers only what every chosen event can be told by', () => {
    expect(offered([])).toEqual([]);
    expect(offered(['review.requested'])).toEqual(['agent', 'workflow', 'schedule']);
    expect(offered(['review.requested', 'session.created'])).toEqual(['agent']);
    expect(offered(['review.requested', 'diagnostic'])).toEqual([]);
    expect(offered(['an.event.the.catalog.does.not.describe'])).toEqual([]);
  });

  test('reads a hook’s Only for, and links a subject the page knows', () => {
    expect(onlyForWords(null)).toBe(HOOKS_COPY.onlyFor.everything);
    expect(onlyForWords({ kind: 'schedule', id: 'nightly' })).toBe('Schedule nightly');
    expect(onlyForWords({ kind: 'team', id: 'blue' })).toBe('team blue');
    expect(scopePath({ kind: 'agent', id: 'scout' })).toContain('/agents/scout');
    expect(scopePath({ kind: 'workflow', id: 'nightly' })).toContain('nightly');
    expect(scopePath({ kind: 'schedule', id: 'nightly' })).toContain('nightly');
    expect(scopePath({ kind: 'team', id: 'blue' })).toBeUndefined();
  });

  test('says it in the sentence, after the events', () => {
    const sentence = hookSentence({
      events: ['review.requested'],
      action: { type: 'notify' },
      scope: { kind: 'team', id: 'blue' },
    });
    expect(sentence).toBe('When Review requested for the team blue, notify me');
  });

  test('reads a summary’s last attempt as it reads a delivery’s', () => {
    const summary = {
      id: 'delivery-1',
      kind: 'review.requested',
      test: false,
      status: 'exhausted' as const,
      lastAttempt: null,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(deliveryLine(summary)).toBe(HOOKS_COPY.attempt.notStarted);
  });
});
