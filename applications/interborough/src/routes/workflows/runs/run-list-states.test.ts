/**
 * `/runs` in the states that are not a list of rows (COR-2017, rows 10k, 10l, 10q, 10r, 12r to 12v,
 * 14m, 14n, 14p, 14s, 15d, 52v to 52z, 53b and 06w): nothing run yet, filters that match nothing, a
 * read in progress, a read the person canceled, a read that failed with nothing to show, and a
 * server that stopped answering over a list on screen. The page keeps its header in every one of
 * them (`ownsStatesOnPatterns` in `app/views.ts`). Through the route outlet, over a Bureau that
 * answers from a table; the timings the placeholders keep run under fake timers moved by hand.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, jest, test } from 'bun:test';
import { flushSync } from 'svelte';

import { ConnectionMonitor } from '../../../app/connection.svelte.ts';
import { CONNECTION_COPY, RETRY_LABEL, TASK_COPY } from '../../../app/copy.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import { taskFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import { StubFault } from '../../../lib/bureau-stub.test-support.ts';
import type { TaskView } from '../../../lib/bureau-tasks.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorldStub,
} from '../../../lib/bureau-world.test-support.ts';
import { settle, until } from '../../../lib/fake-timers.test-support.ts';
import { router } from '../../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { landAt } from '../../chat/pages.test-support.ts';
import RunListOfflineHarness from './run-list-offline.test-harness.svelte';
import {
  RUN_LIST_LOADING_DELAY_MILLISECONDS,
  RUN_LIST_STILL_LOADING_MILLISECONDS,
} from './run-list-states.svelte';

let stub: BureauWorldStub | undefined;
let monitor: ConnectionMonitor | undefined;

afterEach(() => {
  jest.useRealTimers();
  cleanup();
  monitor?.dispose();
  monitor = undefined;
  stub?.restore();
  stub = undefined;
});

/** A run that finished and one that failed, both of the Echo agent. */
const SOME_RUNS: readonly TaskView[] = [
  taskFixture({ id: 'run-1', contextId: 'chat-1', agentName: 'echo', status: 'completed' }),
  taskFixture({ id: 'run-2', contextId: 'handle-2', agentName: 'echo', status: 'failed' }),
];

interface Options {
  readonly tasks?: readonly TaskView[];
  /** Holds the chats' read open until this settles, so the list stays loading for as long as a test needs. */
  readonly holdChats?: Promise<void>;
  /** Makes the Bureau answer the chats' read with this fault. */
  readonly chatsFail?: StubFault;
  /** The shell's connection, for a test of a server that does not answer. */
  readonly connection?: ConnectionMonitor;
}

function open(path: string, options: Options = {}) {
  stub = installBureauWorld(emptyBureauWorld({ tasks: [...(options.tasks ?? [])] }));
  stub.on('bureau.goals.list', () => ({ goals: [], nextOffset: null }));
  stub.on('bureau.contexts.list', async () => {
    await options.holdChats;
    if (options.chatsFail !== undefined) throw options.chatsFail;
    return { contexts: [], nextOffset: null };
  });
  stub.on('bureau.agents.list', () => ({ agents: [] }));
  stub.on('bureau.schedules.list', () => ({ schedules: [], nextOffset: null }));
  stub.on('bureau.schedules.missed', () => ({ missed: [] }));
  landAt(path);
  const props = {
    client: new HttpClient({ baseUrl: 'http://localhost/api' }),
    scopes: AUTHORIZATION_SCOPES,
  };
  return options.connection === undefined
    ? render(RouteOutletHarness, { props } as never)
    : render(RunListOfflineHarness, {
        props: { ...props, connection: options.connection },
      } as never);
}

/** The header's "+": a secondary icon button named for what it starts. */
const headerCreate = (container: HTMLElement): HTMLElement => {
  const button = container.querySelector<HTMLElement>('.cinder-page-header__create');
  if (button === null) throw new Error('the page header has no create action');
  return button;
};
const primaryButtons = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-cinder-variant="primary"]'),
];
const toolbar = (container: HTMLElement): Element | null =>
  container.querySelector(`[aria-label="${TASK_COPY.filtersLabel}"]`);

const SEGMENT_WORDS = ['All', 'Waiting on you', 'Running', 'Done', 'Failed', 'Canceled'] as const;

describe('nothing run yet (rows 52v and 52w)', () => {
  test('is the whole page: the header, no filter bar, a primary Start run beside a secondary Chat with an agent', async () => {
    const view = open('/runs');
    const state = await view.findByRole('heading', { level: 2, name: 'No runs yet' });

    expect(view.getAllByRole('heading', { level: 1, name: 'Runs' })[0]).not.toBeNull();
    expect(view.container.textContent).toContain(TASK_COPY.empty.description);
    expect(toolbar(view.container)).toBeNull();
    expect(view.container.querySelectorAll('[data-run]')).toHaveLength(0);

    // The header's "+" stays secondary, and Start run, the state's primary, is the only one.
    expect(headerCreate(view.container).getAttribute('data-cinder-variant')).toBe('secondary');
    const primaries = primaryButtons(view.container);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.textContent?.trim()).toBe(TASK_COPY.startRun);
    expect(primaries[0]?.querySelector('svg')).not.toBeNull();
    const chat = view.getByRole('link', { name: TASK_COPY.empty.chatAction });
    expect(chat.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(chat.getAttribute('href')).toBe(TASK_COPY.empty.chatPath);
    expect(chat.querySelector('svg')).not.toBeNull();

    // An accent disc with the play glyph: the first-use kind, not a neutral one.
    const empty = state.closest('.cinder-empty-state');
    expect(empty?.getAttribute('data-cinder-kind')).toBe('first-use');
    expect(empty?.querySelector('.cinder-empty-state-icon svg')).not.toBeNull();
  });

  test('Start run opens the picker', async () => {
    const view = open('/runs');
    await view.findByRole('heading', { level: 2, name: 'No runs yet' });
    await fireEvent.click(primaryButtons(view.container)[0] as HTMLElement);
    expect(router.pathname).toBe('/runs/new');
  });
});

describe('filtered to nothing (rows 10q, 10r, 12r, 12s, 12t, 52x and 52y)', () => {
  test('keeps the filter bar with every segment at 0 and the chip, over a Clear filters state that names the agent', async () => {
    const view = open('/runs?agent=model-switcher', { tasks: SOME_RUNS });
    const title = await view.findByRole('heading', { level: 2, name: TASK_COPY.noMatch.title });

    expect(view.container.textContent).toContain('Model switcher has no runs. Try another agent.');
    for (const word of SEGMENT_WORDS) {
      expect(view.getByRole('radio', { name: new RegExp(`^${word}\\s*,\\s*0$`) })).not.toBeNull();
    }
    // The plain "Waiting" segment is not there: the segment reads Waiting on you.
    expect(view.queryByRole('radio', { name: /^Waiting\s*,/ })).toBeNull();
    expect(
      view.getByRole('button', { name: `Remove filter: ${TASK_COPY.agentLabel}: Model switcher` }),
    ).not.toBeNull();
    expect(headerCreate(view.container).getAttribute('data-cinder-variant')).toBe('secondary');

    // A neutral disc with a funnel, and the secondary Clear filters as the only action.
    const state = title.closest('.cinder-empty-state') as HTMLElement;
    expect(state.getAttribute('data-cinder-kind')).toBe('filtered');
    expect(within(state).getAllByRole('button')).toHaveLength(1);
    const clear = within(state).getByRole('button', { name: TASK_COPY.clearAction });
    expect(clear.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(primaryButtons(view.container)).toHaveLength(0);

    await fireEvent.click(clear);
    await waitFor(() => expect(router.search.get('agent')).toBeNull());
  });

  test('names the origin as well when an agent and a Started by chip are both on (52y)', async () => {
    const view = open('/runs?agent=model-switcher&startedBy=goal', { tasks: SOME_RUNS });
    await view.findByRole('heading', { level: 2, name: TASK_COPY.noMatch.title });
    expect(view.container.textContent).toContain(
      'Model switcher has no runs started by a goal. Try another agent or origin.',
    );
  });
});

describe('a read in progress (rows 10k, 10l, 14m, 14n, 14p and 52z)', () => {
  /** Opens the list with the chats' read held, so it is loading until `release` is called. */
  function openLoading() {
    jest.useFakeTimers();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = open('/runs', { tasks: SOME_RUNS, holdChats: held });
    return { view, release };
  }

  function advance(milliseconds: number): void {
    jest.advanceTimersByTime(milliseconds);
    flushSync();
  }

  test('draws the header at once and nothing for the read until 300 ms, then the bar without counts and five rows', async () => {
    const { view, release } = openLoading();
    await until(() => expect(view.getAllByRole('heading', { level: 1, name: 'Runs' })[0]).not.toBeNull());

    // The header, its description and the live "+" are real while the runs load (14m).
    expect(view.container.textContent).toContain(TASK_COPY.list.description);
    expect(headerCreate(view.container).getAttribute('aria-disabled')).toBeNull();
    expect(view.container.querySelector('.cinder-skeleton-row')).toBeNull();
    expect(toolbar(view.container)).toBeNull();

    advance(RUN_LIST_LOADING_DELAY_MILLISECONDS - 1);
    expect(view.container.querySelector('.cinder-skeleton-row')).toBeNull();
    expect(toolbar(view.container)).toBeNull();

    advance(1);
    await settle();
    // A day band, and rows with a status bar, title and meta bars and a time bar.
    expect(view.container.querySelector('.cinder-skeleton-day-band')).not.toBeNull();
    expect(view.container.querySelectorAll('.cinder-skeleton-row')).toHaveLength(5);
    expect(
      view.container.querySelectorAll('.cinder-skeleton-row .cinder-skeleton-status-bar'),
    ).toHaveLength(5);
    expect(
      view.container.querySelectorAll('.cinder-skeleton-row .cinder-skeleton-time-bar'),
    ).toHaveLength(5);
    // All six segments, none with a count: the counts wait for the data.
    for (const word of SEGMENT_WORDS) {
      expect(
        view.getByRole('radio', { name: new RegExp(`^${word}\\s*,\\s*loading$`) }),
      ).not.toBeNull();
    }
    expect(view.container.querySelectorAll('[data-run]')).toHaveLength(0);
    expect(view.container.querySelector('.cinder-empty-state')).toBeNull();

    release();
    await until(() => expect(view.container.querySelectorAll('[data-run]')).toHaveLength(2));
    expect(view.container.querySelector('.cinder-skeleton-row')).toBeNull();
    expect(view.getByRole('radio', { name: /^All\s*,\s*2$/ })).not.toBeNull();
  });

  test('says it is taking longer than usual at 10 s, and not before', async () => {
    const { view, release } = openLoading();
    await until(() => expect(view.getAllByRole('heading', { level: 1, name: 'Runs' })[0]).not.toBeNull());

    advance(RUN_LIST_STILL_LOADING_MILLISECONDS - 1);
    expect(view.container.textContent).not.toContain(TASK_COPY.list.stillLoading);
    advance(1);
    await settle();
    expect(view.container.textContent).toContain(TASK_COPY.list.stillLoading);
    const status = view.container.querySelector('.cinder-skeleton-status') as HTMLElement;
    const cancel = within(status).getByRole('button', { name: 'Cancel' });
    expect(cancel.getAttribute('data-cinder-variant')).toBe('ghost');
    // It is the skeleton's own line, not a banner.
    expect(view.container.querySelector('[role="region"][aria-label*="problem"]')).toBeNull();
    release();
  });

  test('Cancel replaces the rows with Loading canceled and Try again, and keeps the header and the bar', async () => {
    const { view, release } = openLoading();
    await until(() => expect(view.getAllByRole('heading', { level: 1, name: 'Runs' })[0]).not.toBeNull());
    advance(RUN_LIST_STILL_LOADING_MILLISECONDS);
    await settle();

    await fireEvent.click(
      within(view.container.querySelector('.cinder-skeleton-status') as HTMLElement).getByRole(
        'button',
        { name: 'Cancel' },
      ),
    );
    await until(() =>
      expect(
        view.getByRole('heading', { level: 2, name: TASK_COPY.list.loadingCanceled.title }),
      ).not.toBeNull(),
    );
    expect(view.container.textContent).toContain(TASK_COPY.list.loadingCanceled.description);
    expect(view.container.querySelector('.cinder-skeleton-row')).toBeNull();
    // The header and all six segments stay, still without counts.
    expect(view.getAllByRole('heading', { level: 1, name: 'Runs' })[0]).not.toBeNull();
    expect(headerCreate(view.container).getAttribute('aria-disabled')).toBeNull();
    for (const word of SEGMENT_WORDS) {
      expect(
        view.getByRole('radio', { name: new RegExp(`^${word}\\s*,\\s*loading$`) }),
      ).not.toBeNull();
    }
    const retry = view.getByRole('button', { name: RETRY_LABEL });
    expect(primaryButtons(view.container)).toEqual([retry]);

    // Try again reads the runs, and the rows replace the block.
    release();
    await fireEvent.click(retry);
    await until(() => expect(view.container.querySelectorAll('[data-run]')).toHaveLength(2));
    expect(view.queryByRole('heading', { name: TASK_COPY.list.loadingCanceled.title })).toBeNull();
  });
});

describe('a list that could not be read (rows 12u, 12v, 14s and 53b)', () => {
  test('is the full error state under the header: no filter bar, one primary Try again, Check Health, and the details', async () => {
    const view = open('/runs', {
      tasks: SOME_RUNS,
      chatsFail: new StubFault('EngineFailure', 500, 'The Bureau broke.'),
    });
    await view.findByRole('heading', { level: 2, name: 'Couldn’t load runs' });

    expect(view.getAllByRole('heading', { level: 1, name: 'Runs' })[0]).not.toBeNull();
    expect(view.container.textContent).toContain(
      'The server answered with an error (500). Nothing you did caused it.',
    );
    expect(toolbar(view.container)).toBeNull();
    expect(view.container.querySelectorAll('[data-run]')).toHaveLength(0);
    // Never beside a banner.
    expect(view.queryByRole('region', { name: /problem/ })).toBeNull();

    // Try again is the only primary, the header's "+" is the muted secondary, and Check Health
    // is a secondary link to Health.
    const retry = view.getByRole('button', { name: RETRY_LABEL });
    expect(primaryButtons(view.container)).toEqual([retry]);
    expect(headerCreate(view.container).getAttribute('data-cinder-variant')).toBe('secondary');
    const health = view.getByRole('link', { name: TASK_COPY.list.loadFailed.checkHealth });
    expect(health.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(health.getAttribute('href')).toBe('/health');

    // The codes and the operation that failed sit behind the disclosure.
    const details = view.getByText('Show the error details');
    expect(details).not.toBeNull();
    expect(view.container.textContent).toContain('bureau.contexts.list');
    expect(view.container.textContent).toContain('HTTP 500');
  });
});

describe('a server that stopped answering over a list on screen (rows 06w and 15d)', () => {
  test('keeps the rows and the counts at full contrast and holds the header "+" with its reason', async () => {
    monitor = new ConnectionMonitor({
      probe: () => new Promise(() => {}),
      probeDelayMs: () => 3_600_000,
      browserOffline: false,
    });
    monitor.reportUnreachable();
    const view = open('/runs', { tasks: SOME_RUNS, connection: monitor });
    await view.findByRole('radio', { name: /^All\s*,\s*2$/ });

    const create = headerCreate(view.container);
    expect(create.getAttribute('aria-disabled')).toBe('true');
    expect(view.container.textContent).toContain(CONNECTION_COPY.changesOff);
    expect(view.container.querySelectorAll('[data-run]')).toHaveLength(2);
    expect(view.container.querySelector('[data-run]')?.getAttribute('style') ?? '').not.toContain(
      'opacity',
    );
    // Reading controls stay live: a segment narrows the list.
    await fireEvent.click(view.getByRole('radio', { name: /^Failed\s*,\s*1$/ }));
    await waitFor(() => expect(view.container.querySelectorAll('[data-run]')).toHaveLength(1));
  });
});
