/**
 * The Runs list's own reading of the rows (COR-2017, PageRuns and ListPatterns): the steps of a
 * workflow folded into one run, the order a row keeps while it runs, the status words and the
 * segments they count under, line two, the day bands, and the page of ten with the missed runs.
 * Read in the sample world's zone at its clock: Monday, Nov 2, 10:50 AM Central time.
 */
import { describe, expect, test } from 'bun:test';

import {
  contextFixture,
  goalAttemptFixture,
  goalFixture,
  taskFixture,
} from '../../../lib/bureau-fixtures.test-support.ts';
import type { MissedRuns } from './missed-runs.ts';
import {
  buildRunRows,
  durationWords,
  goalTitle,
  RUN_PAGE_SIZE,
  runDayGroup,
  runLineTwo,
  runListEntries,
  runListRows,
  runSegmentCounts,
  runSegmentOf,
  runStatusWord,
  waitedWords,
  type RunRow,
} from './run-rows.ts';

const ZONE = 'America/Chicago';
/** Monday, Nov 2, 2026, 10:50 AM Central time (CST: the clocks went back on Nov 1). */
const NOW = Date.parse('2026-11-02T10:50:00-06:00');

const LABELS: Readonly<Record<string, string>> = {
  'tool-runner': 'Tool runner',
  assistant: 'Assistant',
};
const context = {
  now: NOW,
  zone: ZONE,
  agentLabel: (name: string): string => LABELS[name] ?? name,
};

const refundChat = contextFixture('chat-4471', { title: 'Refund order 4471' });

/** The one row `buildRunRows` and `runListRows` make of these sources. */
function onlyRow(input: Parameters<typeof buildRunRows>[0]): RunRow {
  const [row] = runListRows(buildRunRows(input));
  if (row === undefined) throw new Error('No row was made.');
  return row;
}

describe('the steps of a workflow instance', () => {
  test('are one run, the instance: failed when a step failed, with its reason and how long it took', () => {
    const rows = runListRows(
      buildRunRows({
        tasks: [
          taskFixture({
            id: 'step-1',
            kind: 'catalog',
            agentName: 'assistant',
            status: 'completed',
            origin: { kind: 'parent', parentRunId: 'release-notes-run' },
            createdAt: '2026-10-30T11:00:00-05:00',
            updatedAt: '2026-10-30T11:00:01-05:00',
          }),
          taskFixture({
            id: 'step-2',
            kind: 'catalog',
            agentName: 'assistant',
            status: 'failed',
            statusMessage: 'GitHub didn’t answer (HTTP 503)',
            origin: { kind: 'parent', parentRunId: 'release-notes-run' },
            createdAt: '2026-10-30T11:00:01-05:00',
            updatedAt: '2026-10-30T11:00:03-05:00',
          }),
        ],
        goals: [],
        chats: [],
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'release-notes-run',
      status: 'failed',
      title: 'Workflow run',
      summary: 'GitHub didn’t answer (HTTP 503)',
      durationMs: 3000,
      origin: { kind: 'parent', parentRunId: 'release-notes-run', href: '/runs/release-notes-run' },
    });
    expect(runLineTwo(rows[0] as RunRow, context)).toBe(
      'Workflow, Assistant, GitHub didn’t answer (HTTP 503), 3 s',
    );
  });
});

describe('the order of the list', () => {
  test('is by when each run started, so a run that finishes keeps its place', () => {
    const rows = runListRows(
      buildRunRows({
        tasks: [
          taskFixture({
            id: 'earlier',
            status: 'completed',
            createdAt: '2026-11-02T10:00:00-06:00',
            updatedAt: '2026-11-02T10:49:00-06:00',
          }),
          taskFixture({
            id: 'later',
            status: 'working',
            createdAt: '2026-11-02T10:30:00-06:00',
            updatedAt: '2026-11-02T10:30:01-06:00',
          }),
        ],
        goals: [],
        chats: [],
      }),
    );
    expect(rows.map((row) => row.id)).toEqual(['later', 'earlier']);
  });
});

describe('a goal’s attempts', () => {
  const bounds = { ...goalFixture('any').bounds, maximumAttempts: 5 };

  test('one that missed the check is Done, said "Check not met", with which attempt it was', () => {
    const goal = goalFixture('draft-release-notes', {
      bounds,
      attempts: [
        goalAttemptFixture('draft-a5', {
          attemptIndex: 4,
          status: 'failed',
          startedAt: '2026-10-30T08:21:00-05:00',
          completedAt: '2026-10-30T08:21:06-05:00',
        }),
      ],
    });
    const row = onlyRow({
      tasks: [
        taskFixture({
          id: 'draft-a5',
          kind: 'catalog',
          status: 'completed',
          origin: { kind: 'goal', goalRunId: 'draft-release-notes', attemptId: 'a5' },
          createdAt: '2026-10-30T08:21:00-05:00',
          updatedAt: '2026-10-30T08:21:06-05:00',
        }),
      ],
      goals: [goal],
      chats: [],
    });

    expect(row).toMatchObject({
      title: 'Draft release notes',
      checkNotMet: true,
      attempt: { number: 5, of: 5 },
    });
    expect(runStatusWord(row)).toBe('Check not met');
    expect(runSegmentOf(row.status)).toBe('done');
    expect(runLineTwo(row, context)).toBe('Goal, Assistant, attempt 5 of 5, 6 s');
  });

  test('one that was canceled says when, and after how long, and never who canceled it', () => {
    const goal = goalFixture('summarize-open-refunds', {
      agentName: 'tool-runner',
      bounds,
      attempts: [
        goalAttemptFixture('summarize-a2', {
          attemptIndex: 1,
          status: 'aborted',
          startedAt: '2026-10-30T10:07:00-05:00',
          completedAt: '2026-10-30T10:08:12-05:00',
        }),
      ],
    });
    const row = onlyRow({ tasks: [], goals: [goal], chats: [] });

    expect(runStatusWord(row)).toBe('Canceled');
    expect(runLineTwo(row, context)).toBe(
      'Goal, Tool runner, attempt 2 of 5, canceled at 10:08 AM after 1 min 12 s',
    );
  });

  test('one that passed is Done, with no qualifier', () => {
    const goal = goalFixture('say-hello', {
      attempts: [goalAttemptFixture('hello-a1', { status: 'passed' })],
    });
    const row = onlyRow({ tasks: [], goals: [goal], chats: [] });
    expect(runStatusWord(row)).toBe('Done');
    expect(row.checkNotMet).toBe(false);
  });
});

describe('line two', () => {
  test('says the kind, the agent, and how long a run has waited on you', () => {
    const row = onlyRow({
      tasks: [
        taskFixture({
          id: 'refund-4471',
          contextId: 'chat-4471',
          agentName: 'tool-runner',
          status: 'input-required',
          openWaits: [{ kind: 'tool-approval', reviewId: 'r', callId: 'c' }],
          createdAt: '2026-11-02T10:42:00-06:00',
          updatedAt: '2026-11-02T10:46:00-06:00',
        }),
      ],
      goals: [],
      chats: [refundChat],
    });
    expect(row.title).toBe('Refund order 4471');
    expect(runStatusWord(row)).toBe('Waiting on you');
    expect(runLineTwo(row, context)).toBe('Chat, Tool runner, waiting 4 min');
  });

  test('says how long a finished run took', () => {
    const row = onlyRow({
      tasks: [
        taskFixture({
          id: 'refund-4472',
          contextId: 'chat-4471',
          agentName: 'tool-runner',
          status: 'completed',
          createdAt: '2026-11-02T10:30:00-06:00',
          updatedAt: '2026-11-02T10:33:12-06:00',
        }),
      ],
      goals: [],
      chats: [refundChat],
    });
    expect(runLineTwo(row, context)).toBe('Chat, Tool runner, 3 min 12 s');
  });

  test('ticks a running run’s duration with the clock, and the row stays the same run', () => {
    const row = onlyRow({
      tasks: [
        taskFixture({
          id: 'running',
          contextId: 'chat-4471',
          status: 'working',
          createdAt: '2026-11-02T10:48:48-06:00',
          updatedAt: '2026-11-02T10:48:49-06:00',
        }),
      ],
      goals: [],
      chats: [refundChat],
    });
    expect(runStatusWord(row)).toBe('Running');
    expect(runLineTwo(row, context)).toBe('Chat, Assistant, running 1 min 12 s');
    expect(runLineTwo(row, { ...context, now: NOW + 2_000 })).toBe(
      'Chat, Assistant, running 1 min 14 s',
    );
  });

  test('titles a schedule’s fire by the schedule’s name, and says Interborough started its own runs', () => {
    const fire = onlyRow({
      tasks: [
        taskFixture({
          id: 'fire',
          kind: 'catalog',
          status: 'completed',
          origin: { kind: 'schedule', scheduleId: 'daily-summary', fireId: 'f1' },
          createdAt: '2026-10-29T04:00:00-05:00',
          updatedAt: '2026-10-29T04:00:14-05:00',
        }),
      ],
      goals: [],
      chats: [],
      scheduleNames: new Map([['daily-summary', 'Daily summary']]),
    });
    expect(fire.title).toBe('Daily summary');
    expect(runLineTwo(fire, context)).toBe('Schedule, Assistant, 14 s');

    const tick = onlyRow({
      tasks: [
        taskFixture({
          id: 'tick',
          kind: 'catalog',
          status: 'completed',
          origin: { kind: 'system' },
          createdAt: '2026-11-02T09:00:00-06:00',
          updatedAt: '2026-11-02T09:00:01-06:00',
        }),
      ],
      goals: [],
      chats: [],
    });
    expect(runLineTwo(tick, context)).toBe('Internal, Interborough started, 1 s');
  });

  test('never joins its parts with a middle dot', () => {
    const row = onlyRow({
      tasks: [taskFixture({ id: 'any', status: 'completed' })],
      goals: [],
      chats: [],
    });
    expect(runLineTwo(row, context)).not.toContain(String.fromCodePoint(0xb7));
  });
});

describe('the words of a duration', () => {
  test('are seconds, then minutes and seconds, then hours and minutes', () => {
    expect(durationWords(8_000)).toBe('8 s');
    expect(durationWords(120_000)).toBe('2 min');
    expect(durationWords(192_000)).toBe('3 min 12 s');
    expect(durationWords(3_840_000)).toBe('1 h 4 min');
    expect(durationWords(-5)).toBe('0 s');
  });

  test('of a wait are seconds, then whole minutes, then whole hours', () => {
    expect(waitedWords(12_000)).toBe('12 s');
    expect(waitedWords(4 * 60_000)).toBe('4 min');
    expect(waitedWords(3_570_000)).toBe('1 h');
    expect(waitedWords(3_660_000)).toBe('1 h');
  });
});

describe('the status segments', () => {
  test('count each run once, a run not yet started under Running and a missed check under Done', () => {
    const rows = buildRunRows({
      tasks: (
        [
          ['a', 'input-required'],
          ['b', 'submitted'],
          ['c', 'working'],
          ['d', 'completed'],
          ['e', 'failed'],
          ['f', 'canceled'],
          ['g', 'canceled'],
        ] as const
      ).map(([id, status]) => taskFixture({ id, status })),
      goals: [
        goalFixture('missed-check', {
          attempts: [goalAttemptFixture('h', { status: 'failed' })],
        }),
      ],
      chats: [],
    }).map((row) => (row.id === 'h' ? { ...row, status: 'completed' as const } : row));
    expect(runSegmentCounts(rows)).toEqual({
      all: 8,
      waiting: 1,
      running: 2,
      done: 2,
      failed: 1,
      canceled: 2,
    });
    expect(runSegmentCounts([])).toEqual({
      all: 0,
      waiting: 0,
      running: 0,
      done: 0,
      failed: 0,
      canceled: 0,
    });
  });
});

describe('the day bands', () => {
  test('say Today and Yesterday before the date, then the date alone, each naming the zone', () => {
    expect(runDayGroup(Date.parse('2026-11-02T10:42:00-06:00'), NOW, ZONE)).toEqual({
      key: 'today',
      label: 'Today, Monday, Nov 2',
      detail: 'Central time',
    });
    expect(runDayGroup(Date.parse('2026-11-01T16:12:00-06:00'), NOW, ZONE)).toEqual({
      key: 'yesterday',
      label: 'Yesterday, Sunday, Nov 1',
      detail: 'Central time',
    });
    expect(runDayGroup(Date.parse('2026-10-30T11:20:00-05:00'), NOW, ZONE)).toMatchObject({
      label: 'Friday, Oct 30',
      detail: 'Central time',
    });
  });
});

describe('the page of ten, and the missed runs', () => {
  // Twelve runs today, one a minute from 9:50 AM back.
  const rows = runListRows(
    buildRunRows({
      tasks: Array.from({ length: 12 }, (_, index) =>
        taskFixture({
          id: `run-${String(index)}`,
          status: 'completed',
          createdAt: new Date(NOW - 3_600_000 - index * 60_000).toISOString(),
          updatedAt: new Date(NOW - 3_600_000 - index * 60_000 + 1_000).toISOString(),
        }),
      ),
      goals: [],
      chats: [],
    }),
  );
  const missedAt = (loggedAt: number): MissedRuns => ({
    scheduleId: 'daily-summary',
    title: 'Daily summary',
    agentName: 'assistant',
    cadence: 'every day at 3:00 AM (9:00 AM UTC)',
    count: 4,
    since: Date.parse('2026-10-30T04:00:00-05:00'),
    loggedAt,
    occurrences: [],
    schedulePath: '/schedules/daily-summary',
  });

  test('shows ten runs, and a missed row after the runs that started when it was logged', () => {
    const loggedWithRun3 = (rows[3] as RunRow).startedAt;
    const entries = runListEntries(rows, [missedAt(loggedWithRun3)], RUN_PAGE_SIZE);
    expect(entries.filter((entry) => entry.kind === 'run')).toHaveLength(10);
    expect(entries.map((entry) => entry.key).slice(3, 6)).toEqual([
      'run:run-3',
      'missed:daily-summary',
      'run:run-4',
    ]);
  });

  test('keeps a missed row older than the last run shown for the page that reaches it', () => {
    const older = (rows[11] as RunRow).startedAt;
    expect(
      runListEntries(rows, [missedAt(older)], RUN_PAGE_SIZE).some(
        (entry) => entry.kind === 'missed',
      ),
    ).toBe(false);
    expect(
      runListEntries(rows, [missedAt(older)], RUN_PAGE_SIZE * 2)
        .map((entry) => entry.key)
        .at(-1),
    ).toBe('missed:daily-summary');
  });
});

describe('a goal’s name', () => {
  test('is its identifier in words when it is written as a name, and as it is otherwise', () => {
    expect(goalTitle('summarize-open-refunds')).toBe('Summarize open refunds');
    expect(goalTitle('3f2a9c10-1111-4aaa-8bbb-000000000000')).toBe(
      '3f2a9c10-1111-4aaa-8bbb-000000000000',
    );
  });
});
