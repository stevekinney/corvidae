/**
 * Recent activity on Health (rows 76l, 76m): run-level and system events only, one line per run in
 * the state it is in, the time at the right, newest first. The sample world is the one the board
 * draws, read from the audit trail as the Bureau serves it.
 */
import { describe, expect, test } from 'bun:test';

import type { AttentionItem } from '../../lib/bureau-attention.ts';
import type { AuditRecord } from '../../lib/bureau-audit.ts';
import { activityTime, joinWords } from './health-times.ts';
import { loadRecentActivity } from './recent-activity-data.ts';
import { activityLines, lookupsFor, type ActivitySources } from './recent-activity.ts';

const NOW = Date.UTC(2026, 10, 2, 16, 46);

function record(
  timestamp: string,
  type: string,
  resource: string,
  detail: AuditRecord['detail'] = null,
  principal: string | null = null,
): AuditRecord {
  return { sequence: null, timestamp, type, resource, principal, detail };
}

const sampleRecords: AuditRecord[] = [
  record(
    '2026-11-02T16:45:00Z',
    'provider.disconnected',
    'provider:anthropic',
    { provider: 'anthropic' },
    'anonymous:local',
  ),
  record('2026-11-02T16:42:20Z', 'run.completed', 'run-6', { finishReason: 'stop-condition' }),
  record(
    '2026-11-02T16:42:00Z',
    'run.started',
    'run-6',
    { agentName: 'tool-runner', sessionId: 'chat-refunds' },
    'anonymous:local',
  ),
  record('2026-11-02T16:33:00Z', 'review.tool-approval.approved', 'run-5', null, 'anonymous:local'),
  record('2026-11-02T16:30:00Z', 'run.completed', 'run-5', { finishReason: 'stop-condition' }),
  record('2026-11-02T16:30:00Z', 'tool.started', 'run-5', { toolName: 'lookup-order' }),
  record(
    '2026-11-02T16:30:00Z',
    'run.started',
    'run-5',
    { agentName: 'tool-runner', sessionId: 'chat-refunds' },
    'anonymous:local',
  ),
  record(
    '2026-11-02T15:46:00Z',
    'run.started',
    'run-4',
    { agentName: 'request-human-input', sessionId: 'chat-release' },
    'anonymous:local',
  ),
  record(
    '2026-11-02T15:00:01Z',
    'schedule.missed',
    'schedule:daily',
    { scheduleId: 'daily', missedCount: 4 },
    'system:scheduler',
  ),
  record('2026-11-02T15:00:00Z', 'host.started', 'host', null, 'system:host'),
  record('2026-11-01T22:12:08Z', 'run.completed', 'run-3', { finishReason: 'stop-condition' }),
  record(
    '2026-11-01T22:12:00Z',
    'run.started',
    'run-3',
    { agentName: 'assistant', sessionId: 'chat-hello' },
    'anonymous:local',
  ),
  record('2026-11-01T22:12:00Z', 'host.started', 'host', null, 'system:host'),
  record(
    '2026-10-29T09:00:00Z',
    'schedule.fired',
    'run-fire',
    { scheduleId: 'daily', agentName: 'assistant' },
    'system:scheduler',
  ),
  record(
    '2026-10-29T09:00:00Z',
    'run.started',
    'run-fire',
    { agentName: 'assistant', sessionId: 'chat-fire' },
    'anonymous:local',
  ),
  record('2026-10-29T09:00:14Z', 'run.completed', 'run-fire', { finishReason: 'stop-condition' }),
];

const storageAlert: AttentionItem = {
  kind: 'alert',
  area: 'storage',
  at: Date.UTC(2026, 10, 2, 15, 5),
  metric: 'storage.size',
  currentValue: 1_717_986_918,
  threshold: 1_073_741_824,
};

const missed: AttentionItem = {
  kind: 'missed-runs',
  area: 'schedules',
  at: Date.UTC(2026, 10, 2, 15, 0, 1),
  scheduleId: 'daily',
  scheduleName: 'Daily summary',
  count: 4,
  since: Date.UTC(2026, 9, 30, 9),
  occurrences: [{ occurrence: Date.UTC(2026, 10, 2, 9), count: 1 }],
};

function sources(overrides: Partial<ActivitySources> = {}): ActivitySources {
  return {
    records: sampleRecords,
    attention: [storageAlert, missed],
    chatTitles: new Map([
      ['chat-refunds', 'Please refund order 4471, it arrived damaged.'],
      ['chat-release', 'Ship the release notes fix'],
      ['chat-hello', 'Say hello'],
      ['chat-fire', null],
    ]),
    scheduleNames: new Map([['daily', 'Daily summary']]),
    waitingRuns: new Map([
      ['run-6', 'approval'],
      ['run-4', 'question'],
    ]),
    now: NOW,
    ...overrides,
  };
}

/** The words of each line, with the clock times in them (which follow the zone the tests run in) written as `<time>`. */
const texts = (lines: readonly { text: string }[]): string[] =>
  lines.map((line) => line.text.replaceAll(/\d{1,2}:\d{2} [AP]M/g, '<time>'));

describe('the lines', () => {
  test('are run-level and system events, newest first, one line for each run in the state it is in', () => {
    expect(texts(activityLines(sources()))).toEqual([
      'You removed the Anthropic key',
      'Run started · Refund order 4471 · waiting on you',
      'Run finished · Refund order 4471',
      'Storage alert firing · over its warning level',
      'Missed runs noticed · Daily summary · was due <time>',
      'Server started',
      'Run finished · Say hello',
      'Schedule ran · Daily summary',
    ]);
  });

  test('a run that paused for an approval finishes when the approval was decided, not when it paused', () => {
    const finished = activityLines(sources()).find((line) => line.id === 'run:run-5');
    expect(finished?.at).toBe(Date.parse('2026-11-02T16:33:00Z'));
  });

  test('a run that waits on a question is for Reviews, not for this list', () => {
    expect(texts(activityLines(sources()))).not.toContain(
      'Run started · Ship the release notes fix · waiting on you',
    );
  });

  test('a run a schedule started is told by the schedule, once', () => {
    const lines = texts(activityLines(sources()));
    expect(
      lines.filter((line) => line.includes('Daily summary') && line.startsWith('Schedule')),
    ).toHaveLength(1);
    expect(
      lines.some((line) => line.includes('Untitled') || line.startsWith('Run started · assistant')),
    ).toBe(false);
  });

  test('only the server’s latest start is listed; the starts before it are in the audit log', () => {
    expect(
      texts(activityLines(sources())).filter((line) => line === 'Server started'),
    ).toHaveLength(1);
  });

  test('a run still working says it started, and a run that failed says so', () => {
    const lines = texts(
      activityLines(
        sources({
          records: [
            record('2026-11-02T16:40:00Z', 'run.error', 'run-x'),
            record('2026-11-02T16:39:00Z', 'run.started', 'run-x', { sessionId: 'chat-hello' }),
            record('2026-11-02T16:38:00Z', 'run.started', 'run-y', { sessionId: 'chat-hello' }),
          ],
          attention: [],
          waitingRuns: new Map(),
        }),
      ),
    );
    expect(lines).toEqual(['Run failed · Say hello', 'Run started · Say hello']);
  });

  test('a run whose chat is gone is named after its agent', () => {
    const [line] = activityLines(
      sources({
        records: [
          record('2026-11-02T16:39:00Z', 'run.started', 'run-z', {
            agentName: 'tool-runner',
            sessionId: 'gone',
          }),
        ],
        attention: [],
        chatTitles: new Map([['gone', null]]),
        waitingRuns: new Map(),
      }),
    );
    expect(line?.text).toBe('Run started · tool-runner');
  });

  test('a deleted chat is named when the trail names it, and is still listed when it does not', () => {
    const named = activityLines(
      sources({
        records: [
          record(
            '2026-11-01T22:12:00Z',
            'session.deleted',
            'session:s1',
            { title: 'Scratch test' },
            'anonymous:local',
          ),
        ],
        attention: [],
      }),
    );
    expect(texts(named)).toEqual(['You deleted a chat · “Scratch test”']);
    const unnamed = activityLines(
      sources({
        records: [
          record('2026-11-01T22:12:00Z', 'session.deleted', 'session:s1', { incarnation: 'x' }),
        ],
        attention: [],
      }),
    );
    expect(texts(unnamed)).toEqual(['You deleted a chat']);
  });

  test('takes at most nine lines', () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      record(
        `2026-11-02T10:${String(index).padStart(2, '0')}:00Z`,
        'host.started',
        `host-${index}`,
      ),
    );
    // One start is the latest; make the rest distinct events instead.
    const events = many.map((entry, index) =>
      index === 0
        ? entry
        : { ...entry, type: 'provider.disconnected', detail: { provider: 'openai' } },
    );
    expect(activityLines(sources({ records: events, attention: [] }))).toHaveLength(9);
  });

  test('step noise is the run’s own timeline and never appears', () => {
    const noise = [
      'tool.started',
      'tool.settled',
      'step.completed',
      'run.cleanup-settled',
      'agent.updated',
      'hook.created',
      'workflow.updated',
    ].map((type, index) => record(`2026-11-02T16:0${index}:00Z`, type, 'run-n'));
    expect(activityLines(sources({ records: noise, attention: [] }))).toEqual([]);
  });

  test('puts the time of each line at the right: the clock today, the day and clock yesterday, the date before', () => {
    const lines = activityLines(sources());
    const times = new Map(lines.map((line) => [line.text, line.time]));
    expect(times.get('You removed the Anthropic key')).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
    expect(times.get('Run finished · Say hello')).toMatch(/^Yesterday, \d{1,2}:\d{2} (AM|PM)$/);
    expect(times.get('Schedule ran · Daily summary')).toBe('Oct 29');
  });
});

describe('what the lines need looked up', () => {
  test('names the chats of the runs and the schedules of the records, each once', () => {
    expect(lookupsFor(sampleRecords)).toEqual({
      sessionIds: ['chat-refunds', 'chat-release', 'chat-hello', 'chat-fire'],
      scheduleIds: ['daily'],
    });
  });
});

describe('the times', () => {
  test('joins days as a sentence', () => {
    expect(joinWords([])).toBe('');
    expect(joinWords(['Oct 30'])).toBe('Oct 30');
    expect(joinWords(['Oct 30', 'Oct 31'])).toBe('Oct 30 and Oct 31');
    expect(joinWords(['Oct 30', 'Oct 31', 'Nov 1'])).toBe('Oct 30, Oct 31 and Nov 1');
  });

  test('says today by the clock alone', () => {
    expect(activityTime(NOW - 60_000, NOW)).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  });
});

describe('reading it from the Bureau', () => {
  test('reads newest first, asks for the total once, and names the chats and schedules it needs', async () => {
    const asked: {
      cursor: string | undefined;
      order: string | undefined;
      total: boolean | undefined;
    }[] = [];
    const result = await loadRecentActivity({
      attention: [storageAlert, missed],
      waitingRuns: new Map([['run-6', 'approval']]),
      now: NOW,
      queryAudit: async (_filter, cursor, options) => {
        asked.push({ cursor, order: options?.order, total: options?.includeTotal });
        return { records: sampleRecords, nextCursor: null, total: 78 };
      },
      getContext: async (id) =>
        ({
          id,
          title:
            id === 'chat-refunds' ? 'Please refund order 4471, it arrived damaged.' : 'Say hello',
        }) as never,
      listSchedules: async () => [{ id: 'daily', description: 'Daily summary' }] as never,
    });
    expect(asked).toEqual([{ cursor: undefined, order: 'newest', total: true }]);
    expect(result.total).toBe(78);
    expect(texts(result.lines)).toContain('Run started · Refund order 4471 · waiting on you');
    expect(texts(result.lines)).toContain('Schedule ran · Daily summary');
  });

  test('reads on, a page at a time, until the lines fill the section, and no further than three pages', async () => {
    let pages = 0;
    const noise = Array.from({ length: 100 }, (_, index) =>
      record(`2026-11-02T10:00:${String(index % 60).padStart(2, '0')}Z`, 'tool.settled', 'run-n'),
    );
    const result = await loadRecentActivity({
      attention: [],
      waitingRuns: new Map(),
      now: NOW,
      queryAudit: async () => {
        pages += 1;
        return { records: noise, nextCursor: `cursor-${pages}`, total: 300 };
      },
    });
    expect(pages).toBe(3);
    expect(result.lines).toEqual([]);
  });

  test('a chat that cannot be read does not stop the section', async () => {
    const result = await loadRecentActivity({
      attention: [],
      waitingRuns: new Map(),
      now: NOW,
      queryAudit: async () => ({ records: sampleRecords.slice(2, 3), nextCursor: null }),
      getContext: async () => {
        throw new Error('gone');
      },
      listSchedules: async () => {
        throw new Error('no schedules');
      },
    });
    expect(texts(result.lines)).toEqual(['Run started · tool-runner']);
    expect(result.total).toBeUndefined();
  });
});
