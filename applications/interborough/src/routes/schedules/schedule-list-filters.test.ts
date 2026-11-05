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
