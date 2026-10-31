/**
 * `/runs` as a person works it: each filter narrows the list through the address, a run opens in
 * place from its row, and so does the chat or the goal that started it. Through the route outlet,
 * over a Bureau that answers from a table.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { TASK_COPY } from '../../../app/copy.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import {
  contextFixture,
  goalAttemptFixture,
  goalFixture,
  taskFixture,
} from '../../../lib/bureau-fixtures.test-support.ts';
import { SCHEDULER_ACTOR, type TaskView } from '../../../lib/bureau-tasks.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorldStub,
} from '../../../lib/bureau-world.test-support.ts';
import { router } from '../../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { STATUS_WORDS } from '../../../lib/status.ts';
import { landAt } from '../../chat/pages.test-support.ts';

let stub: BureauWorldStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

function open(path: string, extraTasks: readonly TaskView[] = []) {
  stub = installBureauWorld(
    emptyBureauWorld({
      tasks: [
        taskFixture({ id: 'run-1', contextId: 'chat-1', agentName: 'echo', status: 'completed' }),
        taskFixture({ id: 'run-2', contextId: 'handle-2', agentName: 'echo', status: 'failed' }),
        ...extraTasks,
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

describe('narrowing the runs', () => {
  test.each([
    [TASK_COPY.statusLabel, 'failed', 'status', 'failed'],
    [TASK_COPY.agentLabel, 'echo', 'agent', 'echo'],
    [TASK_COPY.startedByLabel, 'goal', 'startedBy', 'goal'],
    [TASK_COPY.sinceLabel, '7d', 'since', '7d'],
  ])(
    'choosing from %s puts it in the address, and choosing Any takes it out',
    async (label, value, key, expected) => {
      const view = open('/runs');
      await waitFor(() => expect(rowIds(view.container).length).toBeGreaterThan(0));
      const select = await view.findByLabelText(label);
      await waitFor(() =>
        expect(
          [...select.querySelectorAll('option')].some((option) => option.value === value),
        ).toBe(true),
      );

      await fireEvent.change(select, { target: { value } });
      await waitFor(() => expect(router.search.get(key)).toBe(expected));

      await fireEvent.change(await view.findByLabelText(label), { target: { value: '' } });
      await waitFor(() => expect(router.search.get(key)).toBeNull());
    },
  );

  test('a status narrows the rows, and a list that matches none says so', async () => {
    const view = open('/runs?status=failed');
    await waitFor(() => expect(rowIds(view.container)).toEqual(['run-2']));
    cleanup();
    stub?.restore();

    const none = open('/runs?status=canceled');
    await none.findByRole('heading', { level: 2, name: TASK_COPY.noMatch.title });
  });
});

describe('the records page', () => {
  test('counts the runs, offers Start run in the toolbar, and says each status in the seven words', async () => {
    const view = open('/runs');
    await waitFor(() => expect(rowIds(view.container).length).toBe(3));
    expect(view.getByTestId('records-count').textContent).toBe(TASK_COPY.count(3));
    const start = view.getByRole('link', { name: TASK_COPY.startRun });
    expect(start.getAttribute('href')).toBe('/runs?view=start');

    const words = [...view.container.querySelectorAll('[data-run]')].map((row) =>
      row.getAttribute('data-status'),
    );
    expect(words.length).toBeGreaterThan(0);
    for (const word of words) expect(STATUS_WORDS as readonly (string | null)[]).toContain(word);
    expect(view.container.querySelectorAll('[data-run] [data-cinder-status]').length).toBe(3);
  });

  test('a filter that matches nothing is the filtered empty state, and Clear filters takes the filter out', async () => {
    const view = open('/runs?status=canceled');
    await view.findByRole('heading', { level: 2, name: TASK_COPY.noMatch.title });
    expect(view.container.querySelector('[data-cinder-kind="filtered"]')).not.toBeNull();

    const clear = view.container.querySelector<HTMLButtonElement>(
      '[data-cinder-kind="filtered"] button',
    );
    if (clear === null) throw new Error('The empty state did not offer Clear filters.');
    expect(clear.textContent).toContain(TASK_COPY.clearAction);
    await fireEvent.click(clear);
    await waitFor(() => expect(router.search.get('status')).toBeNull());
    await waitFor(() => expect(rowIds(view.container).length).toBe(3));
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

  test('the chat that started a run, and the goal that started one, open in place', async () => {
    const view = open('/runs');
    const chat = await view.findByRole('link', { name: 'Plan the week' });
    await fireEvent.click(chat, { button: 0 });
    expect(router.pathname).toContain('chat-1');
    cleanup();
    stub?.restore();

    const again = open('/runs');
    const goal = await again.findByRole('link', { name: `goal-1 (${TASK_COPY.goal})` });
    await fireEvent.click(goal, { button: 0 });
    expect(router.pathname).toBe('/goals/goal-1');
  });

  test('a schedule’s fire opens its session in place, whether or not the caller lists that session', async () => {
    const view = open('/runs', [
      taskFixture({
        id: 'run-fire',
        contextId: 'chat-1',
        agentName: 'echo',
        actor: SCHEDULER_ACTOR,
      }),
      taskFixture({
        id: 'run-other',
        contextId: 'other-owner-fire',
        agentName: 'echo',
        actor: SCHEDULER_ACTOR,
      }),
    ]);

    await waitFor(() => expect(rowIds(view.container)).toContain('run-other'));
    const scheduled = (id: string) =>
      view.container.querySelector<HTMLAnchorElement>(`[data-run="${id}"] .ib-run-row__what a`);
    // A fire in a chat session keeps that session's title, and is the schedule's, not a chat's.
    expect(scheduled('run-fire')?.textContent).toBe('Plan the week');
    expect(
      view.container.querySelector(`[data-run="run-fire"] .ib-run-row__what`)?.textContent,
    ).toContain(`(${TASK_COPY.schedule})`);
    const other = scheduled('run-other');
    if (other === null) throw new Error('The fire’s link did not render.');
    expect(other.textContent).toBe(TASK_COPY.untitledChat);
    expect(await fireEvent.click(other, { button: 0 })).toBe(false);
    expect(router.pathname).toContain('other-owner-fire');
  });
});
