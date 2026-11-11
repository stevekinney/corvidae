/**
 * How the Goals list reads its goals (design rows 10s, 10t, 67c, 68j, 68x, 68y and 04m): the title
 * and check of a row, the status word, the segments and their counts, the filters the address
 * holds, the day a row is listed under and the sentence for filters that match nothing.
 */
import { describe, expect, test } from 'bun:test';

import { goalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import { GOAL_STATUSES, type GoalStatus } from '../../lib/bureau-goals.ts';
import {
  GOAL_SEGMENTS,
  checkText,
  countGoalRows,
  goalDayGroup,
  goalFiltersFromSearch,
  goalListWord,
  goalNoMatchDescription,
  goalRow,
  goalSegmentOf,
  goalsAreFiltered,
  narrowByAgent,
  narrowBySegment,
  sortGoalRows,
  type GoalRow,
} from './goal-rows.ts';

const ZONE = 'America/Chicago';
/** Monday, Nov 2, 10:45 AM Central. */
const NOW = Date.parse('2026-11-02T16:45:00Z');

function rowOf(id: string, status: GoalStatus, parts: Partial<GoalRow> = {}): GoalRow {
  return { ...goalRow(goalFixture(id, { status })), ...parts };
}

describe('the segment a goal counts under', () => {
  test('is Running for every status that has not ended, whatever its attempt waits for', () => {
    for (const status of ['pending', 'running', 'evaluating', 'retrying'] as const) {
      expect(goalSegmentOf(status), status).toBe('running');
    }
  });

  test('is Done, Gave up or Stopped for the status a goal ended in, and none for a goal that failed', () => {
    expect(goalSegmentOf('succeeded')).toBe('done');
    expect(goalSegmentOf('exhausted')).toBe('gave-up');
    expect(goalSegmentOf('canceled')).toBe('stopped');
    expect(goalSegmentOf('failed')).toBeNull();
  });

  test('is decided for every status the Bureau can answer', () => {
    expect(GOAL_STATUSES.map((status) => goalSegmentOf(status))).toEqual([
      'running',
      'running',
      'running',
      'running',
      'done',
      'gave-up',
      null,
      'stopped',
    ]);
  });
});

describe('the status word of a goal', () => {
  test('is one of Cinder’s words: Running, Done, Gave up, Stopped, and Failed for a check that could not run', () => {
    const word = (status: GoalStatus) => goalListWord({ status, cancellation: null });
    expect(word('running')).toBe('Running');
    expect(word('evaluating')).toBe('Running');
    expect(word('pending')).toBe('Running');
    expect(word('succeeded')).toBe('Done');
    expect(word('exhausted')).toBe('Gave up');
    expect(word('canceled')).toBe('Stopped');
    expect(word('failed')).toBe('Failed');
  });

  test('is a qualifier on Running, not a new word, for a goal asked to stop that has not yet', () => {
    const cancellation = { requestedAt: '2026-10-19T08:06:00.000Z', reason: null };
    expect(goalListWord({ status: 'evaluating', cancellation })).toBe('Running, stopping');
    // Once it has ended the word is the ending's.
    expect(goalListWord({ status: 'canceled', cancellation })).toBe('Stopped');
  });
});

describe('the check of a goal', () => {
  test('reads a validator named by a slug as the sentence it stands for', () => {
    expect(checkText('summary-lists-every-refund-waiting-for-approval')).toBe(
      'Summary lists every refund waiting for approval',
    );
    expect(checkText('reply-says-hello')).toBe('Reply says hello');
    expect(checkText('notes_mention_the_staging_fix')).toBe('Notes mention the staging fix');
  });

  test('says a name that already has spaces as it is, and nothing for no name', () => {
    expect(checkText('Reply says hello')).toBe('Reply says hello');
    expect(checkText('  Reply says hello  ')).toBe('Reply says hello');
    expect(checkText('')).toBe('');
    expect(checkText('---')).toBe('---');
  });
});

describe('a goal as a row', () => {
  test('is titled by the goal’s name and says the agent, the attempts, the check and when it began', () => {
    const row = goalRow(
      goalFixture('goal-1', {
        identity: { name: '  Summarize open refunds  ', version: '1' },
        validator: { name: 'summary-lists-every-refund-waiting-for-approval', version: '1' },
        agentName: 'tool-runner',
        status: 'canceled',
        createdAt: '2026-10-30T15:05:00.000Z',
        bounds: {
          maximumAttempts: 5,
          maximumTotalDurationMs: null,
          maximumTotalSteps: null,
          maximumTotalTokens: null,
          maximumTotalCostUsd: null,
        },
        usage: { attempts: 2, steps: 0, tokens: 0, costUsd: null, durationMs: 0 },
      }),
    );
    expect(row).toEqual({
      id: 'goal-1',
      title: 'Summarize open refunds',
      agentName: 'tool-runner',
      status: 'canceled',
      segment: 'stopped',
      statusWord: 'Stopped',
      check: 'Summary lists every refund waiting for approval',
      made: 2,
      allowed: 5,
      startedAt: Date.parse('2026-10-30T15:05:00.000Z'),
    });
  });

  test('is titled by its identifier when the goal has no name, and has no time when the Bureau’s is unreadable', () => {
    const row = goalRow(
      goalFixture('goal-2', { identity: { name: ' ', version: '1' }, createdAt: 'not a time' }),
    );
    expect(row.title).toBe('goal-2');
    expect(row.startedAt).toBeNull();
  });
});

describe('the order of the rows', () => {
  test('is newest first, the ones with no readable time last, and ties in the order listed', () => {
    const rows = [
      rowOf('older', 'running', { startedAt: 1_000 }),
      rowOf('unknown', 'running', { startedAt: null }),
      rowOf('newer', 'running', { startedAt: 3_000 }),
      rowOf('tied-first', 'running', { startedAt: 2_000 }),
      rowOf('tied-second', 'running', { startedAt: 2_000 }),
    ];
    expect(sortGoalRows(rows).map((row) => row.id)).toEqual([
      'newer',
      'tied-first',
      'tied-second',
      'older',
      'unknown',
    ]);
    // The input is left as it was.
    expect(rows[0]?.id).toBe('older');
  });
});

describe('the filters in the address', () => {
  test('are a segment and an agent, and a value that names nothing is left out', () => {
    expect(goalFiltersFromSearch(new URLSearchParams(''))).toEqual({
      status: 'all',
      agent: undefined,
    });
    expect(goalFiltersFromSearch(new URLSearchParams('status=gave-up&agent=tool-runner'))).toEqual({
      status: 'gave-up',
      agent: 'tool-runner',
    });
    expect(goalFiltersFromSearch(new URLSearchParams('status=Failed&agent='))).toEqual({
      status: 'all',
      agent: undefined,
    });
    expect(goalsAreFiltered({ status: 'all', agent: undefined })).toBe(false);
    expect(goalsAreFiltered({ status: 'done', agent: undefined })).toBe(true);
    expect(goalsAreFiltered({ status: 'all', agent: 'assistant' })).toBe(true);
  });
});

describe('the segments', () => {
  const ROWS = [
    rowOf('stopped', 'canceled', { agentName: 'tool-runner' }),
    rowOf('gave-up', 'exhausted'),
    rowOf('done', 'succeeded'),
    rowOf('running', 'evaluating', { agentName: 'tool-runner' }),
    rowOf('failed', 'failed'),
  ];

  test('are All, Running, Done, Gave up and Stopped, in that order', () => {
    expect(GOAL_SEGMENTS).toEqual(['all', 'running', 'done', 'gave-up', 'stopped']);
  });

  test('count the rows they hold, and All holds a goal that failed too', () => {
    expect(countGoalRows(ROWS)).toEqual({
      all: 5,
      running: 1,
      done: 1,
      'gave-up': 1,
      stopped: 1,
    });
    expect(countGoalRows([])).toEqual({ all: 0, running: 0, done: 0, 'gave-up': 0, stopped: 0 });
  });

  test('narrow the rows, and the agent chip narrows them first so the counts say what choosing each shows', () => {
    expect(narrowBySegment(ROWS, 'all')).toHaveLength(5);
    expect(narrowBySegment(ROWS, 'gave-up').map((row) => row.id)).toEqual(['gave-up']);
    const toolRunner = narrowByAgent(ROWS, 'tool-runner');
    expect(toolRunner.map((row) => row.id)).toEqual(['stopped', 'running']);
    expect(countGoalRows(toolRunner)['gave-up']).toBe(0);
    expect(narrowByAgent(ROWS, undefined)).toHaveLength(5);
  });
});

describe('the day a row is listed under', () => {
  const at = (iso: string) => ({ startedAt: Date.parse(iso) });

  test('is named by the viewer’s calendar, with the zone at the right', () => {
    expect(goalDayGroup(at('2026-11-02T16:41:00Z'), NOW, ZONE, false)).toEqual({
      key: 'today',
      label: 'Today, Monday, Nov 2',
      detail: 'Central time',
    });
    expect(goalDayGroup(at('2026-11-01T22:12:00Z'), NOW, ZONE, false)).toEqual({
      key: 'yesterday',
      label: 'Yesterday, Sunday, Nov 1',
      detail: 'Central time',
    });
    const friday = goalDayGroup(at('2026-10-30T15:05:00Z'), NOW, ZONE, false);
    expect(friday.label).toBe('Friday, Oct 30');
    expect(friday.detail).toBe('Central time');
    expect(String(friday.key)).toStartWith('day-');
  });

  test('puts goals of one day under one band, and goals of two days under two', () => {
    const morning = goalDayGroup(at('2026-10-30T12:48:00Z'), NOW, ZONE, false);
    const evening = goalDayGroup(at('2026-10-31T03:30:00Z'), NOW, ZONE, false);
    const sameMorning = goalDayGroup(at('2026-10-30T15:05:00Z'), NOW, ZONE, false);
    expect(sameMorning.key).toBe(morning.key);
    // 3:30 AM UTC on Oct 31 is still the evening of Oct 30 in Chicago.
    expect(evening.key).toBe(morning.key);
    expect(goalDayGroup(at('2026-10-29T15:05:00Z'), NOW, ZONE, false).key).not.toBe(morning.key);
  });

  test('reads today and yesterday as those words alone on a phone', () => {
    expect(goalDayGroup(at('2026-11-02T16:41:00Z'), NOW, ZONE, true).label).toBe('Today');
    expect(goalDayGroup(at('2026-11-01T22:12:00Z'), NOW, ZONE, true).label).toBe('Yesterday');
    expect(goalDayGroup(at('2026-10-30T15:05:00Z'), NOW, ZONE, true).label).toBe('Friday, Oct 30');
  });

  test('is Earlier for a goal with no readable time, where nothing claims it is recent', () => {
    expect(goalDayGroup({ startedAt: null }, NOW, ZONE, false)).toEqual({
      key: 'earlier',
      label: 'Earlier',
      detail: 'Central time',
    });
  });
});

describe('what filters that match nothing say', () => {
  test('names the agent first and then what it has none of, and what to change', () => {
    expect(
      goalNoMatchDescription({ status: 'gave-up', agent: 'tool-runner' }, { agent: 'Tool runner' }),
    ).toBe('Tool runner hasn’t given up on any goal. Try another status or agent.');
    expect(
      goalNoMatchDescription({ status: 'all', agent: 'tool-runner' }, { agent: 'Tool runner' }),
    ).toBe('Tool runner has no goals. Try another agent.');
    expect(goalNoMatchDescription({ status: 'running', agent: 'assistant' })).toBe(
      'assistant has no running goals. Try another status or agent.',
    );
  });

  test('says what no goal is when only a status is chosen', () => {
    expect(goalNoMatchDescription({ status: 'running', agent: undefined })).toBe(
      'No goals are running. Try another status.',
    );
    expect(goalNoMatchDescription({ status: 'done', agent: undefined })).toBe(
      'No goals are done. Try another status.',
    );
    expect(goalNoMatchDescription({ status: 'gave-up', agent: undefined })).toBe(
      'No goals have given up. Try another status.',
    );
    expect(goalNoMatchDescription({ status: 'stopped', agent: undefined })).toBe(
      'No goals are stopped. Try another status.',
    );
  });
});
