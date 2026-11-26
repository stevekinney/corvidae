/**
 * `/runs` as a person works it (COR-2017): the status segments with their counts, the Started by
 * and Agent chips and Search runs narrow the list through the address; the rows are status first
 * under day bands, ten at a time with Load more; the runs a schedule missed are one collapsed row
 * that opens onto its occurrences; and a run opens in place from its row. Through the route outlet,
 * over a Bureau that answers from a table.
 */
import { HttpClient } from '@lostgradient/weft/testing';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { flushSync } from 'svelte';

import { RUN_ATTENTION_COPY } from '../../../app/copy/run-attention.ts';
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
import { readyAgent, StubFault } from '../../../lib/bureau-stub.test-support.ts';
import type { TaskView } from '../../../lib/bureau-tasks.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorldStub,
} from '../../../lib/bureau-world.test-support.ts';
import { router } from '../../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES, type AuthorizationScope } from '../../../lib/scopes.svelte.ts';
import { STATUS_WORDS } from '../../../lib/status.ts';
import { landAt } from '../../chat/pages.test-support.ts';
import { filterLabelOf } from './run-rows.ts';
import { STARTED_BY_FILTER_LABELS, STARTED_BY_KINDS, STARTED_BY_LABELS } from './started-by.ts';

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
  target: { kind: 'agent', agentName: 'assistant' },
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
    /** The scopes the caller holds; every one unless a test narrows them. */
    readonly scopes?: readonly AuthorizationScope[];
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
      scopes: options.scopes ?? AUTHORIZATION_SCOPES,
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

/** A run that failed at `step`, and one that is on a later try of `retrying`'s step (COR-2535). */
const CHARGE_FAILED = taskFixture({
  id: 'charge-failed',
  contextId: 'handle-3',
  agentName: 'echo',
  status: 'failed',
  failure: {
    step: { index: 2, label: 'charge-card' },
    errorCode: 'tool-failed',
    errorKind: 'tool',
    toolCall: { name: 'charge-card', callId: 'call-1' },
  },
});
const MODEL_FAILED = taskFixture({
  id: 'model-failed',
  contextId: 'handle-4',
  agentName: 'echo',
  status: 'failed',
  failure: { step: { index: 0, label: 'model' }, errorCode: null, errorKind: null, toolCall: null },
});
const CHARGE_RETRYING = taskFixture({
  id: 'charge-retrying',
  contextId: 'handle-5',
  agentName: 'echo',
  status: 'working',
  retrying: { label: 'charge-card', attempt: 3 },
});

/**
 * What the page last asked `bureau.tasks.list` for in its read of every run (a page of 100; the
 * calls with a smaller `limit` are other reads, such as a chat's last run, and the read of the
 * failed tasks that offers step names names a `status`, which this one never does: the status
 * segments are applied in the browser): every page of the read has the same filters.
 */
function lastTasksRequest(): Record<string, unknown> | undefined {
  return stub
    ?.callsTo('bureau.tasks.list')
    .map((call) => call.params)
    .findLast((params) => params['limit'] === 100 && params['status'] === undefined);
}

/**
 * Opens the bar's Filter menu on the row named `label`, where the Retrying checkbox and the
 * Failed at step field are: neither has a control in the row, which holds the segments and chips.
 */
async function openMenuRow(view: ReturnType<typeof open>, label: string): Promise<void> {
  if (document.querySelector('.cinder-filter-bar__menu') === null) {
    await fireEvent.click(view.getByRole('button', { name: 'Filter' }));
    flushSync();
  }
  const row = [
    ...document.querySelectorAll<HTMLButtonElement>('.cinder-filter-bar__menu-row'),
  ].find((candidate) => candidate.textContent?.includes(label));
  if (row === undefined) throw new Error(`The Filter menu has no row for ${label}.`);
  if (row.getAttribute('aria-expanded') !== 'true') await fireEvent.click(row);
  flushSync();
}

/**
 * The open Filter menu's controls, by selector: the menu is a popover outside the page's tree,
 * which a query by role does not reach. Only the open row's control is in the menu.
 */
function menuCheckbox(): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(
    '.cinder-filter-bar__menu input[type="checkbox"]',
  );
  if (found === null) throw new Error('The Filter menu holds no checkbox.');
  return found;
}

function menuField(): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(
    `.cinder-filter-bar__menu input[aria-label="${TASK_COPY.failedStepLabel}"]`,
  );
  if (found === null) throw new Error('The Filter menu holds no Failed at step field.');
  return found;
}

describe('the Retrying and Failed at step filters (COR-2535)', () => {
  const failures = [CHARGE_FAILED, MODEL_FAILED, CHARGE_RETRYING];

  test('neither has a control in the row: one Filter button holds them, so the segments and chips keep their room', async () => {
    const view = open('/runs', { tasks: failures });
    await waitFor(() => expect(rowIds(view.container)).toHaveLength(6));
    const bar = view.getByRole('search', { name: TASK_COPY.filtersLabel });
    expect(bar.querySelector('.cinder-filter-bar__toggle')).toBeNull();
    expect(bar.querySelector('input[role="combobox"]')).toBeNull();
    expect(bar.querySelectorAll('.cinder-filter-bar__menu-button')).toHaveLength(1);
    expect(view.getByRole('radio', { name: /^All\s*,\s*6$/ })).not.toBeNull();
    for (const chip of [TASK_COPY.startedByLabel, TASK_COPY.workflowLabel, TASK_COPY.agentLabel]) {
      expect(view.getByRole('button', { name: chip })).not.toBeNull();
    }
    await openMenuRow(view, TASK_COPY.retryingLabel);
    const rows = [...document.querySelectorAll('.cinder-filter-bar__menu-label')].map(
      (label) => label.textContent,
    );
    expect(rows).toEqual([
      RUN_ATTENTION_COPY.filter,
      TASK_COPY.retryingLabel,
      TASK_COPY.failedStepLabel,
    ]);
  });

  test('while one is on, the row shows it as a chip named with its value, and the chip removes it', async () => {
    const view = open('/runs?retrying=true&failedStep=charge-card', { tasks: failures });
    await view.findByRole('heading', { level: 2, name: TASK_COPY.noMatch.title });
    expect(
      view.getByRole('button', {
        name: `Remove filter: ${TASK_COPY.retryingLabel}: ${TASK_COPY.retryingOn}`,
      }),
    ).not.toBeNull();
    await fireEvent.click(
      view.getByRole('button', { name: 'Remove filter: Failed at step: charge-card' }),
    );
    await waitFor(() => expect(router.search.get('failedStep')).toBeNull());
    expect(router.search.get('retrying')).toBe('true');
  });

  test('Retrying narrows the read to the runs retrying a step, and the row says which and its try', async () => {
    const view = open('/runs', { tasks: failures });
    await waitFor(() => expect(rowIds(view.container)).toHaveLength(6));
    expect(lastTasksRequest()).not.toHaveProperty('retrying');
    // The step names come from the list itself while nothing narrows it: no other read is made.
    expect(
      stub?.callsTo('bureau.tasks.list').some((call) => call.params['status'] === 'failed'),
    ).toBe(false);

    await openMenuRow(view, TASK_COPY.retryingLabel);
    await fireEvent.click(menuCheckbox());
    await waitFor(() => expect(router.search.get('retrying')).toBe('true'));
    await waitFor(() => expect(rowIds(view.container)).toEqual(['charge-retrying']));
    expect(lastTasksRequest()).toMatchObject({ retrying: true });
    expect(
      view.container.querySelector(
        '[data-run="charge-retrying"] .cinder-stacked-list-item__line-two',
      )?.textContent,
    ).toContain('retrying charge-card, try 3');
  });

  test('Failed at step suggests the steps the runs failed at, and a chosen one narrows the read', async () => {
    const view = open('/runs', { tasks: failures });
    await waitFor(() => expect(rowIds(view.container)).toHaveLength(6));
    await openMenuRow(view, TASK_COPY.failedStepLabel);
    const field = menuField();
    await fireEvent.focus(field);
    await fireEvent.input(field, { target: { value: 'c' } });
    await waitFor(() =>
      expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0),
    );
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map((option) => option.textContent?.trim())).toEqual(['charge-card']);
    // The listbox completes on the pointer going down, as a person's press does.
    await fireEvent.mouseDown(options[0]!);

    await waitFor(() => expect(router.search.get('failedStep')).toBe('charge-card'));
    await waitFor(() => expect(rowIds(view.container)).toEqual(['charge-failed']));
    expect(lastTasksRequest()).toMatchObject({ failedStep: 'charge-card' });
  });

  test('a typed name is kept on Enter, never on each key, and emptying the field takes it out', async () => {
    const view = open('/runs', { tasks: failures });
    await waitFor(() => expect(rowIds(view.container)).toHaveLength(6));
    await openMenuRow(view, TASK_COPY.failedStepLabel);
    const field = menuField();
    await fireEvent.input(field, { target: { value: 'mod' } });
    expect(router.search.get('failedStep')).toBeNull();
    await fireEvent.input(field, { target: { value: 'model' } });
    expect(router.search.get('failedStep')).toBeNull();
    await fireEvent.submit(field.closest('form')!);

    await waitFor(() => expect(router.search.get('failedStep')).toBe('model'));
    await waitFor(() => expect(rowIds(view.container)).toEqual(['model-failed']));

    await fireEvent.input(field, { target: { value: '' } });
    await waitFor(() => expect(router.search.get('failedStep')).toBeNull());
    await waitFor(() => expect(rowIds(view.container)).toHaveLength(6));
  });

  test('an address carrying both, with the other filters, restores the filtered list', async () => {
    const view = open('/runs?status=failed&agent=echo&failedStep=charge-card', {
      tasks: failures,
    });
    await waitFor(() => expect(rowIds(view.container)).toEqual(['charge-failed']));
    expect(lastTasksRequest()).toMatchObject({ failedStep: 'charge-card' });
    // The row says it, with its label, and the field in the menu holds it.
    expect(
      view.getByRole('button', { name: 'Remove filter: Failed at step: charge-card' }),
    ).not.toBeNull();
    await openMenuRow(view, TASK_COPY.failedStepLabel);
    expect(menuField().value).toBe('charge-card');
    // The other filters of the address are applied with it: the agent has its chip.
    expect(view.getByRole('button', { name: 'Remove filter: Agent: Echo' })).not.toBeNull();
  });

  test('a filter the Bureau leaves nothing for is a filtered list, not a first use', async () => {
    const view = open('/runs?failedStep=nothing-fails-here', { tasks: failures });
    await view.findByRole('heading', { level: 2, name: TASK_COPY.noMatch.title });
    expect(
      view.getByText('No runs that failed at nothing-fails-here. Try another step.'),
    ).not.toBeNull();
    // The bar stays, with its chip and its menu, so another step can be tried.
    expect(
      view.getByRole('button', { name: 'Remove filter: Failed at step: nothing-fails-here' }),
    ).not.toBeNull();
    await openMenuRow(view, TASK_COPY.failedStepLabel);
    expect(menuField()).not.toBeNull();
    expect(view.queryByText(TASK_COPY.empty.title)).toBeNull();
  });

  test('both are kept when another filter changes', async () => {
    const view = open('/runs?retrying=true&failedStep=model', { tasks: failures });
    await view.findByRole('heading', { level: 2, name: TASK_COPY.noMatch.title });
    expect(lastTasksRequest()).toMatchObject({ retrying: true, failedStep: 'model' });
    await fireEvent.click(view.getByRole('radio', { name: /^Failed\s*,\s*\d+$/ }));
    await waitFor(() => expect(router.search.get('status')).toBe('failed'));
    expect(router.search.get('retrying')).toBe('true');
    expect(router.search.get('failedStep')).toBe('model');
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
    // The chip reads "Started by: Goals" (row 52x), the plural of what started the runs.
    const remove = view.getByRole('button', { name: 'Remove filter: Started by: Goals' });
    expect(STARTED_BY_FILTER_LABELS.goal).toBe('Goals');
    expect(STARTED_BY_LABELS.goal).toBe('A goal');
    await fireEvent.click(remove);
    await waitFor(() => expect(router.search.get('startedBy')).toBeNull());
    await waitFor(() => expect(rowIds(view.container)).toHaveLength(3));
  });

  test('Workflow offers the workflows the runs ran, by name, and the one chosen narrows the list (row 52d)', async () => {
    const notes = taskFixture({
      id: 'notes-run',
      contextId: 'notes-run',
      kind: 'catalog',
      agentName: null,
      status: 'completed',
      origin: { kind: 'api' },
      workflow: {
        type: 'release-notes',
        scheduleId: null,
        scheduleName: null,
        tick: null,
        steps: { total: 4, at: 4 },
        awaitingSignal: null,
      },
    });
    const view = open('/runs', { tasks: [notes] });
    await waitFor(() => expect(rowIds(view.container)).toHaveLength(4));
    await fireEvent.click(view.getByRole('button', { name: TASK_COPY.workflowLabel }));
    flushSync();
    await waitFor(() =>
      expect(document.querySelector('.cinder-filter-bar__options')).not.toBeNull(),
    );
    const radios = [
      ...document.querySelectorAll<HTMLInputElement>(
        '.cinder-filter-bar__options input[type="radio"]',
      ),
    ];
    // The goal's attempt and the ordinary runs are workflows too, each named as a person reads it.
    expect(radios.map((radio) => radio.value)).toEqual(['release-notes', 'goalRun']);

    await fireEvent.click(radios[0]!);
    await waitFor(() => expect(router.search.get('workflow')).toBe('release-notes'));
    await waitFor(() => expect(rowIds(view.container)).toEqual(['notes-run']));
    expect(
      view.getByRole('button', { name: 'Remove filter: Workflow: Release notes' }),
    ).not.toBeNull();
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
    // The list fills the content column, so its rows take the phone form from the window: on a
    // tablet beside the rail the status leads in its column (row 05x).
    for (const row of view.container.querySelectorAll('li[data-run]')) {
      expect(row.getAttribute('data-cinder-phone-width')).toBe('viewport');
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

describe('a schedule’s run that is due', () => {
  test('says what holds its schedule before its agent: the file that cannot load and no provider (row 10h)', async () => {
    const due = new Date(Date.now() + 3_600_000).toISOString();
    const view = open('/runs', {
      tasks: [
        taskFixture({
          id: 'audit-run',
          contextId: 'audit-session',
          kind: 'schedule-fire',
          agentName: 'tool-runner',
          status: 'working',
          origin: { kind: 'schedule', scheduleId: 'weekly-audit', fireId: 'fire-1' },
          wakeAt: due,
        }),
      ],
      schedules: [
        {
          ...DAILY_SUMMARY,
          id: 'weekly-audit',
          description: 'Weekly refund audit',
          workflowType: 'order-refund',
          missedFireCount: 0,
          blocker: { kind: 'workflow-cannot-load', workflow: 'order-refund', message: 'broken' },
        },
      ],
    });
    // No provider is connected, and Tool runner's definition names a model.
    stub?.on('bureau.health.attention', () => ({
      items: [{ kind: 'no-provider', severity: 'warning' }],
    }));
    stub?.on('bureau.agents.definitions.get', () =>
      readyAgent({ id: 'tool-runner', name: 'Tool runner' }),
    );

    const row = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('[data-run="audit-run"]');
      if (found === null) throw new Error('The due run is not listed yet.');
      return found;
    });
    expect(row.getAttribute('data-status')).toBe('Scheduled');
    const meta = () =>
      view.container.querySelector('[data-run="audit-run"] .cinder-stacked-list-item__meta')
        ?.textContent ?? '';
    await waitFor(() =>
      expect(meta()).toMatch(
        /^Schedule, Order refund can’t load, no provider is connected, Tool runner, due /,
      ),
    );
  });

  test('asks whether a provider is connected only while a schedule’s run is due', async () => {
    const view = open('/runs');
    await waitFor(() => expect(rowIds(view.container).length).toBeGreaterThan(0));
    expect(stub?.callsTo('bureau.health.attention')).toEqual([]);
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
    // It follows the window, leads its line two once with the status on a phone (`wrapMeta`), and
    // keeps the whole line as its tooltip (rows 05w, 05x).
    expect(row.getAttribute('data-cinder-phone-width')).toBe('viewport');
    expect(row.classList.contains('cinder-stacked-list-item--wrap-meta')).toBe(true);
    expect(row.querySelector('[title*="missed 2 times since"]')).not.toBeNull();

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

  test('say how many in the status, named "Missed runs, 2", the count its own piece with no separator (row 09q)', async () => {
    const view = open('/runs', { schedules: [DAILY_SUMMARY] });
    const row = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>(
        '[data-missed-schedule="daily-summary"]',
      );
      if (found === null) throw new Error('The missed row is not listed yet.');
      return found;
    });
    const status = within(row).getByRole('img', { name: 'Missed runs, 2' });
    // The word, then the count as its own muted piece: no comma, no middle dot in what shows.
    expect(status.querySelector('.cinder-status-dot__qualifier')?.textContent).toBe('2');
    expect(status.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe('Missed runs 2');
    expect(status.textContent).not.toContain(String.fromCodePoint(0xb7));
    expect(status.getAttribute('data-cinder-status')).toBe('warning');
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

describe('a run only the workflow engine holds (COR-2424)', () => {
  /** What the Bureau lists for the schedule tick: no agent, and its own identifier for a context. */
  const TICK = taskFixture({
    id: 'tick-1',
    contextId: 'tick-1',
    kind: 'catalog',
    agentName: null,
    status: 'completed',
    origin: { kind: 'system' },
    workflow: {
      type: 'scheduleTick',
      scheduleId: 'daily-summary',
      scheduleName: 'Daily summary',
      tick: { event: 'missed-runs', missedRuns: 4, whileStopped: true },
      steps: null,
      awaitingSignal: null,
    },
  });

  test('opens its page for a caller who may read the engine, which serves it read-only', async () => {
    const view = open('/runs', { tasks: [TICK] });
    await waitFor(() => expect(rowIds(view.container)).toContain('tick-1'));

    const link = view.container.querySelector<HTMLAnchorElement>('[data-run="tick-1"] a');
    expect(link?.getAttribute('href')).toBe('/runs/tick-1');
  });

  test('does not open for a caller who may not, and says what it needs, so no row leads to a page that is not found', async () => {
    const view = open('/runs', {
      tasks: [TICK],
      scopes: AUTHORIZATION_SCOPES.filter((scope) => scope !== 'workflows:read'),
    });
    await waitFor(() => expect(rowIds(view.container)).toContain('tick-1'));

    const row = view.container.querySelector('[data-run="tick-1"]');
    expect(row?.querySelector('a')).toBeNull();
    expect(row?.textContent).toContain(TASK_COPY.list.engineRunLocked);
    // The Bureau's own tasks still open: only the engine's runs need the engine.
    expect(view.container.querySelector('[data-run="run-1"] a')?.getAttribute('href')).toBe(
      '/runs/run-1',
    );
  });
});
