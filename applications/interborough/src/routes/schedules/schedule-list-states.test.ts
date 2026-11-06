/**
 * `<ScheduleList>` in the states that are not a list of rows (COR-2018, rows 70p–70w): nothing
 * scheduled yet, filters that match nothing, a read in progress, a read that failed with nothing to
 * show, one that failed over rows already read, and a server that stopped answering. The page keeps
 * its header in every one of them. The world is `installWorkflowWorld`'s stand-in for the engine and
 * the Bureau, whose schedule list can be made to refuse (`failSchedules`), and the timings the
 * placeholders keep run under fake timers, never a sleep.
 */
import { HttpClient } from '@lostgradient/weft';
import type { QueryClient } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';
import { flushSync } from 'svelte';

import { ConnectionMonitor } from '../../app/connection.svelte.ts';
import { SCHEDULE_COPY } from '../../app/copy.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { queryKeys } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import {
  codeDefinition,
  emptyWorld,
  installWorkflowWorld,
  scheduleFixture,
  type WorkflowStub,
  type World,
} from '../../lib/workflow-world.test-support.ts';
import IndexHarness from './index-test-harness.test-harness.svelte';
import {
  LIST_LOADING_DELAY_MILLISECONDS,
  LIST_STILL_LOADING_MILLISECONDS,
} from './schedule-list-loading.svelte';

let stub: WorkflowStub | undefined;
let restoreFetch: (() => void) | undefined;

afterEach(() => {
  jest.useRealTimers();
  cleanup();
  stub?.restore();
  stub = undefined;
  restoreFetch?.();
  restoreFetch = undefined;
  Reflect.deleteProperty(window, 'matchMedia');
});

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
});

const DAY = 24 * 3_600_000;

/** One schedule that runs the Assistant, and one that runs Tool runner and is paused. */
function twoSchedules(): World {
  const now = Date.now();
  return emptyWorld({
    definitions: [codeDefinition('agentRun')],
    schedules: [
      scheduleFixture('daily', 'agentRun', {
        description: 'Daily summary',
        cronExpression: '0 9 * * *',
        nextFireAt: now + DAY,
      }),
      scheduleFixture('audit', 'agentRun', {
        description: 'Weekly audit',
        status: 'paused',
        cronExpression: '0 11 * * 1',
        nextFireAt: now + 2 * DAY,
      }),
    ],
    scheduleAgents: { daily: 'assistant', audit: 'tool-runner' },
    agents: [
      { name: 'assistant', displayName: 'Assistant', media: null },
      { name: 'tool-runner', displayName: 'Tool runner', media: null },
    ],
    agentModels: { assistant: null, 'tool-runner': null },
  });
}

function open(
  path: string,
  world: World,
  options: { scopes?: readonly string[]; connection?: ConnectionMonitor } = {},
) {
  stub = installWorkflowWorld(world);
  router.navigate(path, { replace: true });
  let queryClient: QueryClient | undefined;
  const rendered = render(IndexHarness, {
    props: {
      client: stub.client,
      externalBureau: true,
      onQueryClient: (created: QueryClient) => {
        queryClient = created;
      },
      ...(options.scopes === undefined ? {} : { scopes: options.scopes as never }),
      ...(options.connection === undefined ? {} : { connection: options.connection }),
    },
  });
  return {
    ...rendered,
    queryClient: () => {
      if (queryClient === undefined) throw new Error('the harness has no query client yet');
      return queryClient;
    },
  };
}

const rows = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('li[data-schedule]'),
];
const headerCreate = (container: HTMLElement): HTMLElement => {
  const button = container.querySelector<HTMLElement>('.cinder-page-header__create');
  if (button === null) throw new Error('the page header has no create action');
  return button;
};
const primaryButtons = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('button[data-cinder-variant="primary"]'),
];
const toolbar = (container: HTMLElement): Element | null =>
  container.querySelector('[aria-label="Filter schedules"]');

describe('nothing scheduled yet (row 70p)', () => {
  test('is the whole page: the header, one primary New schedule, and no filter row', async () => {
    const { container, findByRole } = open('/schedules', emptyWorld());
    const view = within(container);

    expect(await findByRole('heading', { level: 2, name: 'No schedules yet' })).not.toBeNull();
    expect(view.getByRole('heading', { level: 1, name: 'Schedules' })).not.toBeNull();
    expect(container.textContent).toContain(SCHEDULE_COPY.empty.description);
    expect(toolbar(container)).toBeNull();
    expect(rows(container)).toHaveLength(0);

    // The header's "+" stays secondary, and the state's button is the only primary.
    expect(headerCreate(container).getAttribute('data-cinder-variant')).toBe('secondary');
    const primaries = primaryButtons(container);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.textContent?.trim()).toBe('New schedule');
    expect(primaries[0]?.querySelector('svg')).not.toBeNull();
    // A first use: the accent disc with the calendar glyph.
    const state = container.querySelector('.cinder-empty-state');
    expect(state?.getAttribute('data-cinder-kind')).toBe('first-use');
    expect(state?.hasAttribute('data-cinder-bordered')).toBe(true);
    expect(state?.querySelector('.cinder-empty-state-icon svg')).not.toBeNull();

    await fireEvent.click(primaries[0] as HTMLElement);
    expect(router.pathname).toBe('/schedules/new');
  });

  test('is the same for a list of only cancelled schedules, which are not listed', async () => {
    const world = emptyWorld({
      definitions: [codeDefinition('agentRun')],
      schedules: [scheduleFixture('gone', 'agentRun', { status: 'cancelled' })],
    });
    const { findByRole, container } = open('/schedules', world);
    expect(await findByRole('heading', { level: 2, name: 'No schedules yet' })).not.toBeNull();
    expect(toolbar(container)).toBeNull();
  });

  test('says why New schedule is off for a caller who may not write schedules, and does nothing', async () => {
    const { container, findByRole } = open('/schedules', emptyWorld(), {
      scopes: ['schedules:read'],
    });
    await findByRole('heading', { level: 2, name: 'No schedules yet' });
    const primary = primaryButtons(container)[0] as HTMLElement;
    expect(primary.getAttribute('aria-disabled')).toBe('true');
    expect(primary.getAttribute('title')).toContain('schedules:write');
    await fireEvent.click(primary);
    expect(router.pathname).toBe('/schedules');
  });
});

describe('filtered to nothing (rows 70q and 70r)', () => {
  test('keeps the filter bar with its counts and chips over a Clear filters state', async () => {
    const { container, findByRole } = open(
      '/schedules?status=paused&agent=assistant',
      twoSchedules(),
    );
    const view = within(container);

    expect(
      await findByRole('heading', { level: 2, name: 'No schedules match these filters' }),
    ).not.toBeNull();
    expect(container.textContent).toContain(
      'Assistant has no paused schedules. Try another status or agent.',
    );
    // The bar stays: the counts of what the agent leaves, the segment chosen, the chips.
    expect(view.getByRole('radio', { name: /^All\s*,\s*1$/ })).not.toBeNull();
    expect(view.getByRole('radio', { name: /^Active\s*,\s*1$/ })).not.toBeNull();
    const paused = view.getByRole('radio', { name: /^Paused\s*,\s*0$/ });
    expect(paused.getAttribute('aria-checked')).toBe('true');
    expect(view.getByRole('button', { name: /Missed runs\s*0/ })).not.toBeNull();
    expect(container.textContent).toContain('Agent: Assistant');
    expect(view.getByRole('button', { name: /Workflow/ })).not.toBeNull();
    expect(headerCreate(container)).not.toBeNull();

    // A neutral disc with a search glyph, and the secondary Clear filters as the only action.
    const state = container.querySelector('.cinder-empty-state') as HTMLElement;
    expect(state.getAttribute('data-cinder-kind')).toBe('filtered');
    expect(state.querySelector('.cinder-empty-state-icon svg')).not.toBeNull();
    expect(within(state).getAllByRole('button')).toHaveLength(1);
    const clear = within(state).getByRole('button', { name: 'Clear filters' });
    expect(clear.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(primaryButtons(container)).toHaveLength(0);

    await fireEvent.click(clear);
    await waitFor(() => expect(rows(container)).toHaveLength(2));
    expect(window.location.search).toBe('');
  });

  test('names the Missed runs chip alone without an agent', async () => {
    const { findByRole, container } = open('/schedules?missed=1', twoSchedules());
    await findByRole('heading', { level: 2, name: 'No schedules match these filters' });
    expect(container.textContent).toContain('No schedules have missed runs. Try another filter.');
  });
});

describe('a read in progress (row 70s)', () => {
  /** Every request hangs, so the list is read for as long as the test runs. */
  function openHanging() {
    restoreFetch = installFetchImplementation(() => new Promise<Response>(() => {}));
    router.navigate('/schedules', { replace: true });
    const rendered = render(IndexHarness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        externalBureau: true,
      },
    });
    flushSync();
    return rendered;
  }

  function advance(milliseconds: number): void {
    jest.advanceTimersByTime(milliseconds);
    flushSync();
  }

  test('draws the header at once and nothing for the read until 300 ms, then the filter bar and four rows', async () => {
    jest.useFakeTimers();
    const { container } = openHanging();
    const view = within(container);

    expect(view.getByRole('heading', { level: 1, name: 'Schedules' })).not.toBeNull();
    expect(headerCreate(container).getAttribute('aria-disabled')).toBeNull();
    expect(container.querySelector('.cinder-skeleton-row')).toBeNull();
    expect(toolbar(container)).toBeNull();

    advance(LIST_LOADING_DELAY_MILLISECONDS - 1);
    expect(container.querySelector('.cinder-skeleton-row')).toBeNull();
    expect(toolbar(container)).toBeNull();

    advance(1);
    expect(container.querySelectorAll('.cinder-skeleton-row')).toHaveLength(4);
    expect(
      container.querySelectorAll('.cinder-skeleton-status-bar[data-cinder-marker="dot"]'),
    ).toHaveLength(4);
    expect(
      container.querySelectorAll('.cinder-skeleton-row .cinder-skeleton-time-bar'),
    ).toHaveLength(4);
    // The segments read All, Active and Paused with a placeholder for the count, the Missed runs chip
    // has none, and the Agent and Workflow chips stay.
    for (const label of ['All', 'Active', 'Paused']) {
      expect(
        view.getByRole('radio', { name: new RegExp(`^${label}\\s*,\\s*loading$`) }),
      ).not.toBeNull();
    }
    expect(view.getByRole('button', { name: 'Missed runs' })).not.toBeNull();
    expect(view.queryByRole('button', { name: /Missed runs\s*\d/ })).toBeNull();
    expect(view.getByRole('button', { name: /Agent/ })).not.toBeNull();
    expect(view.getByRole('button', { name: /Workflow/ })).not.toBeNull();
    expect(rows(container)).toHaveLength(0);
  });

  test('says it is taking longer than usual at 10 s, and not before', async () => {
    jest.useFakeTimers();
    const { container } = openHanging();
    advance(LIST_STILL_LOADING_MILLISECONDS - 1);
    expect(container.textContent).not.toContain(SCHEDULE_COPY.stillLoading);
    advance(1);
    expect(container.textContent).toContain(SCHEDULE_COPY.stillLoading);
  });

  test('keeps the filters the address already applies as chips', async () => {
    jest.useFakeTimers();
    restoreFetch = installFetchImplementation(() => new Promise<Response>(() => {}));
    router.navigate('/schedules?agent=tool-runner&status=paused', { replace: true });
    const { container } = render(IndexHarness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        externalBureau: true,
      },
    });
    flushSync();
    advance(LIST_LOADING_DELAY_MILLISECONDS);
    expect(container.textContent).toContain('Agent: Tool runner');
    expect(
      within(container)
        .getByRole('radio', { name: /^Paused\s*,\s*loading$/ })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });

  test('keeps the filters live: a segment, the Missed runs chip and a chip’s remove button change the address', async () => {
    jest.useFakeTimers();
    restoreFetch = installFetchImplementation(() => new Promise<Response>(() => {}));
    router.navigate('/schedules?agent=tool-runner', { replace: true });
    const { container } = render(IndexHarness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        externalBureau: true,
      },
    });
    flushSync();
    advance(LIST_LOADING_DELAY_MILLISECONDS);
    const view = within(container);

    await fireEvent.click(view.getByRole('radio', { name: /^Paused\s*,\s*loading$/ }));
    flushSync();
    expect(window.location.search).toContain('status=paused');

    await fireEvent.click(view.getByRole('button', { name: 'Missed runs' }));
    flushSync();
    expect(window.location.search).toContain('missed=1');

    await fireEvent.click(view.getByRole('button', { name: /Remove.*Agent/i }));
    flushSync();
    expect(window.location.search).not.toContain('agent=');
  });
});

describe('a first load that failed (row 70w)', () => {
  test('is the full error state under the header: no banner, the header "+" inert, one primary Try again', async () => {
    const world = twoSchedules();
    world.failSchedules = true;
    const { container, findByRole } = open('/schedules', world);
    const view = within(container);

    expect(
      await findByRole('heading', { level: 2, name: 'Couldn’t load schedules' }),
    ).not.toBeNull();
    expect(view.getByRole('heading', { level: 1, name: 'Schedules' })).not.toBeNull();
    expect(container.textContent).toContain(SCHEDULE_COPY.loadFailed.description);
    expect(rows(container)).toHaveLength(0);
    expect(toolbar(container)).toBeNull();
    expect(view.queryByRole('region', { name: /problem/ })).toBeNull();

    const primaries = primaryButtons(container);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.textContent?.trim()).toBe('Try again');
    const create = headerCreate(container);
    expect(create.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(create.getAttribute('aria-disabled')).toBe('true');
    const reason = container.querySelector(`#${create.getAttribute('aria-describedby') ?? 'none'}`);
    expect(reason?.textContent).toBe(SCHEDULE_COPY.newActionOffReason);
    await fireEvent.click(create);
    expect(router.pathname).toBe('/schedules');
  });

  test('reads the list again on Try again, and the header "+" comes back with the rows', async () => {
    const world = twoSchedules();
    world.failSchedules = true;
    const { container, findByRole } = open('/schedules', world);
    await findByRole('heading', { level: 2, name: 'Couldn’t load schedules' });

    world.failSchedules = false;
    await fireEvent.click(primaryButtons(container)[0] as HTMLElement);
    await waitFor(() => expect(rows(container)).toHaveLength(2));
    expect(headerCreate(container).getAttribute('aria-disabled')).toBeNull();
    expect(container.querySelector('.cinder-error-state')).toBeNull();
  });
});

describe('a refresh that failed over rows on screen (row 70u)', () => {
  test('keeps the rows and says so in a banner under the header, with Retry now and no dismiss', async () => {
    const world = twoSchedules();
    const { container, queryClient } = open('/schedules', world);
    await waitFor(() => expect(rows(container)).toHaveLength(2));

    world.failSchedules = true;
    await queryClient().invalidateQueries({ queryKey: queryKeys.schedules.list({}) });
    const banner = await within(container).findByRole('region', { name: 'Connection problem' });

    // The shared unreachable preset, with its countdown and the attempt it is on (row 70u).
    expect(banner.textContent).toContain('Can’t reach the Interborough server.');
    expect(banner.textContent).toMatch(/Showing what loaded as of .+\./);
    expect(banner.textContent).toMatch(/Retrying in \d+ s \(attempt 1 of 8\)\./);
    expect(banner.querySelector('[aria-label*="ismiss"]')).toBeNull();
    expect(rows(container)).toHaveLength(2);
    // The stale region holds the header "+", and nothing else.
    expect(headerCreate(container).getAttribute('aria-disabled')).toBe('true');
    // The banner follows the header and comes before the filter bar.
    const header = container.querySelector('.cinder-page-header') as Element;
    const bar = toolbar(container) as Element;
    expect(header.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(banner.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    world.failSchedules = false;
    await fireEvent.click(within(banner).getByRole('button', { name: 'Retry now' }));
    await waitFor(() =>
      expect(within(container).queryByRole('region', { name: 'Connection problem' }) === null).toBe(
        true,
      ),
    );
    expect(rows(container)).toHaveLength(2);
    expect(headerCreate(container).getAttribute('aria-disabled')).toBeNull();
  });
});

describe('a server that stopped answering (row 70u)', () => {
  function unreachableMonitor(): ConnectionMonitor {
    const monitor = new ConnectionMonitor({
      probe: () => new Promise(() => {}),
      probeDelayMs: () => 3_600_000,
      browserOffline: false,
    });
    monitor.reportUnreachable();
    return monitor;
  }

  test('holds the header "+" through the stale region and leaves rows and filters live', async () => {
    const monitor = unreachableMonitor();
    const { container } = open('/schedules', twoSchedules(), { connection: monitor });
    try {
      await waitFor(() => expect(rows(container)).toHaveLength(2));
      const create = headerCreate(container);
      expect(create.getAttribute('aria-disabled')).toBe('true');
      expect(container.textContent).toContain('Off until it’s back');
      // The page says it once, under its header, with the connection's own countdown; the shell
      // leaves its banner to the page.
      const banner = within(container).getByRole('region', { name: 'Connection problem' });
      expect(banner.textContent).toMatch(/Retrying in \d+ s \(attempt 1 of 8\)\./);
      expect(monitor.bannerDrawnByPage).toBe(true);
      expect(within(container).queryByRole('region', { name: 'Refresh problem' })).toBeNull();
      // Filters and row links stay live.
      await fireEvent.click(within(container).getByRole('radio', { name: /^Paused/ }));
      await waitFor(() => expect(rows(container)).toHaveLength(1));
      expect(rows(container)[0]?.querySelector('a, [href]')).not.toBeNull();
    } finally {
      monitor.dispose();
    }
  });

  test('keeps what each schedule is and draws no second error when the Bureau fails because the server is gone', async () => {
    // The Bureau's two lists answer once, then the server goes: the overlay read again fails, and
    // the page's banner is the one place that says so (row 70u).
    const monitor = new ConnectionMonitor({
      probe: () => new Promise(() => {}),
      probeDelayMs: () => 3_600_000,
    });
    const world = twoSchedules();
    const { container, queryClient } = open('/schedules', world, { connection: monitor });
    try {
      await waitFor(() => expect(rows(container)).toHaveLength(2));
      await waitFor(() => expect(container.textContent).toContain('Assistant'));
      world.failBureauSchedules = true;
      world.failBureauFiles = true;
      monitor.reportUnreachable();
      await queryClient().invalidateQueries({ queryKey: queryKeys.schedules.overlay() });
      await waitFor(() => expect(queryClient().isFetching()).toBe(0));

      expect(container.textContent).not.toContain(SCHEDULE_COPY.overlayFailed.title);
      // The agents and the segments are the ones the Bureau last said, not "failed".
      expect(container.textContent).toContain('Assistant');
      expect(within(container).getByRole('radio', { name: /^Paused\s*,\s*1$/ })).not.toBeNull();
    } finally {
      monitor.dispose();
    }
  });

  test('holds the empty state’s New schedule too', async () => {
    const monitor = unreachableMonitor();
    const { container, findByRole } = open('/schedules', emptyWorld(), { connection: monitor });
    try {
      await findByRole('heading', { level: 2, name: 'No schedules yet' });
      expect(primaryButtons(container)[0]?.getAttribute('aria-disabled')).toBe('true');
    } finally {
      monitor.dispose();
    }
  });
});
