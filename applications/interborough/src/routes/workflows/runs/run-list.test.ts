/**
 * `/runs` as a person works it (COR-2017): the status segments with their counts, the Started by
 * and Agent chips and Search runs narrow the list through the address; the rows are status first
 * under day bands, ten at a time with Load more; the runs a schedule missed are one collapsed row
 * that opens onto its occurrences; and a run opens in place from its row. Through the route outlet,
 * over a Bureau that answers from a table.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { flushSync } from 'svelte';

import { TASK_COPY } from '../../../app/copy/tasks.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import { agentLabel } from '../../../lib/agent-label.ts';
import {
  contextFixture,
  goalAttemptFixture,
  goalFixture,
  taskFixture,
} from '../../../lib/bureau-fixtures.test-support.ts';
import type { BureauSchedule } from '../../../lib/bureau-schedules.ts';
import { StubFault } from '../../../lib/bureau-stub.test-support.ts';
import type { TaskView } from '../../../lib/bureau-tasks.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorldStub,
} from '../../../lib/bureau-world.test-support.ts';
import { router } from '../../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { STATUS_WORDS } from '../../../lib/status.ts';
import { landAt } from '../../chat/pages.test-support.ts';
import { filterLabelOf } from './run-rows.ts';
import { STARTED_BY_KINDS, STARTED_BY_LABELS } from './started-by.ts';

let stub: BureauWorldStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

/** Daily summary, which missed four fires while the host was down. */
const DAILY_SUMMARY: BureauSchedule = {
  id: 'daily-summary',
  owner: 'anonymous:local',
  agentName: 'assistant',
  inputPreview: 'Summarize what happened yesterday.',
  continuesChat: false,
  workflowType: 'agentRun',
  description: 'Daily summary',
  cronExpression: '0 9 * * *',
  intervalMs: null,
  status: 'active',
  overlap: 'skip',
  revision: 1,
  timeZone: 'UTC',
  nextFireAt: null,
  skippedOccurrences: [],
  lastFireAt: null,
  missedFireCount: 4,
  skippedCount: 0,
  createdAt: '2026-10-19T08:00:00.000Z',
  updatedAt: '2026-10-19T08:00:00.000Z',
  blocker: null,
};

function open(
  path: string,
  options: {
    readonly tasks?: readonly TaskView[];
    readonly schedules?: readonly BureauSchedule[];
    /** Makes the Bureau refuse to list the schedules. */
    readonly schedulesFail?: boolean;
  } = {},
) {
  stub = installBureauWorld(
    emptyBureauWorld({
      tasks: [
        taskFixture({ id: 'run-1', contextId: 'chat-1', agentName: 'echo', status: 'completed' }),
        taskFixture({ id: 'run-2', contextId: 'handle-2', agentName: 'echo', status: 'failed' }),
        ...(options.tasks ?? []),
      ],
    }),
  );
  stub.on('bureau.goals.list', () => ({
    goals: [
      goalFixture('goal-1', {
        agentName: 'planner',
        attempts: [goalAttemptFixture('goal-1-a0')],
      }),
    ],
    nextOffset: null,
  }));
  stub.on('bureau.contexts.list', () => ({
    contexts: [contextFixture('chat-1', { title: 'Plan the week' })],
    nextOffset: null,
  }));
  stub.on('bureau.agents.list', () => ({ agents: [] }));
  stub.on('bureau.schedules.list', () => {
    if (options.schedulesFail === true) {
      throw new StubFault('Forbidden', 403, 'The schedules are not this caller’s to read.');
    }
    return { schedules: options.schedules ?? [], nextOffset: null };
  });
  stub.on('bureau.schedules.missed', () => ({
    missed: ['2026-10-30T09:00:00.000Z', '2026-10-31T09:00:00.000Z'].map((occurrence) => ({
      occurrence,
      reason: 'late',
      count: 1,
      recordedAt: '2026-10-31T09:05:00.000Z',
    })),
  }));
  landAt(path);
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

const rowIds = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-run]')].map((row) => row.getAttribute('data-run'));

/** A status segment by its word and its count, which are its accessible name together. */
function segment(view: ReturnType<typeof open>, word: string, count: number): HTMLElement {
  return view.getByRole('radio', { name: new RegExp(`^${word}\\s*,\\s*${String(count)}$`) });
}

describe('the status segments', () => {
  test('count every run, and one chosen narrows the list through the address', async () => {
    const view = open('/runs');
    await waitFor(() => expect(rowIds(view.container)).toHaveLength(3));
    // Two runs finished (a task and a goal's attempt), one failed.
    expect(segment(view, 'All', 3)).not.toBeNull();
    expect(segment(view, 'Waiting on you', 0)).not.toBeNull();
    expect(segment(view, 'Running', 0)).not.toBeNull();
    expect(segment(view, 'Done', 2)).not.toBeNull();
    expect(segment(view, 'Canceled', 0)).not.toBeNull();

    await fireEvent.click(segment(view, 'Failed', 1));
    await waitFor(() => expect(router.search.get('status')).toBe('failed'));
    await waitFor(() => expect(rowIds(view.container)).toEqual(['run-2']));
    // The counts are of every status, whichever is chosen.
    expect(segment(view, 'All', 3)).not.toBeNull();

    await fireEvent.click(segment(view, 'All', 3));
    await waitFor(() => expect(router.search.get('status')).toBeNull());
  });

  test('a status that matches none is the filtered empty state, and every count stays', async () => {
    const view = open('/runs?status=canceled');
    await view.findByRole('heading', { level: 2, name: TASK_COPY.noMatch.title });
    expect(view.container.querySelector('[data-cinder-kind="filtered"]')).not.toBeNull();
    expect(segment(view, 'Canceled', 0)).not.toBeNull();
    expect(segment(view, 'All', 3)).not.toBeNull();

    const clear = view.container.querySelector<HTMLButtonElement>(
      '[data-cinder-kind="filtered"] button',
    );
    if (clear === null) throw new Error('The empty state did not offer Clear filters.');
    expect(clear.textContent).toContain(TASK_COPY.clearAction);
    await fireEvent.click(clear);
    await waitFor(() => expect(router.search.get('status')).toBeNull());
    await waitFor(() => expect(rowIds(view.container)).toHaveLength(3));
  });

  test('count only what the other filters leave, so a filter that matches nothing reads 0 in each', async () => {
    const view = open('/runs?agent=model-switcher');
    await view.findByRole('heading', { level: 2, name: TASK_COPY.noMatch.title });
    for (const word of ['All', 'Waiting on you', 'Running', 'Done', 'Failed', 'Canceled']) {
      expect(segment(view, word, 0)).not.toBeNull();
    }
  });
});

describe('the Started by and Agent chips', () => {
  test('Started by offers every kind of origin, and the one chosen narrows the list', async () => {
    const view = open('/runs');
    await waitFor(() => expect(rowIds(view.container)).toHaveLength(3));
    await fireEvent.click(view.getByRole('button', { name: TASK_COPY.startedByLabel }));
    flushSync();
    await waitFor(() =>
      expect(document.querySelector('.cinder-filter-bar__options')).not.toBeNull(),
    );
    const radios = [
      ...document.querySelectorAll<HTMLInputElement>(
        '.cinder-filter-bar__options input[type="radio"]',
      ),
    ];
    expect(radios.map((radio) => radio.value)).toEqual([...STARTED_BY_KINDS]);
    expect(radios.map((radio) => radio.value)).not.toContain('agent-run');

    await fireEvent.click(radios[STARTED_BY_KINDS.indexOf('goal')]!);
    await waitFor(() => expect(router.search.get('startedBy')).toBe('goal'));
    await waitFor(() => expect(rowIds(view.container)).toEqual(['goal-1-a0']));
  });

  test('an applied chip names its choice, and its x takes it out of the address', async () => {
    const view = open('/runs?startedBy=goal');
    await waitFor(() => expect(rowIds(view.container)).toEqual(['goal-1-a0']));
    const remove = view.getByRole('button', {
      name: `Remove filter: ${TASK_COPY.startedByLabel}: ${STARTED_BY_LABELS.goal}`,
    });
    await fireEvent.click(remove);
    await waitFor(() => expect(router.search.get('startedBy')).toBeNull());
    await waitFor(() => expect(rowIds(view.container)).toHaveLength(3));
  });

  test('a long agent name is cut on the chip, and the address keeps the whole name (COR-1862)', async () => {
    const LONG = `responsive-agent-${'a'.repeat(47)}`;
    const view = open(`/runs?agent=${LONG}`);
    await view.findByRole('heading', { level: 2, name: TASK_COPY.noMatch.title });
    const label = filterLabelOf(agentLabel(LONG, []));
    expect(
      view.getByRole('button', { name: `Remove filter: ${TASK_COPY.agentLabel}: ${label}` }),
    ).not.toBeNull();
    expect(view.container.textContent).not.toContain(LONG);
    expect(router.search.get('agent')).toBe(LONG);
  });
});

describe('Search runs', () => {
  test('narrows by the words typed, kept in the address', async () => {
    const view = open('/runs');
    await waitFor(() => expect(rowIds(view.container)).toHaveLength(3));
    const box = view.getByPlaceholderText(TASK_COPY.list.searchPlaceholder);
    await fireEvent.input(box, { target: { value: 'plan the' } });
    await waitFor(() => expect(router.search.get('q')).toBe('plan the'));
    await waitFor(() => expect(rowIds(view.container)).toEqual(['run-1']));
  });
});

describe('the records page', () => {
  test('has a header with a description and Start run as its "+", and a status word on every row', async () => {
    const view = open('/runs');
    await waitFor(() => expect(rowIds(view.container)).toHaveLength(3));
    expect(
      view.getAllByRole('heading', { level: 1, name: TASK_COPY.listHeading }).length,
    ).toBeGreaterThan(0);
    expect(view.container.textContent).toContain(TASK_COPY.list.description);
    const start = view.getByRole('link', { name: TASK_COPY.startRun });
    expect(start.getAttribute('href')).toBe('/runs/new');

    const words = [...view.container.querySelectorAll('[data-run]')].map((row) =>
      row.getAttribute('data-status'),
    );
    for (const word of words) {
      expect([...STATUS_WORDS, 'Check not met'] as readonly (string | null)[]).toContain(word);
    }
    expect(view.container.querySelectorAll('[data-run] [data-cinder-status]').length).toBe(3);
    // The rows sit under day bands, and line two never joins its parts with a middle dot.
    expect(view.container.querySelector('.cinder-data-list-group__header')).not.toBeNull();
    expect(view.container.querySelector('[data-run="run-1"]')?.textContent).toContain(
      'Plan the week',
    );
    for (const id of rowIds(view.container)) {
      expect(
        view.container.querySelector(`[data-run="${id ?? ''}"]`)?.textContent ?? '',
      ).not.toContain(String.fromCodePoint(0xb7));
    }
  });

  test('shows ten runs, says how many there are, and Load more shows the rest', async () => {
    const extra = Array.from({ length: 12 }, (_, index) =>
      taskFixture({ id: `extra-${String(index)}`, status: 'completed' }),
    );
    const view = open('/runs', { tasks: extra });
    await waitFor(() => expect(rowIds(view.container)).toHaveLength(10));
    expect(view.container.textContent).toContain('Showing 10 of 15');

    await fireEvent.click(view.getByRole('button', { name: TASK_COPY.loadMore }));
    await waitFor(() => expect(rowIds(view.container)).toHaveLength(15));
    expect(view.queryByRole('button', { name: TASK_COPY.loadMore })).toBeNull();
  });

  test('reads every page of the runs, so the counts are of all of them', async () => {
    const many = Array.from({ length: 150 }, (_, index) =>
      taskFixture({ id: `many-${String(index)}`, status: 'failed' }),
    );
    const view = open('/runs', { tasks: many });
    await waitFor(() => expect(segment(view, 'Failed', 151)).not.toBeNull());
    const reads = stub?.callsTo('bureau.tasks.list').filter((call) => call.params['limit'] === 100);
    expect(reads?.some((call) => typeof call.params['pageToken'] === 'string')).toBe(true);
  });
});

describe('the runs a schedule missed', () => {
  test('are one collapsed row that opens onto its occurrences and a link to the schedule', async () => {
    const view = open('/runs', { schedules: [DAILY_SUMMARY] });
    const row = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>(
        '[data-missed-schedule="daily-summary"]',
      );
      if (found === null) throw new Error('The missed row is not listed yet.');
      return found;
    });
    expect(row.textContent).toContain('Daily summary');
    expect(row.textContent).toContain('Missed runs');
    expect(row.textContent).toContain('missed 2 times since');

    await fireEvent.click(within(row).getByRole('button', { name: /Show/ }));
    const occurrences = within(row).getByRole('list', {
      name: TASK_COPY.list.missed.occurrencesLabel,
    });
    expect(within(occurrences).getAllByRole('listitem')).toHaveLength(2);
    // The occurrences are not runs: none is a row or a link of its own.
    expect(occurrences.querySelector('a')).toBeNull();
    expect(
      within(row)
        .getByRole('link', { name: TASK_COPY.list.missed.viewSchedule })
        .getAttribute('href'),
    ).toBe('/schedules/daily-summary');
  });

  test('are left out of a filtered list, which is about runs', async () => {
    const view = open('/runs?status=failed', { schedules: [DAILY_SUMMARY] });
    await waitFor(() => expect(rowIds(view.container)).toEqual(['run-2']));
    await waitFor(() =>
      expect(stub?.callsTo('bureau.schedules.missed').length ?? 0).toBeGreaterThan(0),
    );
    expect(view.container.querySelector('[data-missed-schedule]')).toBeNull();
  });

  test('never fail the list when the schedules cannot be read', async () => {
    const view = open('/runs', { schedulesFail: true });
    await waitFor(() => expect(rowIds(view.container)).toHaveLength(3));
    expect(view.queryByRole('heading', { level: 2, name: TASK_COPY.loadFailed.title })).toBeNull();
  });
});

describe('opening from a row', () => {
  test('a run opens in place, and a modified click is left to the browser', async () => {
    const view = open('/runs');
    await waitFor(() => expect(rowIds(view.container).length).toBe(3));
    const link = view.container.querySelector<HTMLAnchorElement>('[data-run="run-2"] a');
    if (link === null) throw new Error('The run’s link did not render.');

    expect(await fireEvent.click(link, { button: 0, altKey: true })).toBe(true);
    expect(router.pathname).toBe('/runs');
    expect(await fireEvent.click(link, { button: 0 })).toBe(false);
    expect(router.pathname).toBe('/runs/run-2');
  });
});
