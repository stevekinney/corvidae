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

function open(path: string) {
  stub = installBureauWorld(
    emptyBureauWorld({
      tasks: [
        taskFixture({ id: 'run-1', contextId: 'chat-1', agentName: 'echo', status: 'completed' }),
        taskFixture({ id: 'run-2', contextId: 'handle-2', agentName: 'echo', status: 'failed' }),
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
    expect(router.pathname).toBe('/goals');
  });
});
