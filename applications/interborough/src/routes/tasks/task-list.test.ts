/**
 * `/tasks`: the caller's tasks from `bureau.tasks.list`, a page at a time, narrowed by agent, by
 * status, and by session (`contextId`), with each task linking to its page and its session.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { taskFixture } from '../../lib/bureau-fixtures.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorld,
  type BureauWorldStub,
} from '../../lib/bureau-world.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import Harness from './tasks-area.test-harness.svelte';

let stub: BureauWorldStub | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
});

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

function open(path: string, world: Partial<BureauWorld> = {}) {
  stub = installBureauWorld(emptyBureauWorld(world));
  router.navigate(path, { replace: true });
  return render(Harness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

const THREE = [
  taskFixture({ id: 'run-a', contextId: 'session-a', agentName: 'assistant', status: 'completed' }),
  taskFixture({
    id: 'run-b',
    contextId: 'session-b',
    agentName: 'tool-runner',
    status: 'input-required',
  }),
  taskFixture({ id: 'run-c', contextId: 'session-a', agentName: 'assistant', status: 'failed' }),
];

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('tbody tr')];
}

describe('the task list', () => {
  test('lists each task with its status and agent, linking to the task and to its session', async () => {
    const { container } = open('/tasks', { tasks: THREE });
    await waitFor(() => expect(rows(container).length).toBe(3));

    expect(container.querySelector('h1')?.textContent).toBe('Tasks');
    const first = rows(container)[0];
    expect(first?.textContent).toContain('Completed');
    expect(first?.textContent).toContain('assistant');
    expect(first?.querySelector('a[href="/tasks/run-a"]')).not.toBeNull();
    expect(first?.querySelector('a[href="/chat/session-a"]')).not.toBeNull();
    expect(rows(container)[1]?.textContent).toContain('Waiting for input');
    expect(container.querySelector('[data-view="tasks"]')?.getAttribute('data-state')).toBe(
      'ready',
    );
  });

  test('asks for a page of fifty, newest first as the Bureau orders them', async () => {
    const { container } = open('/tasks', { tasks: THREE });
    await waitFor(() => expect(rows(container).length).toBe(3));
    expect(stub?.callsTo('bureau.tasks.list').at(-1)?.params).toEqual({ limit: 50, offset: 0 });
  });

  test('reads the filters from the address, and sends each to the Bureau', async () => {
    const { container } = open('/tasks?agent=assistant&status=failed&session=session-a', {
      tasks: THREE,
    });
    await waitFor(() => expect(rows(container).length).toBe(1));
    expect(stub?.callsTo('bureau.tasks.list').at(-1)?.params).toEqual({
      agentName: 'assistant',
      status: 'failed',
      contextId: 'session-a',
      limit: 50,
      offset: 0,
    });
    expect(container.querySelector<HTMLInputElement>('input[name="agent"]')?.value).toBe(
      'assistant',
    );
    expect(container.querySelector<HTMLInputElement>('input[name="session"]')?.value).toBe(
      'session-a',
    );
  });

  test('narrows the list when the filter form is submitted, and keeps the filter in the address', async () => {
    const { container, getByRole } = open('/tasks', { tasks: THREE });
    await waitFor(() => expect(rows(container).length).toBe(3));

    const agent = container.querySelector<HTMLInputElement>('input[name="agent"]');
    if (agent === null) throw new Error('The agent filter is missing.');
    await fireEvent.input(agent, { target: { value: 'tool-runner' } });
    await fireEvent.click(getByRole('button', { name: 'Filter' }));

    await waitFor(() => expect(rows(container).length).toBe(1));
    expect(router.current.search.get('agent')).toBe('tool-runner');
    expect(stub?.callsTo('bureau.tasks.list').at(-1)?.params).toMatchObject({
      agentName: 'tool-runner',
    });
  });

  test('says no task matches a filter, apart from the view’s own empty state', async () => {
    const { container, findByText } = open('/tasks?status=submitted', { tasks: THREE });
    await findByText('No task matches these filters');
    expect(rows(container).length).toBe(0);
    expect(container.querySelector('[data-view="tasks"]')?.getAttribute('data-state')).toBe(
      'ready',
    );
  });

  test('pages with load more, and takes the next page from where the Bureau says it ends', async () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      taskFixture({ id: `run-${String(index).padStart(2, '0')}` }),
    );
    const { container, getByRole, queryByRole } = open('/tasks', { tasks: many });
    await waitFor(() => expect(rows(container).length).toBe(50));

    await fireEvent.click(getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rows(container).length).toBe(60));
    expect(stub?.callsTo('bureau.tasks.list').map((call) => call.params['offset'])).toEqual([
      undefined, // the view frame's probe asks for one task and nothing about a page
      0,
      50,
    ]);
    expect(queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  test('says how many waits a task has open', async () => {
    const waiting = taskFixture({
      id: 'run-w',
      status: 'input-required',
      openWaits: [{ kind: 'human-wait', reviewId: 'review-1', signalName: 'environment' }],
    });
    const { container } = open('/tasks', { tasks: [waiting] });
    await waitFor(() => expect(rows(container).length).toBe(1));
    expect(rows(container)[0]?.textContent).toContain('1 open wait');
  });
});
