/**
 * How the Schedules list narrows its rows: the address owns the filters, the segments partition the
 * list, the Missed runs chip is a facet over Active, and the counts say what choosing each would show.
 */
import { describe, expect, test } from 'bun:test';

import {
  countRows,
  filtersFromSearch,
  isFiltered,
  narrowByFacets,
  narrowByView,
  noMatchDescription,
} from './schedule-list-filters.ts';
import type { ScheduleRow } from './schedule-row-model.ts';

function row(
  id: string,
  parts: {
    status?: 'active' | 'paused';
    statusKey?: ScheduleRow['statusKey'];
    agentIds?: string[];
    workflowType?: string;
    missedCount?: number;
  } = {},
): ScheduleRow {
  return {
    id,
    status: parts.status ?? 'active',
    statusKey: parts.statusKey ?? parts.status ?? 'active',
    agentIds: parts.agentIds ?? [],
    workflowType: parts.workflowType ?? 'agentRun',
    missedCount: parts.missedCount ?? 0,
  } as unknown as ScheduleRow;
}

const ROWS = [
  row('daily', { statusKey: 'missed', missedCount: 4, agentIds: ['assistant'] }),
  row('refund', { agentIds: ['tool-runner'], workflowType: 'order-refund' }),
  row('release', { workflowType: 'release-notes', agentIds: ['assistant'] }),
  row('inbox', { status: 'paused', workflowType: 'triage-inbox', agentIds: ['assistant'] }),
];

describe('filtersFromSearch', () => {
  test('reads the segment, the chip and the two facets from the address', () => {
    expect(
      filtersFromSearch(new URLSearchParams('status=paused&missed=1&agent=tool-runner&workflow=x')),
    ).toEqual({ status: 'paused', missed: true, agent: 'tool-runner', workflow: 'x' });
  });

  test('leaves out a value that names nothing', () => {
    expect(filtersFromSearch(new URLSearchParams('status=cancelled&missed=yes&agent='))).toEqual({
      status: 'all',
      missed: false,
      agent: undefined,
      workflow: undefined,
    });
  });
});

describe('the counts', () => {
  test('partition the list into Active and Paused, and count the schedules that missed runs apart', () => {
    expect(countRows(ROWS)).toEqual({ all: 4, active: 3, paused: 1, missed: 1 });
  });

  test('are those of the rows the agent and workflow chips leave', () => {
    const left = narrowByFacets(ROWS, { agent: 'assistant', workflow: undefined });
    expect(countRows(left)).toEqual({ all: 3, active: 2, paused: 1, missed: 1 });
    expect(countRows(narrowByFacets(ROWS, { agent: undefined, workflow: 'order-refund' }))).toEqual(
      { all: 1, active: 1, paused: 0, missed: 0 },
    );
  });
});

describe('narrowing', () => {
  test('a segment keeps its status, and the Missed runs chip keeps what missed runs among them', () => {
    expect(narrowByView(ROWS, { status: 'paused', missed: false }).map((r) => r.id)).toEqual([
      'inbox',
    ]);
    expect(narrowByView(ROWS, { status: 'all', missed: true }).map((r) => r.id)).toEqual(['daily']);
    expect(narrowByView(ROWS, { status: 'paused', missed: true })).toEqual([]);
    expect(narrowByView(ROWS, { status: 'all', missed: false })).toHaveLength(4);
  });

  test('says whether anything narrows the list', () => {
    expect(
      isFiltered({ status: 'all', missed: false, agent: undefined, workflow: undefined }),
    ).toBe(false);
    expect(isFiltered({ status: 'all', missed: false, agent: 'a', workflow: undefined })).toBe(
      true,
    );
    expect(
      isFiltered({ status: 'paused', missed: false, agent: undefined, workflow: undefined }),
    ).toBe(true);
  });
});

describe('the sentence under "No schedules match these filters"', () => {
  const none = { status: 'all', missed: false, agent: undefined, workflow: undefined } as const;

  test('names the agent and the segment, and what to change (row 70r)', () => {
    expect(
      noMatchDescription(
        { ...none, status: 'paused', agent: 'tool-runner' },
        { agent: 'Tool runner' },
      ),
    ).toBe('Tool runner has no paused schedules. Try another status or agent.');
  });

  test('says whose schedules there are none of, by the agent first and then the workflow', () => {
    expect(noMatchDescription({ ...none, agent: 'tool-runner' }, { agent: 'Tool runner' })).toBe(
      'Tool runner has no schedules. Try another agent.',
    );
    expect(
      noMatchDescription({ ...none, workflow: 'release-notes' }, { workflow: 'Release notes' }),
    ).toBe('Release notes has no schedules. Try another workflow.');
    expect(
      noMatchDescription(
        { ...none, status: 'active', agent: 'tool-runner', workflow: 'release-notes' },
        { agent: 'Tool runner', workflow: 'Release notes' },
      ),
    ).toBe(
      'Tool runner has no active schedules for Release notes. Try another status, agent or workflow.',
    );
  });

  test('says what no schedule is when no agent or workflow is chosen', () => {
    expect(noMatchDescription({ ...none, status: 'paused' })).toBe(
      'No schedules are paused. Try another status.',
    );
    expect(noMatchDescription({ ...none, missed: true })).toBe(
      'No schedules have missed runs. Try another filter.',
    );
    expect(noMatchDescription({ ...none, status: 'paused', missed: true })).toBe(
      'No paused schedules have missed runs. Try another status.',
    );
  });

  test('keeps the Missed runs chip in the sentence beside an agent', () => {
    expect(noMatchDescription({ ...none, missed: true, agent: 'assistant' })).toBe(
      'assistant has no schedules that missed runs. Try another agent.',
    );
  });

  test('falls back to the identifier when the agent has no label, and never says nothing', () => {
    expect(noMatchDescription({ ...none, agent: 'gone' })).toBe(
      'gone has no schedules. Try another agent.',
    );
    expect(noMatchDescription(none)).toBe('No schedules match. Try another filter.');
  });
});
