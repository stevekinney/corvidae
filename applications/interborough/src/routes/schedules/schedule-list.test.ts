/**
 * `<ScheduleList>` on the sample world's four schedules, against `installWorkflowWorld`, a stand-in
 * for the engine and the Bureau that keeps the schedules, workflow files and what needs attention
 * as a world a test can change: Daily summary (Assistant, four missed runs), Weekly refund audit
 * (its workflow's file can't load, so the Bureau holds it), Release notes digest (a workflow file's
 * trigger) and Inbox triage (paused). Each row is the status-first two-line row, one link to its
 * schedule, with no menu of actions.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { router } from '../../lib/router.svelte.ts';
import {
  codeDefinition,
  emptyWorld,
  installWorkflowWorld,
  invalidFile,
  readyFile,
  scheduleFixture,
  sourceDefinition,
  type WorkflowStub,
  type World,
} from '../../lib/workflow-world.test-support.ts';
import IndexHarness from './index-test-harness.test-harness.svelte';

const DAY = 24 * 3_600_000;
let stub: WorkflowStub | undefined;

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
  Reflect.deleteProperty(window, 'matchMedia');
});

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
});

const REFUND_SCHEDULE = 'bureau-workflow-schedule:order-refund:1';
const RELEASE_SCHEDULE = 'bureau-workflow-schedule:release-notes:1';
const INBOX_SCHEDULE = 'bureau-workflow-schedule:triage-inbox:1';

/** The sample world's schedules, counted from now so "next" and "last" are always in the right place. */
function sampleWorld(overrides: Partial<World> = {}): World {
  const now = Date.now();
  return emptyWorld({
    definitions: [
      codeDefinition('agentRun'),
      sourceDefinition('release-notes'),
      sourceDefinition('triage-inbox'),
    ],
    files: [
      readyFile('release-notes', {
        title: 'Release notes',
        trigger: { kind: 'schedule', spec: '0 11 * * 5', input: { branch: 'main' } },
        steps: [{ handler: 'agent', input: { agent: 'assistant' } }],
        schedule: { id: RELEASE_SCHEDULE, status: 'active', nextFireAt: null },
      }),
      invalidFile('order-refund'),
      readyFile('triage-inbox', {
        title: 'Triage inbox',
        paused: true,
        trigger: { kind: 'schedule', spec: '0 8 * * *' },
        steps: [{ handler: 'agent', input: { agent: 'assistant' } }],
        schedule: { id: INBOX_SCHEDULE, status: 'paused', nextFireAt: null },
      }),
    ],
    schedules: [
      scheduleFixture('daily', 'agentRun', {
        description: 'Daily summary',
        cronExpression: '0 9 * * *',
        missedFireCount: 4,
        lastFireAt: now - 4 * DAY,
        nextFireAt: now + DAY,
      }),
      scheduleFixture(INBOX_SCHEDULE, 'triage-inbox', {
        description: 'Inbox triage',
        status: 'paused',
        cronExpression: '0 8 * * *',
        lastFireAt: now - 9 * DAY,
        nextFireAt: now - 8 * DAY,
      }),
      scheduleFixture(RELEASE_SCHEDULE, 'release-notes', {
        description: 'Release notes digest',
        cronExpression: '0 11 * * 5',
        lastFireAt: now - 3 * DAY,
        nextFireAt: now + 4 * DAY,
      }),
      scheduleFixture(REFUND_SCHEDULE, 'order-refund', {
        description: 'Weekly refund audit',
        status: 'paused',
        cronExpression: '0 11 * * 1',
        nextFireAt: now + 14 * 60_000,
      }),
    ],
    scheduleAgents: { daily: 'assistant' },
    scheduleBlockers: {
      [REFUND_SCHEDULE]: {
        workflow: 'order-refund',
        message: 'The file is not valid JSON.',
        status: 'active',
      },
    },
    savedSteps: { 'order-refund': [{ handler: 'agent', input: { agent: 'tool-runner' } }] },
    agentModels: { assistant: null, 'tool-runner': 'anthropic/claude-sonnet-5-5' },
    agents: [
      { name: 'assistant', displayName: 'assistant', media: null },
      { name: 'tool-runner', displayName: 'tool-runner', media: null },
    ],
    attention: [
      { kind: 'no-provider', area: 'providers', at: now - 3_600_000, provider: 'anthropic' },
      {
        kind: 'missed-runs',
        area: 'schedules',
        at: now - DAY,
        scheduleId: 'daily',
        scheduleName: 'Daily summary',
        count: 4,
        since: now - 3 * DAY,
        occurrences: [],
      },
    ],
    ...overrides,
  });
}

function open(path = '/schedules', world: World = sampleWorld(), scopes?: readonly string[]) {
  stub = installWorkflowWorld(world);
  router.navigate(path, { replace: true });
  return render(IndexHarness, {
    props: {
      client: stub.client,
      externalBureau: true,
      ...(scopes === undefined ? {} : { scopes: scopes as never }),
    },
  });
}

/** The rows, in the order they are listed. */
function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('li[data-schedule]')];
}

const titleOf = (row: HTMLElement): string =>
  row.querySelector('.cinder-stacked-list-item__title')?.textContent?.trim() ?? '';

const lineTwoOf = (row: HTMLElement): string =>
  (row.querySelector('.cinder-stacked-list-item__meta')?.textContent ?? '')
    .replaceAll(/\s+/g, ' ')
    .trim();

const nextOf = (row: HTMLElement): string =>
  row.querySelector('[data-testid="schedule-next"]')?.textContent?.trim() ?? '';

/** A filter segment by its word and its count, whose accessible name is "All, 4". */
function segment(view: ReturnType<typeof within>, word: string, count: number): HTMLElement {
  return view.getByRole('radio', { name: new RegExp(`^${word}\\s*,\\s*${String(count)}$`) });
}

/** The list once the Bureau has said what the schedules start and what needs attention. */
async function listed(container: HTMLElement): Promise<HTMLElement[]> {
  await waitFor(() => {
    const listed = rows(container);
    expect(listed).toHaveLength(4);
    // The workflow whose file can't load has its agent from the last saved version.
    expect(lineTwoOf(listed[1] as HTMLElement)).toContain('Tool runner');
  });
  return rows(container);
}

describe('the heading and the header action', () => {
  test('is Schedules, with its timetable subtitle and a "+" that makes a schedule', async () => {
    const { container, findByRole } = open();
    await listed(container);

    expect(within(container).getByRole('heading', { level: 1, name: 'Schedules' })).not.toBeNull();
    expect(container.textContent).toMatch(/Runs that start on a timetable\. Times are in .+\./);
    const create = await findByRole('button', { name: 'New schedule' });
    expect(create.textContent?.trim()).toBe('');
    expect(create.getAttribute('data-cinder-variant')).toBe('secondary');
    await fireEvent.click(create);
    expect(router.pathname).toBe('/schedules/new');
  });

  test('is inert, and says why, for a caller who may not write schedules', async () => {
    const { container, findByRole } = open('/schedules', sampleWorld(), ['schedules:read']);
    await listed(container);

    const create = await findByRole('button', { name: 'New schedule' });
    expect(create.getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(create);
    expect(router.pathname).toBe('/schedules');
  });
});

describe('the rows', () => {
  test('are listed with the schedule that missed runs first, then the active ones soonest first, then the paused', async () => {
    const { container } = open();
    const listedRows = await listed(container);

    expect(listedRows.map(titleOf)).toEqual([
      'Daily summary',
      'Weekly refund audit',
      'Release notes digest',
      'Inbox triage',
    ]);
    expect(listedRows.map((row) => row.dataset['statusWord'])).toEqual([
      'Missed runs · 4',
      'Active',
      'Active',
      'Paused',
    ]);
  });

  test('say the next run at the right: the day and time, due and won’t start, or no next run', async () => {
    const { container } = open();
    const [daily, refund, release, inbox] = await listed(container);

    expect(nextOf(daily as HTMLElement)).toMatch(/^Next /);
    expect(nextOf(refund as HTMLElement)).toMatch(/^Due .+ · won’t start$/);
    expect(
      (refund as HTMLElement)
        .querySelector('[data-testid="schedule-next"]')
        ?.getAttribute('data-tone'),
    ).toBe('warning');
    expect(nextOf(release as HTMLElement)).toMatch(/^Next /);
    expect(nextOf(inbox as HTMLElement)).toBe('No next run');
  });

  test('say the kind first on line two, and a reason straight after it', async () => {
    const { container } = open();
    const [daily, refund, release, inbox] = await listed(container);

    expect(lineTwoOf(daily as HTMLElement)).toMatch(
      /^Workflow · Chat with an agent · Assistant · Every day at .+ · Last run [A-Z][a-z]{2} \d{1,2}$/,
    );
    expect(lineTwoOf(refund as HTMLElement)).toMatch(
      /^Workflow · order-refund can’t load · Tool runner · Every Monday at .+ · Never run$/,
    );
    // The workflow's file name is small and monospaced, and "can't load" is in red.
    const reason = (refund as HTMLElement).querySelector('code.ib-identifier');
    expect(reason?.textContent).toBe('order-refund');
    expect(
      (refund as HTMLElement)
        .querySelector('.ib-schedule-line__part[data-tone="danger"]')
        ?.textContent?.trim(),
    ).toBe('can’t load');
    expect(lineTwoOf(release as HTMLElement)).toMatch(
      /^Workflow · Release notes · From a workflow file · Every Friday at .+ · Last run /,
    );
    expect(lineTwoOf(inbox as HTMLElement)).toMatch(
      /^Workflow · Triage inbox · Assistant · Every day at .+ · Last run /,
    );
  });

  test('are one link to the schedule, with no menu of actions', async () => {
    const { container, getAllByRole } = open();
    await listed(container);

    const link = within(rows(container)[0] as HTMLElement).getByRole('link', {
      name: 'Daily summary',
    });
    expect(link.getAttribute('href')).toBe('/schedules/daily');
    expect(getAllByRole('link', { name: /./ }).length).toBeGreaterThan(0);
    expect(container.querySelector('[aria-label^="Actions for"]')).toBeNull();
    await fireEvent.click(link);
    expect(router.pathname).toBe('/schedules/daily');
  });

  test('never put a can’t-load or provider reason on a schedule that runs a scripted agent', async () => {
    const { container } = open();
    const [daily] = await listed(container);

    expect(daily?.textContent).not.toContain('can’t load');
    expect(daily?.textContent).not.toContain('provider');
    expect(nextOf(daily as HTMLElement)).not.toContain('won’t start');
  });

  test('say a provider is missing, and not a file, for a workflow that loads when its agent needs a model', async () => {
    const world = sampleWorld();
    world.files = world.files.map((file) =>
      file.id === 'order-refund'
        ? readyFile('order-refund', {
            title: 'Order refund',
            steps: [{ handler: 'agent', input: { agent: 'tool-runner' } }],
            schedule: { id: REFUND_SCHEDULE, status: 'active', nextFireAt: null },
          })
        : file,
    );
    world.definitions.push(sourceDefinition('order-refund'));
    world.scheduleBlockers = {};
    const refund = world.schedules.find((schedule) => schedule.id === REFUND_SCHEDULE);
    if (refund === undefined) throw new Error('expected the schedule');
    refund.status = 'active';
    const { container } = open('/schedules', world);
    await waitFor(() => {
      const row = rows(container).find((candidate) => titleOf(candidate) === 'Weekly refund audit');
      expect(lineTwoOf(row as HTMLElement)).toContain('won’t run until a provider is connected');
    });
    const row = rows(container).find((candidate) => titleOf(candidate) === 'Weekly refund audit');
    expect(lineTwoOf(row as HTMLElement)).toMatch(
      /^Workflow · Order refund · won’t run until a provider is connected · Tool runner · /,
    );
    expect(lineTwoOf(row as HTMLElement)).not.toContain('can’t load');
  });
});

describe('a schedule whose workflow was deleted', () => {
  test('is Can’t find workflow, names the identifier, and has no next run', async () => {
    const world = sampleWorld();
    world.schedules.push(
      scheduleFixture('cleanup', 'weekly-cleanup', {
        description: 'Weekly cleanup',
        status: 'paused',
        cronExpression: '0 2 * * 0',
        lastFireAt: Date.now() - 8 * DAY,
      }),
    );
    world.savedSteps['weekly-cleanup'] = [{ handler: 'agent', input: { agent: 'tool-runner' } }];
    const { container } = open('/schedules', world);
    await waitFor(() => {
      const row = rows(container).find((candidate) => titleOf(candidate) === 'Weekly cleanup');
      expect(row?.dataset['statusWord']).toBe("Can't find workflow");
      // The agent comes from the workflow's last saved version, which is read after the list.
      expect(lineTwoOf(row as HTMLElement)).toContain('Tool runner');
    });
    const row = rows(container).find((candidate) => titleOf(candidate) === 'Weekly cleanup');
    expect(row?.dataset['statusKey']).toBe('cannot-find');
    expect(lineTwoOf(row as HTMLElement)).toMatch(
      /^Workflow · weekly-cleanup was deleted · Tool runner · Every Sunday at .+ · Last run /,
    );
    expect(nextOf(row as HTMLElement)).toBe('No next run');
    // The schedule itself is paused, so it counts there: All 5, Active 4, Paused 1.
    const view = within(container);
    expect(segment(view, 'All', 5)).not.toBeNull();
    expect(segment(view, 'Active', 3)).not.toBeNull();
    expect(segment(view, 'Paused', 2)).not.toBeNull();
  });
});

describe('the filters', () => {
  test('carry the counts of the segments, which partition the list, and of the Missed runs chip', async () => {
    const { container } = open();
    await listed(container);
    const view = within(container);

    expect(segment(view, 'All', 4)).not.toBeNull();
    expect(segment(view, 'Active', 3)).not.toBeNull();
    expect(segment(view, 'Paused', 1)).not.toBeNull();
    expect(view.getByRole('button', { name: /Missed runs\s*1/ })).not.toBeNull();
    // The chip is not a fourth segment: a schedule can be Active and have missed runs.
    expect(view.queryByRole('radio', { name: /Missed runs/ })).toBeNull();
  });

  test('a segment narrows the list and goes in the address', async () => {
    const { container } = open();
    await listed(container);

    await fireEvent.click(segment(within(container), 'Paused', 1));
    await waitFor(() => expect(rows(container).map(titleOf)).toEqual(['Inbox triage']));
    expect(window.location.search).toBe('?status=paused');
  });

  test('the Missed runs chip narrows to schedules that missed runs, and goes in the address', async () => {
    const { container } = open();
    await listed(container);

    await fireEvent.click(within(container).getByRole('button', { name: /Missed runs\s*1/ }));
    await waitFor(() => expect(rows(container).map(titleOf)).toEqual(['Daily summary']));
    expect(window.location.search).toBe('?missed=1');
  });

  test('an address names the filters, and the counts are those of the agent and workflow it leaves', async () => {
    const { container } = open('/schedules?agent=tool-runner&status=paused');
    await waitFor(() => expect(segment(within(container), 'All', 1)).not.toBeNull());
    const view = within(container);
    expect(segment(view, 'Active', 1)).not.toBeNull();
    expect(segment(view, 'Paused', 0)).not.toBeNull();
    // Paused with Tool runner matches nothing: the filtered empty state, which clears the filters.
    expect(await view.findByText('No matching schedules')).not.toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(window.location.search).toBe(''));
  });
});

describe('on a phone', () => {
  function phoneViewport(): void {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        media: query,
        matches: query.includes('640'),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
      }),
    });
  }

  test('the status moves to line two, the next run stays at the right of line one, and a third line says why and when', async () => {
    phoneViewport();
    const { container } = open();
    await waitFor(() => {
      const listed = rows(container);
      expect(listed).toHaveLength(4);
      expect(
        listed[1]?.querySelector('[data-testid="schedule-line-three"]')?.textContent,
      ).toContain('provider');
    });
    const [daily, refund, release, inbox] = rows(container);

    expect(lineTwoOf(daily as HTMLElement)).toBe('Workflow · Chat with an agent · Assistant');
    expect(nextOf(inbox as HTMLElement)).toBe('—');
    const third = (row: HTMLElement | undefined) =>
      (row?.querySelector('[data-testid="schedule-line-three"]')?.textContent ?? '')
        .replaceAll(/\s+/g, ' ')
        .trim();
    expect(third(daily)).toMatch(/^Missed 4 times since [A-Z][a-z]{2} \d{1,2} · every day at /);
    expect(third(refund)).toMatch(
      /^Order refund can’t load · won’t run until a provider is connected · Mondays at /,
    );
    expect(
      refund?.querySelector('[data-testid="schedule-line-three"] [data-tone="danger"]')
        ?.textContent,
    ).toBe('Order refund can’t load');
    expect(third(release)).toMatch(/^Last ran [A-Z][a-z]{2} \d{1,2} · Fridays at /);
    expect(third(inbox)).toMatch(/^Last ran [A-Z][a-z]{2} \d{1,2} · every day at /);
  });
});
