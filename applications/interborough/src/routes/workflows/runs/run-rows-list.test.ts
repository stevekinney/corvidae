/**
 * The Runs list's own reading of the rows (COR-2017, PageRuns and ListPatterns): the steps of a
 * workflow folded into one run, the order a row keeps while it runs, the status words and the
 * segments they count under, line two, the day bands, and the page of ten with the missed runs.
 * Read in the sample world's zone at its clock: Monday, Nov 2, 10:50 AM Central time.
 */
import { statusForStatusDotWord } from '@lostgradient/cinder';
import { describe, expect, test } from 'bun:test';

import { SIGNAL_WAIT_WORD, TASK_COPY } from '../../../app/copy/tasks.ts';
import {
  contextFixture,
  goalAttemptFixture,
  goalFixture,
  taskFixture,
} from '../../../lib/bureau-fixtures.test-support.ts';
import { isRunning } from '../../../lib/bureau-tasks.ts';
import type { MissedRuns } from './missed-runs.ts';
import {
  buildRunRows,
  durationWords,
  filterRunRows,
  goalTitle,
  isRunRowRunning,
  parseRunFilter,
  RUN_PAGE_SIZE,
  runDayGroup,
  runLineTwo,
  runListEntries,
  runListRows,
  runSegmentCounts,
  runSegmentOf,
  runStatusWord,
  serializeRunFilter,
  visibleRunSegments,
  waitedWords,
  type RunRow,
} from './run-rows.ts';
import { runStatusLine } from './run-status-line.ts';

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
      identity: { name: 'Draft release notes', version: '1' },
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

  test('titles a schedule’s fire by the schedule’s name, says when the schedule runs, and says nothing of who started Interborough’s own runs', () => {
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
    // With the schedule read, its cadence follows the agent (row 53l).
    const cadences = new Map([['daily-summary', 'every day at 3:00 AM']]);
    expect(
      runLineTwo(fire, { ...context, scheduleCadence: (id: string) => cadences.get(id) }),
    ).toBe('Schedule, Assistant, every day at 3:00 AM, 14 s');

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
    expect(runLineTwo(tick, context)).toBe('Internal, 1 s');
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
      signal: 0,
      running: 2,
      done: 2,
      failed: 1,
      canceled: 2,
    });
    expect(runSegmentCounts([])).toEqual({
      all: 0,
      waiting: 0,
      signal: 0,
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

describe('a retrying run’s line two (COR-2535)', () => {
  const going = {
    id: 'charging-4473',
    contextId: 'chat-4471',
    agentName: 'tool-runner',
    status: 'working',
    createdAt: '2026-11-02T10:45:00-06:00',
    updatedAt: '2026-11-02T10:49:00-06:00',
  } as const;

  test('says which step is retrying and its try number, before how long it has run', () => {
    const row = onlyRow({
      tasks: [taskFixture({ ...going, retrying: { label: 'charge-card', attempt: 3 } })],
      goals: [],
      chats: [refundChat],
    });
    expect(runLineTwo(row, context)).toBe(
      'Chat, Tool runner, retrying charge-card, try 3, running 5 min',
    );
  });

  test('names a model step as it is, and says nothing of a run that retries nothing', () => {
    const modelRow = onlyRow({
      tasks: [taskFixture({ ...going, retrying: { label: 'model', attempt: 2 } })],
      goals: [],
      chats: [refundChat],
    });
    expect(runLineTwo(modelRow, context)).toContain('retrying model, try 2');
    const plain = onlyRow({
      tasks: [taskFixture({ ...going, retrying: null })],
      goals: [],
      chats: [refundChat],
    });
    expect(runLineTwo(plain, context)).not.toContain('retrying');
  });

  test('a workflow instance retries what one of its steps retries, and fails where its step failed', () => {
    const parent = 'instance-1';
    const step = (id: string, fields: Parameters<typeof taskFixture>[0]) =>
      taskFixture({
        id,
        contextId: id,
        agentName: 'assistant',
        origin: { kind: 'parent', parentRunId: parent },
        createdAt: '2026-11-02T10:45:00-06:00',
        updatedAt: '2026-11-02T10:49:00-06:00',
        ...fields,
      });
    const retrying = onlyRow({
      tasks: [step('step-1', { status: 'working', retrying: { label: 'send-email', attempt: 2 } })],
      goals: [],
      chats: [],
    });
    expect(retrying.id).toBe(parent);
    expect(retrying.retrying).toEqual({ label: 'send-email', attempt: 2 });
    const failed = onlyRow({
      tasks: [
        step('step-1', { status: 'completed' }),
        step('step-2', {
          status: 'failed',
          failure: {
            step: { index: 1, label: 'send-email' },
            errorCode: null,
            errorKind: null,
            toolCall: null,
          },
        }),
      ],
      goals: [],
      chats: [],
    });
    expect(failed.failedStep).toBe('send-email');
    expect(filterRunRows([failed], { failedStep: 'send-email' })).toHaveLength(1);
  });
});

describe('a failed instance’s line two', () => {
  test('says what the run said in a few words, never the error’s own JSON (rows 09r, 52i, 05x, 52t)', () => {
    const row = onlyRow({
      tasks: [
        taskFixture({
          id: 'release-notes-run',
          contextId: 'release-notes-run',
          kind: 'catalog',
          agentName: null,
          status: 'failed',
          statusMessage:
            'Agent "assistant" failed (finish reason "error"): {"name":"AgentRunError","message":"GitHub didn’t answer (HTTP 503)","cause":{"name":"Error","message":"GitHub didn’t answer (HTTP 503)"}}',
          origin: { kind: 'schedule', scheduleId: 'release-notes-digest', fireId: '' },
          createdAt: '2026-10-30T11:00:00-05:00',
          updatedAt: '2026-10-30T11:00:03-05:00',
          workflow: workflowOf('release-notes', {
            scheduleId: 'release-notes-digest',
            steps: { total: 4, at: 2 },
          }),
        }),
      ],
      goals: [],
      chats: [],
      scheduleNames: new Map([['release-notes-digest', 'Release notes digest']]),
    });
    const line = runLineTwo(row, context);
    expect(line).toBe(
      'Schedule, Release notes digest, failed at step 2 of 4, GitHub didn’t answer (HTTP 503), 3 s',
    );
    expect(line).not.toContain('{');
  });
});

describe('a goal attempt’s title', () => {
  test('is the goal’s own name, and its identifier in words only when the name is empty (rows 52i, 09r, 53l)', () => {
    const named = buildRunRows({
      tasks: [],
      goals: [
        goalFixture('16e7c79642a7c4e1-sample-goal-summarize-open-refunds', {
          identity: { name: 'Summarize open refunds', version: '1' },
          attempts: [goalAttemptFixture('named-a0')],
        }),
      ],
      chats: [],
      scheduleNames: new Map(),
    });
    expect(named[0]?.title).toBe('Summarize open refunds');
    const unnamed = buildRunRows({
      tasks: [],
      goals: [
        goalFixture('summarize-open-refunds', {
          identity: { name: ' ', version: '1' },
          attempts: [goalAttemptFixture('unnamed-a0')],
        }),
      ],
      chats: [],
      scheduleNames: new Map(),
    });
    expect(unnamed[0]?.title).toBe('Summarize open refunds');
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

/** What the Bureau says of the workflow a task ran on, with nothing recorded unless a test says. */
function workflowOf(
  type: string,
  rest: Partial<NonNullable<RunRow['workflow']>> = {},
): NonNullable<RunRow['workflow']> {
  return {
    type,
    scheduleId: null,
    scheduleName: null,
    tick: null,
    steps: null,
    awaitingSignal: null,
    ...rest,
  };
}

describe('the Bureau’s own runs (COR-2423)', () => {
  test('a schedule tick is "Schedule tick", from Interborough, and says what it logged (rows 09p, 52g, 53k)', () => {
    const row = onlyRow({
      tasks: [
        taskFixture({
          id: 'schedule-tick:missed-runs:daily-summary:1:2',
          contextId: 'schedule-tick:missed-runs:daily-summary:1:2',
          kind: 'catalog',
          agentName: null,
          status: 'completed',
          origin: { kind: 'system' },
          createdAt: '2026-11-02T09:00:00-06:00',
          updatedAt: '2026-11-02T09:00:01-06:00',
          workflow: workflowOf('scheduleTick', {
            scheduleId: 'daily-summary',
            scheduleName: 'Daily summary',
            tick: { event: 'missed-runs', missedRuns: 4, whileStopped: true },
          }),
        }),
      ],
      goals: [],
      chats: [],
    });

    expect(row).toMatchObject({ title: 'Schedule tick', workflowType: 'scheduleTick' });
    expect(runStatusWord(row)).toBe('Done');
    // A tick recorded after a restart is the one Interborough started.
    expect(runLineTwo(row, context)).toBe(
      'Internal, Interborough started, logged 4 missed runs, 1 s',
    );
  });

  test('a tick of a schedule that came due names the schedule, and not who started it (row 53l)', () => {
    const row = onlyRow({
      tasks: [
        taskFixture({
          id: 'schedule-tick:came-due:fire-1',
          kind: 'catalog',
          agentName: null,
          status: 'completed',
          origin: { kind: 'system' },
          createdAt: '2026-10-29T04:00:00-05:00',
          updatedAt: '2026-10-29T04:00:01-05:00',
          workflow: workflowOf('scheduleTick', {
            scheduleId: 'daily-summary',
            scheduleName: 'Daily summary',
            tick: { event: 'came-due', missedRuns: null, whileStopped: false },
          }),
        }),
      ],
      goals: [],
      chats: [],
    });
    expect(runLineTwo(row, context)).toBe('Internal, Daily summary came due, 1 s');
  });

  test('an instance a schedule fired names the schedule and then its agent (row 53l, Triage inbox)', () => {
    // The engine's record of the instance names no agent; its step, a task of its own, does.
    const [instance] = runListRows(
      buildRunRows({
        tasks: [
          taskFixture({
            id: 'triage-run',
            contextId: 'triage-run',
            kind: 'catalog',
            agentName: null,
            status: 'completed',
            origin: { kind: 'schedule', scheduleId: 'inbox-triage', fireId: '' },
            createdAt: '2026-10-24T08:00:00-05:00',
            updatedAt: '2026-10-24T08:00:41-05:00',
            workflow: workflowOf('triage-inbox', { scheduleId: 'inbox-triage' }),
          }),
          taskFixture({
            id: 'triage-step-1',
            kind: 'catalog',
            agentName: 'assistant',
            status: 'completed',
            origin: { kind: 'parent', parentRunId: 'triage-run' },
            createdAt: '2026-10-24T08:00:00-05:00',
            updatedAt: '2026-10-24T08:00:41-05:00',
          }),
        ],
        goals: [],
        chats: [],
        scheduleNames: new Map([['inbox-triage', 'Inbox triage']]),
      }),
    );
    expect(instance?.id).toBe('triage-run');
    expect(runLineTwo(instance!, context)).toBe('Schedule, Inbox triage, Assistant, 41 s');
  });

  test('an instance is named by its workflow and its schedule, and reads "failed at step 2 of 4" (rows 09r, 52i, 52t)', () => {
    const row = onlyRow({
      tasks: [
        taskFixture({
          id: 'release-notes-run',
          contextId: 'release-notes-run',
          kind: 'catalog',
          agentName: null,
          status: 'failed',
          statusMessage: 'GitHub didn’t answer (HTTP 503)',
          origin: { kind: 'schedule', scheduleId: 'release-notes-digest', fireId: '' },
          createdAt: '2026-10-30T11:00:00-05:00',
          updatedAt: '2026-10-30T11:00:03-05:00',
          workflow: workflowOf('release-notes', {
            scheduleId: 'release-notes-digest',
            steps: { total: 4, at: 2 },
          }),
        }),
      ],
      goals: [],
      chats: [],
      scheduleNames: new Map([['release-notes-digest', 'Release notes digest']]),
    });

    expect(row).toMatchObject({
      id: 'release-notes-run',
      title: 'Release notes',
      workflowType: 'release-notes',
    });
    expect(runStatusWord(row)).toBe('Failed');
    expect(runLineTwo(row, context)).toBe(
      'Schedule, Release notes digest, failed at step 2 of 4, GitHub didn’t answer (HTTP 503), 3 s',
    );
  });

  test('an instance a schedule fired has no chat to link to, since it ran in no session (COR-2424)', () => {
    const [instance, fire] = runListRows(
      buildRunRows({
        tasks: [
          taskFixture({
            id: 'release-notes-run',
            contextId: 'release-notes-run',
            kind: 'catalog',
            agentName: null,
            origin: {
              kind: 'schedule',
              scheduleId: 'release-notes-digest',
              fireId: 'release-notes-run',
            },
            createdAt: '2026-10-30T11:00:00-05:00',
            updatedAt: '2026-10-30T11:00:03-05:00',
            workflow: workflowOf('release-notes', { scheduleId: 'release-notes-digest' }),
          }),
          // An agent schedule's fire is a task with a session, and keeps its link.
          taskFixture({
            id: 'fire-run',
            contextId: 'fire-session',
            kind: 'schedule-fire',
            origin: { kind: 'schedule', scheduleId: 'daily-summary', fireId: 'fire-run' },
            createdAt: '2026-10-29T04:00:00-05:00',
            updatedAt: '2026-10-29T04:00:12-05:00',
            workflow: workflowOf('agentRun', { scheduleId: 'daily-summary' }),
          }),
        ],
        goals: [],
        chats: [],
      }),
    );

    expect(instance?.origin).toMatchObject({ kind: 'schedule', href: null });
    expect(instance?.engineRun).toBe(true);
    expect(fire?.origin).toMatchObject({ kind: 'schedule', href: '/chats/fire-session' });
    expect(fire?.engineRun).toBe(false);
  });

  test('marks the schedule tick, an instance and the steps folded into an instance as the engine’s runs, and no task with a record (COR-2424)', () => {
    const rows = runListRows(
      buildRunRows({
        tasks: [
          taskFixture({
            id: 'tick-1',
            contextId: 'tick-1',
            kind: 'catalog',
            agentName: null,
            workflow: workflowOf('scheduleTick'),
          }),
          taskFixture({ id: 'chat-run', workflow: workflowOf('agentRun') }),
          taskFixture({
            id: 'instance-step',
            contextId: 'instance-step',
            kind: 'catalog',
            origin: { kind: 'parent', parentRunId: 'instance-1' },
            workflow: workflowOf('agentRun'),
          }),
        ],
        goals: [],
        chats: [],
      }),
    );

    const byId = new Map(rows.map((row) => [row.id, row.engineRun] as const));
    expect(byId.get('tick-1')).toBe(true);
    expect(byId.get('instance-1')).toBe(true);
    expect(byId.get('chat-run')).toBe(false);
  });

  test('a run parked on a signal counts under Waiting, not Running, and the Waiting segment is drawn only while one is (row 56g)', () => {
    const rows = buildRunRows({
      tasks: [
        taskFixture({
          id: 'parked',
          contextId: 'parked',
          kind: 'catalog',
          agentName: null,
          status: 'working',
          workflow: workflowOf('release-notes', { awaitingSignal: 'notes-approved' }),
        }),
        taskFixture({ id: 'going', workflow: workflowOf('agentRun'), status: 'working' }),
      ],
      goals: [],
      chats: [],
    });

    const counts = runSegmentCounts(rows);
    expect(counts).toMatchObject({ all: 2, running: 1, signal: 1, waiting: 0 });
    expect(filterRunRows(rows, { status: 'signal' }).map((row) => row.id)).toEqual(['parked']);
    expect(filterRunRows(rows, { status: 'running' }).map((row) => row.id)).toEqual(['going']);
    expect(visibleRunSegments(counts, undefined)).toContain('signal');
    // With none parked the segment is not drawn, unless it is the one chosen.
    const none = runSegmentCounts(rows.filter((row) => row.id === 'going'));
    expect(visibleRunSegments(none, undefined)).not.toContain('signal');
    expect(visibleRunSegments(none, 'signal')).toContain('signal');
  });

  test('a run parked on a signal has one word: its row, its page and the segment that counts it say the same (rows 56g, 10h)', () => {
    const [row] = buildRunRows({
      tasks: [
        taskFixture({
          id: 'parked',
          contextId: 'parked',
          kind: 'catalog',
          agentName: null,
          status: 'working',
          workflow: workflowOf('release-notes', { awaitingSignal: 'notes-approved' }),
        }),
      ],
      goals: [],
      chats: [],
    });
    const page = runStatusLine({
      status: 'Running',
      startedAt: 0,
      over: false,
      now: 1000,
      task: undefined,
      waitingForSignals: ['notes-approved'],
      attempt: undefined,
    });

    expect(row === undefined ? undefined : runStatusWord(row)).toBe(SIGNAL_WAIT_WORD);
    expect(page.word).toBe(SIGNAL_WAIT_WORD);
    expect(TASK_COPY.list.segments.signal).toBe(SIGNAL_WAIT_WORD);
    // A word of StatusDot's own table, so the dot draws its tone (the hollow ring) and never a default.
    expect(statusForStatusDotWord(SIGNAL_WAIT_WORD)).toBe('pending');
  });

  test('an instance with its own row is not folded into a second "Workflow run" by its steps', () => {
    const rows = runListRows(
      buildRunRows({
        tasks: [
          taskFixture({
            id: 'release-notes-run',
            kind: 'catalog',
            agentName: null,
            status: 'working',
            origin: { kind: 'person', principal: 'p', surface: 'web' },
            workflow: workflowOf('release-notes', { steps: { total: 4, at: 2 } }),
          }),
          taskFixture({
            id: 'step-2',
            kind: 'catalog',
            agentName: 'assistant',
            status: 'working',
            origin: { kind: 'parent', parentRunId: 'release-notes-run' },
          }),
        ],
        goals: [],
        chats: [],
      }),
    );
    expect(rows.map((row) => row.id)).toEqual(['release-notes-run']);
    expect(rows[0]?.title).toBe('Release notes');
  });

  test('an instance parked at a signal is Waiting and names the signal, and is not counted as running (row 10h)', () => {
    const row = onlyRow({
      tasks: [
        taskFixture({
          id: 'release-notes-run',
          kind: 'catalog',
          agentName: null,
          status: 'working',
          origin: { kind: 'api' },
          createdAt: '2026-11-02T10:20:00-06:00',
          updatedAt: '2026-11-02T10:20:01-06:00',
          workflow: workflowOf('release-notes', {
            steps: { total: 4, at: 2 },
            awaitingSignal: 'notes-approved',
          }),
        }),
      ],
      goals: [],
      chats: [],
    });
    expect(runStatusWord(row, NOW)).toBe(SIGNAL_WAIT_WORD);
    // What it waits for, and nothing of its step (10h).
    expect(runLineTwo(row, context)).toBe('API, waiting for signal notes-approved');
    expect(isRunRowRunning(row, NOW)).toBe(false);
    expect(isRunning({ status: 'working', workflow: row.workflow ?? undefined })).toBe(false);
    expect(isRunning({ status: 'working', workflow: workflowOf('agentRun') })).toBe(true);
  });

  test('a submitted workflow instance is Scheduled until it takes a run slot (row 59a)', () => {
    const row = onlyRow({
      tasks: [
        taskFixture({
          id: 'release-notes-queued',
          contextId: 'release-notes-queued',
          kind: 'catalog',
          agentName: null,
          status: 'submitted',
          origin: { kind: 'api' },
          workflow: workflowOf('release-notes'),
        }),
      ],
      goals: [],
      chats: [],
    });
    expect(runStatusWord(row, NOW)).toBe('Scheduled');
    expect(runLineTwo(row, context)).toBe('API, waiting for a run slot');
    expect(runSegmentCounts([row])).toMatchObject({ all: 1, running: 0 });
    expect(filterRunRows([row], { status: 'running' })).toEqual([]);
    expect(isRunRowRunning(row, NOW)).toBe(false);
    expect(runStatusWord({ ...row, status: 'working' }, NOW)).toBe('Running');
    expect(runStatusWord({ ...row, engineRun: false }, NOW)).toBe('Running');
  });

  test('a run that asked to be woken is Scheduled, and says when it is due (row 10h)', () => {
    const row = onlyRow({
      tasks: [
        taskFixture({
          id: 'refund-audit',
          status: 'working',
          agentName: 'tool-runner',
          origin: { kind: 'schedule', scheduleId: 'weekly-refund-audit', fireId: 'f' },
          createdAt: '2026-11-02T08:00:00-06:00',
          updatedAt: '2026-11-02T08:00:01-06:00',
          wakeAt: '2026-11-02T11:00:00-06:00',
        }),
      ],
      goals: [],
      chats: [],
    });
    expect(runStatusWord(row, NOW)).toBe('Scheduled');
    expect(runLineTwo(row, context)).toBe('Schedule, Tool runner, due today at 11:00 AM');
    // What holds its schedule comes before its agent, and no cadence: the due time is the point.
    const held = runLineTwo(row, {
      ...context,
      scheduleCadence: () => 'every Monday at 11:00 AM',
      scheduleHolds: (scheduleId, agentName) =>
        scheduleId === 'weekly-refund-audit' && agentName === 'tool-runner'
          ? ['Order refund can’t load', 'no provider is connected']
          : [],
    });
    expect(held).toBe(
      'Schedule, Order refund can’t load, no provider is connected, Tool runner, due today at 11:00 AM',
    );
    expect(isRunRowRunning(row, NOW)).toBe(false);
    // Once the time has passed it is running again.
    expect(runStatusWord(row, NOW + 3_600_000)).toBe('Running');
  });

  test('the Workflow filter keeps the runs of one workflow, and rides in the address', () => {
    const rows = runListRows(
      buildRunRows({
        tasks: [
          taskFixture({ id: 'chat-run', workflow: workflowOf('agentRun') }),
          taskFixture({
            id: 'notes-run',
            kind: 'catalog',
            agentName: null,
            origin: { kind: 'api' },
            workflow: workflowOf('release-notes'),
          }),
        ],
        goals: [goalFixture('goal-1', { attempts: [goalAttemptFixture('attempt-1')] })],
        chats: [],
      }),
    );
    expect(filterRunRows(rows, { workflow: 'release-notes' }).map((row) => row.id)).toEqual([
      'notes-run',
    ]);
    expect(filterRunRows(rows, { workflow: 'goalRun' }).map((row) => row.id)).toEqual([
      'attempt-1',
    ]);
    const filter = parseRunFilter(new URLSearchParams('workflow=release-notes&status=failed'));
    expect(filter).toEqual({ status: 'failed', workflow: 'release-notes' });
    expect(serializeRunFilter(filter)).toBe('status=failed&workflow=release-notes');
  });
});
