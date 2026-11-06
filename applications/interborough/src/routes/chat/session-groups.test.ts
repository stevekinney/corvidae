import { describe, expect, test } from 'bun:test';

import type { ChatContext } from '../../lib/bureau-client.ts';
import { contextFixture } from '../../lib/bureau-fixtures.test-support.ts';
import type { BureauReview } from '../../lib/bureau-reviews.ts';
import {
  agentAvatarName,
  agentTone,
  chatDayGroup,
  chatListRows,
  chatStatusWord,
  inSegment,
  matchingRows,
  pendingQuestions,
  segmentCounts,
  sessionRow,
  type SessionRow,
  waitingChatIds,
} from './session-groups.ts';

const context: ChatContext = {
  id: 'session-1',
  owner: 'anonymous:local',
  agentName: 'assistant',
  title: 'Plan the week',
  lastMessagePreview: 'Sounds good.',
  parentContextId: null,
  forkedFromMessageId: null,
  origin: 'chat',
  messageCount: 4,
  createdAt: '2026-10-19T08:00:00.000Z',
  updatedAt: '2026-10-19T09:00:00.000Z',
  activity: 'idle',
};

const humanWait = (
  sessionId: string | undefined,
  prompt: string | undefined,
  requestedAt = 1,
): BureauReview => ({
  source: 'bureau',
  id: `review-${requestedAt}`,
  runId: 'run',
  kind: 'human-wait',
  ...(sessionId === undefined ? {} : { sessionId }),
  signalName: 'environment',
  ...(prompt === undefined ? {} : { prompt }),
  requestedAt,
  ageMilliseconds: 0,
  status: 'pending',
});

const approval = (
  sessionId: string,
  message: string | undefined,
  requestedAt = 1,
): BureauReview => ({
  source: 'bureau',
  id: `approval-${requestedAt}`,
  runId: 'run',
  kind: 'tool-approval',
  sessionId,
  round: 0,
  approval: {
    callId: 'call',
    toolName: 'issue-refund',
    arguments: { orderId: 'order-1001' },
    action: {
      type: 'approval',
      risk: 'high',
      operation: { kind: 'tool' },
      ...(message === undefined ? {} : { message }),
    },
  },
  requestedAt,
  ageMilliseconds: 0,
  status: 'pending',
});

describe('the question a waiting chat asks', () => {
  test('is an approval’s own sentence, the call when it has none, or a question’s prompt', () => {
    const questions = pendingQuestions([
      approval('a', 'Refund order order-1001 for $42.00'),
      approval('b', undefined),
      humanWait('c', 'Which environment?'),
    ]);

    expect(questions.get('a')).toBe('Refund order order-1001 for $42.00?');
    expect(questions.get('b')).toBe('Run issue-refund with orderId order-1001?');
    expect(questions.get('c')).toBe('Which environment?');
  });

  test('is the oldest pending review of a chat, and ignores a settled one and one with no session', () => {
    const questions = pendingQuestions([
      humanWait('a', 'Second', 20),
      humanWait('a', 'First', 10),
      { ...humanWait('b', 'Decided'), status: 'approved' },
      humanWait(undefined, 'No session'),
      humanWait('d', '   '),
    ]);

    expect(questions.get('a')).toBe('First');
    expect(questions.has('b')).toBe(false);
    expect(questions.size).toBe(1);
  });
});

describe('the chats that wait on you', () => {
  test('are the sessions of the pending reviews, oldest first, each once', () => {
    expect(
      waitingChatIds([
        humanWait('b', 'Second', 20),
        humanWait('a', 'First', 10),
        humanWait('b', 'Again', 30),
        { ...humanWait('c', 'Decided'), status: 'approved' },
        humanWait(undefined, 'No session'),
      ]),
    ).toEqual(['a', 'b']);
  });
});

describe('a session as a row', () => {
  test('shows the latest message, the title, the agent, when it changed and its status', () => {
    expect(sessionRow(context, new Map())).toEqual({
      id: 'session-1',
      title: 'Plan the week',
      snippet: 'Sounds good.',
      agentName: 'assistant',
      updatedAt: Date.parse('2026-10-19T09:00:00.000Z'),
      status: 'Done',
    });
  });

  test('is Failed only for an idle chat whose latest run failed', () => {
    const failed = new Set(['session-1']);

    expect(sessionRow(context, new Map(), failed).status).toBe('Failed');
    expect(sessionRow(context, new Map(), new Set(['other'])).status).toBe('Done');
    // A chat that waits on you or is running again is not a failure to report.
    expect(sessionRow({ ...context, activity: 'awaiting-input' }, new Map(), failed).status).toBe(
      'Waiting on you',
    );
    expect(sessionRow({ ...context, activity: 'running' }, new Map(), failed).status).toBe(
      'Running',
    );
  });

  test('shows the question a waiting chat asks in place of the last message, and only while it waits', () => {
    const questions = new Map([['session-1', 'Which environment?']]);

    expect(sessionRow({ ...context, activity: 'awaiting-input' }, questions)).toMatchObject({
      snippet: 'Which environment?',
      status: 'Waiting on you',
    });
    expect(sessionRow({ ...context, activity: 'idle' }, questions)).toMatchObject({
      snippet: 'Sounds good.',
      status: 'Done',
    });
    expect(sessionRow({ ...context, activity: 'running' }, questions).status).toBe('Running');
  });

  test('says why a chat the host ended ended, in place of its last message', () => {
    expect(
      sessionRow(
        { ...context, endReason: 'host-stopped', lastMessagePreview: 'Rename it' },
        new Map(),
      ),
    ).toMatchObject({
      status: 'Ended',
      snippet: 'The server restarted before I finished.',
    });
    // A chat that ran again since is no longer ended, and says its last message.
    expect(sessionRow({ ...context, endReason: null }, new Map()).snippet).toBe('Sounds good.');
  });

  test('says how many messages a chat holds when there is none to show, and names an untitled chat', () => {
    expect(
      sessionRow({ ...context, lastMessagePreview: null, title: null, messageCount: 1 }, new Map()),
    ).toMatchObject({ snippet: '1 message', title: 'New chat' });
    expect(
      sessionRow({ ...context, lastMessagePreview: '  ', messageCount: 3 }, new Map()).snippet,
    ).toBe('3 messages');
  });

  test('has no time when the Bureau’s is unreadable', () => {
    expect(sessionRow({ ...context, updatedAt: 'not a date' }, new Map()).updatedAt).toBeNull();
  });
});

describe('the status word of a chat', () => {
  test('is its activity, its latest run and how it ended, in that order', () => {
    const word = (overrides: Parameters<typeof contextFixture>[1], failed = false) =>
      chatStatusWord(contextFixture('c', overrides), failed ? new Set(['c']) : new Set());
    expect(word({ activity: 'awaiting-input' })).toBe('Waiting on you');
    expect(word({ activity: 'running' })).toBe('Running');
    expect(word({ activity: 'idle' }, true)).toBe('Failed');
    expect(word({ activity: 'idle', endReason: 'host-stopped' })).toBe('Ended');
    expect(word({ activity: 'idle' })).toBe('Done');
  });
});

describe('the chats as the list orders them', () => {
  const row = (id: string, updatedAt: number | null): SessionRow => ({
    id,
    title: id,
    snippet: '',
    agentName: 'assistant',
    updatedAt,
    status: 'Done',
  });

  test('are newest first, with the unreadable ones last, whatever they wait on', () => {
    const waiting: SessionRow = { ...row('waiting-old', 1), status: 'Waiting on you' };

    expect(
      chatListRows([row('older', 5), waiting, row('unreadable', null), row('newest', 9)]).map(
        (entry) => entry.id,
      ),
    ).toEqual(['newest', 'older', 'waiting-old', 'unreadable']);
  });

  test('keeps the Bureau’s order for rows with the same time', () => {
    expect(
      chatListRows([row('first', 3), row('second', 3), row('third', 3)]).map((r) => r.id),
    ).toEqual(['first', 'second', 'third']);
  });
});

describe('the day band of a row', () => {
  const ZONE = 'America/Chicago';
  const now = Date.parse('2026-11-02T10:46:00-06:00');
  const group = (at: string | null, wide = false) =>
    chatDayGroup({ updatedAt: at === null ? null : Date.parse(at) }, now, ZONE, wide);

  test('names Today alone in a narrow pane and the zone the times are in', () => {
    expect(group('2026-11-02T10:42:00-06:00')).toEqual({
      key: 'today',
      label: 'Today',
      detail: 'Central time',
    });
  });

  test('names today’s date too in a wide pane, as the list pattern does', () => {
    expect(group('2026-11-02T10:42:00-06:00', true).label).toBe('Today · Monday, Nov 2');
  });

  test('names Yesterday with its date, and an older day by its date alone, each its own band', () => {
    expect(group('2026-11-01T16:12:00-06:00')).toEqual({
      key: 'yesterday',
      label: 'Yesterday · Sunday, Nov 1',
      detail: 'Central time',
    });
    const older = group('2026-10-29T11:05:00-05:00');
    expect(older.label).toBe('Thursday, Oct 29');
    expect(group('2026-10-28T11:05:00-05:00').key).not.toBe(older.key);
    expect(group('2026-10-29T15:00:00-05:00').key).toBe(older.key);
  });

  test('reads the day in the viewer’s zone, not the instant’s own, and puts a future time in Today', () => {
    // 9:30 PM Sunday in Chicago is already Monday at UTC.
    expect(group('2026-11-02T03:30:00Z').label).toBe('Yesterday · Sunday, Nov 1');
    expect(group('2026-11-02T12:00:00-06:00').key).toBe('today');
  });

  test('puts a chat with no readable time in Earlier', () => {
    expect(group(null)).toEqual({ key: 'earlier', label: 'Earlier', detail: 'Central time' });
  });
});

describe('the segments of the list', () => {
  const status = (value: SessionRow['status']) => ({ status: value });
  const rows = [
    status('Waiting on you'),
    status('Waiting on you'),
    status('Done'),
    status('Ended'),
    status('Failed'),
    status('Running'),
  ];

  test('count every chat in All, the ones that wait in Waiting on you, and the finished ones in Done', () => {
    expect(segmentCounts(rows)).toEqual({ all: 6, waiting: 2, done: 1 });
    expect(segmentCounts([])).toEqual({ all: 0, waiting: 0, done: 0 });
  });

  test('leave a chat that ended, failed or runs in All only', () => {
    for (const word of ['Ended', 'Failed', 'Running'] as const) {
      expect(inSegment(status(word), 'all')).toBe(true);
      expect(inSegment(status(word), 'waiting')).toBe(false);
      expect(inSegment(status(word), 'done')).toBe(false);
    }
  });
});

describe('searching the list', () => {
  const rows = [
    { title: 'Please refund order 4471', snippet: 'I found the order.', agent: 'Tool runner' },
    { title: 'Say hello', snippet: 'Hello! How can I help?', agent: 'Assistant' },
  ];
  const agentOf = (row: (typeof rows)[number]) => row.agent;

  test('matches the title, the message or the agent, whatever the case', () => {
    expect(matchingRows(rows, 'REFUND', agentOf)).toEqual(rows.slice(0, 1));
    expect(matchingRows(rows, 'how can i', agentOf)).toEqual(rows.slice(1));
    expect(matchingRows(rows, 'tool runner', agentOf)).toEqual(rows.slice(0, 1));
    expect(matchingRows(rows, 'parcelly', agentOf)).toEqual([]);
  });

  test('leaves every row for a search of nothing but space', () => {
    expect(matchingRows(rows, '   ', agentOf)).toEqual(rows);
    expect(matchingRows(rows, '', agentOf)).toEqual(rows);
  });
});

describe('an agent’s avatar', () => {
  test('gives the same agent the same one of eight tones every time', () => {
    for (const name of ['assistant', 'tool-runner', 'request-human-input', 'echo', '']) {
      expect(agentTone(name)).toBe(agentTone(name));
      expect(agentTone(name)).toBeGreaterThanOrEqual(0);
      expect(agentTone(name)).toBeLessThan(8);
    }
    // The seeded agents do not all share one colour.
    const tones = new Set(
      ['assistant', 'tool-runner', 'request-human-input', 'echo', 'model-switcher'].map(agentTone),
    );
    expect(tones.size).toBeGreaterThan(2);
  });

  test('spells the first letters of the first two parts of the identifier', () => {
    expect(agentAvatarName('request-human-input')).toBe('request human input');
    expect(agentAvatarName('echo')).toBe('echo');
  });
});
