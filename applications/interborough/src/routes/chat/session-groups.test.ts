import { describe, expect, test } from 'bun:test';

import type { ChatContext } from '../../lib/bureau-client.ts';
import type { BureauReview } from '../../lib/bureau-reviews.ts';
import {
  agentAvatarName,
  agentTone,
  dayGroupOf,
  groupSessions,
  pendingQuestions,
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
  test('shows the latest message, the title, the agent and when it changed', () => {
    expect(sessionRow(context, new Map())).toEqual({
      id: 'session-1',
      title: 'Plan the week',
      snippet: 'Sounds good.',
      agentName: 'assistant',
      updatedAt: Date.parse('2026-10-19T09:00:00.000Z'),
      needsYou: false,
      failed: false,
    });
  });

  test('is failed only for an idle chat whose latest run failed', () => {
    const failed = new Set(['session-1']);

    expect(sessionRow(context, new Map(), failed).failed).toBe(true);
    expect(sessionRow(context, new Map(), new Set(['other'])).failed).toBe(false);
    // A chat that waits on you or is running again is not a failure to report.
    expect(sessionRow({ ...context, activity: 'awaiting-input' }, new Map(), failed).failed).toBe(
      false,
    );
    expect(sessionRow({ ...context, activity: 'running' }, new Map(), failed).failed).toBe(false);
  });

  test('shows the question a waiting chat asks in place of the last message, and only while it waits', () => {
    const questions = new Map([['session-1', 'Which environment?']]);

    expect(sessionRow({ ...context, activity: 'awaiting-input' }, questions)).toMatchObject({
      snippet: 'Which environment?',
      needsYou: true,
    });
    expect(sessionRow({ ...context, activity: 'idle' }, questions)).toMatchObject({
      snippet: 'Sounds good.',
      needsYou: false,
    });
    expect(sessionRow({ ...context, activity: 'running' }, questions).needsYou).toBe(false);
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

describe('the day a change belongs to', () => {
  const now = new Date(2026, 9, 23, 0, 30).getTime();

  test('is Today from local midnight, Yesterday the day before, and Earlier before that', () => {
    expect(dayGroupOf(new Date(2026, 9, 23, 0, 0).getTime(), now)).toBe('today');
    expect(dayGroupOf(new Date(2026, 9, 22, 23, 59).getTime(), now)).toBe('yesterday');
    expect(dayGroupOf(new Date(2026, 9, 22, 0, 0).getTime(), now)).toBe('yesterday');
    expect(dayGroupOf(new Date(2026, 9, 21, 23, 59).getTime(), now)).toBe('earlier');
  });

  test('puts a change in the future in Today and one with no time in Earlier', () => {
    expect(dayGroupOf(now + 3_600_000, now)).toBe('today');
    expect(dayGroupOf(null, now)).toBe('earlier');
  });
});

describe('the groups of the list', () => {
  const now = new Date(2026, 9, 23, 15, 0).getTime();
  const row = (id: string, at: Date | null, needsYou = false): SessionRow => ({
    id,
    title: id,
    snippet: '',
    agentName: 'assistant',
    updatedAt: at?.getTime() ?? null,
    needsYou,
  });

  test('puts Needs you first whatever the age, then Today, Yesterday and Earlier, newest first in each', () => {
    const groups = groupSessions(
      [
        row('old', new Date(2026, 9, 1)),
        row('today-early', new Date(2026, 9, 23, 8)),
        row('waiting-old', new Date(2026, 9, 2), true),
        row('yesterday', new Date(2026, 9, 22, 12)),
        row('today-late', new Date(2026, 9, 23, 14)),
        row('waiting-new', new Date(2026, 9, 23, 13), true),
      ],
      now,
    );

    expect(
      groups.map((group) => [group.key, group.label, group.rows.map((entry) => entry.id)]),
    ).toEqual([
      ['needs-you', 'Needs you', ['waiting-new', 'waiting-old']],
      ['today', 'Today', ['today-late', 'today-early']],
      ['yesterday', 'Yesterday', ['yesterday']],
      ['earlier', 'Earlier', ['old']],
    ]);
  });

  test('leaves out a group with no row, and gives no group for no row', () => {
    expect(
      groupSessions([row('a', new Date(2026, 9, 23, 9))], now).map((group) => group.key),
    ).toEqual(['today']);
    expect(groupSessions([], now)).toEqual([]);
  });

  test('keeps the Bureau’s order for rows with the same time', () => {
    const at = new Date(2026, 9, 23, 9);

    const [group] = groupSessions([row('first', at), row('second', at), row('third', at)], now);

    expect(group?.rows.map((entry) => entry.id)).toEqual(['first', 'second', 'third']);
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
