/**
 * The runs that need a look on `/runs` (COR-2528): a badge on a row for each state the run is in,
 * and the Needs attention chip, which the address keeps (`?attention=1`) and which asks the Bureau
 * for the runs that carry a state, one kind at a time, so it lists a settled run that overspent.
 * Through the route outlet, over a Bureau that answers from a table and filters as it does.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { flushSync } from 'svelte';

import { RUN_ATTENTION_COPY } from '../../../app/copy/run-attention.ts';
import { TASK_COPY } from '../../../app/copy/tasks.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import { contextFixture, taskFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import type { TaskView } from '../../../lib/bureau-tasks.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorldStub,
} from '../../../lib/bureau-world.test-support.ts';
import { router } from '../../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { landAt } from '../../chat/pages.test-support.ts';

let stub: BureauWorldStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

const TASKS: readonly TaskView[] = [
  taskFixture({ id: 'run-quiet', contextId: 'chat-1', agentName: 'echo', status: 'completed' }),
  taskFixture({
    id: 'run-stalled',
    contextId: 'chat-1',
    agentName: 'echo',
    status: 'working',
    attention: ['stalled'],
    stalledSince: '2026-11-02T16:30:00.000Z',
  }),
  taskFixture({
    id: 'run-both',
    contextId: 'chat-1',
    agentName: 'echo',
    status: 'working',
    attention: ['stalled', 'looping'],
  }),
  // Settled long ago: the Needs attention feed dropped it, and the filter still lists it.
  taskFixture({
    id: 'run-settled-overspent',
    contextId: 'chat-1',
    agentName: 'echo',
    status: 'completed',
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T08:30:00.000Z',
    attention: ['overspending'],
  }),
];

function open(path: string) {
  stub = installBureauWorld(emptyBureauWorld({ tasks: [...TASKS] }));
  stub.on('bureau.goals.list', () => ({ goals: [], nextOffset: null }));
  stub.on('bureau.contexts.list', () => ({
    contexts: [contextFixture('chat-1', { title: 'Plan the week' })],
    nextOffset: null,
  }));
  stub.on('bureau.agents.list', () => ({ agents: [] }));
  stub.on('bureau.schedules.list', () => ({ schedules: [], nextOffset: null }));
  stub.on('bureau.schedules.missed', () => ({ missed: [] }));
  landAt(path);
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

const rowIds = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-run]')].map((row) => row.getAttribute('data-run') ?? '');

/** Opens the bar's Filter menu on its Needs attention row, and returns the row. */
async function openAttentionRow(view: ReturnType<typeof open>): Promise<HTMLElement> {
  if (document.querySelector('.cinder-filter-bar__menu') === null) {
    await fireEvent.click(view.getByRole('button', { name: 'Filter' }));
    flushSync();
  }
  const row = [
    ...document.querySelectorAll<HTMLButtonElement>('.cinder-filter-bar__menu-row'),
  ].find((candidate) => candidate.textContent?.includes(RUN_ATTENTION_COPY.filter));
  if (row === undefined) throw new Error('The Filter menu has no Needs attention row.');
  if (row.getAttribute('aria-expanded') !== 'true') await fireEvent.click(row);
  flushSync();
  return row;
}

/** The open Filter menu's checkbox: the menu is a popover outside the page's tree. */
function menuCheckbox(): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(
    '.cinder-filter-bar__menu input[type="checkbox"]',
  );
  if (found === null) throw new Error('The Filter menu holds no checkbox.');
  return found;
}

/** The badges a row draws, in the order it draws them. */
function badgesOf(container: HTMLElement, runId: string): string[] {
  return [...container.querySelectorAll(`[data-run="${runId}"] [data-attention]`)].map((badge) =>
    badge.textContent.trim(),
  );
}

describe('a row’s badges', () => {
  test('are one for each state the run is in, and none for a run with none', async () => {
    const view = open('/runs');
    await waitFor(() => expect(rowIds(view.container)).toHaveLength(4));

    expect(badgesOf(view.container, 'run-quiet')).toEqual([]);
    expect(badgesOf(view.container, 'run-stalled')).toEqual([RUN_ATTENTION_COPY.badges.stalled]);
    expect(badgesOf(view.container, 'run-both')).toEqual([
      RUN_ATTENTION_COPY.badges.stalled,
      RUN_ATTENTION_COPY.badges.looping,
    ]);
    expect(badgesOf(view.container, 'run-settled-overspent')).toEqual([
      RUN_ATTENTION_COPY.badges.overspending,
    ]);
  });

  test('read the Bureau once, with no attention filter, while the chip is off', async () => {
    const view = open('/runs');
    await waitFor(() => expect(rowIds(view.container)).toHaveLength(4));
    const asked = stub?.callsTo('bureau.tasks.list').map((call) => call.params['attention']);
    expect(asked).toEqual([undefined]);
  });
});

describe('the Needs attention chip', () => {
  test('counts the runs that carry a state and, chosen, keeps itself in the address', async () => {
    const view = open('/runs');
    await waitFor(() => expect(rowIds(view.container)).toHaveLength(4));

    // The filter is in the Filter menu, never in the row, and its row counts the runs.
    expect(view.queryByRole('button', { name: new RegExp(RUN_ATTENTION_COPY.filter) })).toBeNull();
    await openAttentionRow(view);
    expect(document.querySelector('.cinder-filter-bar__menu')?.textContent).toContain(
      `${RUN_ATTENTION_COPY.filter} 3`,
    );
    await fireEvent.click(menuCheckbox());

    await waitFor(() => expect(router.search.get('attention')).toBe('1'));
    await waitFor(() =>
      expect(rowIds(view.container).toSorted()).toEqual([
        'run-both',
        'run-settled-overspent',
        'run-stalled',
      ]),
    );
  });

  test('asks the Bureau for each kind and lists a settled run that overspent', async () => {
    const view = open('/runs?attention=1');
    await waitFor(() => expect(rowIds(view.container)).toHaveLength(3));

    const asked = stub
      ?.callsTo('bureau.tasks.list')
      .map((call) => call.params['attention'])
      .toSorted();
    expect(asked).toEqual(['looping', 'overspending', 'stalled']);
    // It reads no listing of every run (a page of 100 with no filter): the Bureau is the one that
    // says which carry a state. The failed runs are read for the step names the narrowed list
    // cannot suggest (COR-2535), which is a listing by status.
    expect(
      stub
        ?.callsTo('bureau.tasks.list')
        .some(
          (call) =>
            call.params['limit'] === 100 &&
            call.params['attention'] === undefined &&
            call.params['status'] === undefined,
        ),
    ).toBe(false);

    expect(rowIds(view.container)).toContain('run-settled-overspent');
    expect(rowIds(view.container)).not.toContain('run-quiet');
    expect(badgesOf(view.container, 'run-settled-overspent')).toEqual([
      RUN_ATTENTION_COPY.badges.overspending,
    ]);
    // A run that is in two states is one row, listed once.
    expect(rowIds(view.container).filter((id) => id === 'run-both')).toHaveLength(1);
  });

  test('is kept when another filter changes, and goes when it is removed', async () => {
    const view = open('/runs?attention=1');
    await waitFor(() => expect(rowIds(view.container)).toHaveLength(3));

    await fireEvent.click(view.getByRole('radio', { name: /^Running\s*,\s*2$/ }));
    await waitFor(() => expect(router.search.get('status')).toBe('running'));
    expect(router.search.get('attention')).toBe('1');
    await waitFor(() =>
      expect(rowIds(view.container).toSorted()).toEqual(['run-both', 'run-stalled']),
    );

    // While the filter is on the row shows it as a removable chip, and removing it takes it out.
    await fireEvent.click(
      view.getByRole('button', { name: `Remove filter: ${RUN_ATTENTION_COPY.filter}: On` }),
    );
    await waitFor(() => expect(router.search.get('attention')).toBeNull());
    // The status stays chosen: the runs that are running, with or without a state.
    expect(router.search.get('status')).toBe('running');
    await waitFor(() =>
      expect(rowIds(view.container).toSorted()).toEqual(['run-both', 'run-stalled']),
    );
    await fireEvent.click(view.getByRole('radio', { name: /^All\s*,\s*4$/ }));
    await waitFor(() => expect(rowIds(view.container)).toHaveLength(4));
  });

  test('with no run that needs attention is the filtered empty state, not the first-use state', async () => {
    stub = installBureauWorld(emptyBureauWorld({ tasks: [taskFixture({ id: 'run-quiet' })] }));
    stub.on('bureau.goals.list', () => ({ goals: [], nextOffset: null }));
    stub.on('bureau.contexts.list', () => ({ contexts: [], nextOffset: null }));
    stub.on('bureau.agents.list', () => ({ agents: [] }));
    stub.on('bureau.schedules.list', () => ({ schedules: [], nextOffset: null }));
    landAt('/runs?attention=1');
    const view = render(RouteOutletHarness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
      },
    } as never);

    await view.findByRole('heading', { level: 2, name: TASK_COPY.noMatch.title });
    expect(view.container.textContent).toContain('No runs that need attention.');
    expect(view.queryByText(TASK_COPY.empty.title)).toBeNull();
  });
});
