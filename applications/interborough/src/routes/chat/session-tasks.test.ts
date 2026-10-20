/**
 * The tasks of a chat session (`bureau.tasks.list` with the session's `contextId`), each linking
 * to its page at `/tasks/:id`.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { taskFixture } from '../../lib/bureau-fixtures.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorldStub,
} from '../../lib/bureau-world.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import QueryPage from './query-page.test-harness.svelte';
import SessionTasks from './session-tasks.svelte';

let stub: BureauWorldStub | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate('/', { replace: true });
});

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

function mount(sessionId: string, tasks = [taskFixture()], streaming = false) {
  stub = installBureauWorld(emptyBureauWorld({ tasks }));
  return render(QueryPage, {
    props: { page: SessionTasks, pageProps: { sessionId, streaming } },
  } as never);
}

describe('the tasks of a chat session', () => {
  test('are read again when a run in the session ends, because the run is a task that has just finished', async () => {
    stub = installBureauWorld(emptyBureauWorld({ tasks: [taskFixture({ id: 'run-1' })] }));
    const view = render(QueryPage, {
      props: { page: SessionTasks, pageProps: { sessionId: 'session-1', streaming: true } },
    } as never);
    await waitFor(() => expect(view.container.querySelectorAll('li').length).toBe(1));
    expect(stub.callsTo('bureau.tasks.list').length).toBe(1);

    stub.on('bureau.tasks.list', () => ({
      tasks: [taskFixture({ id: 'run-1' }), taskFixture({ id: 'run-2' })],
      nextOffset: null,
    }));
    await view.rerender({
      page: SessionTasks,
      pageProps: { sessionId: 'session-1', streaming: false },
    } as never);
    await waitFor(() => expect(view.container.querySelectorAll('li').length).toBe(2));
  });

  test('page past fifty with Load more, as the task list does', async () => {
    const many = Array.from({ length: 51 }, (_, index) =>
      taskFixture({ id: `run-${String(index).padStart(2, '0')}`, contextId: 'session-1' }),
    );
    const { container, getByRole, queryByRole } = mount('session-1', many);
    await waitFor(() => expect(container.querySelectorAll('li').length).toBe(50));
    expect(stub?.callsTo('bureau.tasks.list').at(-1)?.params).toEqual({
      contextId: 'session-1',
      limit: 50,
      offset: 0,
    });

    await fireEvent.click(getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(container.querySelectorAll('li').length).toBe(51));
    expect(stub?.callsTo('bureau.tasks.list').at(-1)?.params).toEqual({
      contextId: 'session-1',
      limit: 50,
      offset: 50,
    });
    expect(queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  test('do not repeat a task that arrived after the first page, when Load more reads the next', async () => {
    const world = emptyBureauWorld({
      tasks: Array.from({ length: 51 }, (_, index) =>
        taskFixture({ id: `run-${String(index).padStart(2, '0')}`, contextId: 'session-1' }),
      ),
    });
    stub = installBureauWorld(world);
    const { container, getByRole } = render(QueryPage, {
      props: { page: SessionTasks, pageProps: { sessionId: 'session-1', streaming: false } },
    } as never);
    await waitFor(() => expect(container.querySelectorAll('li').length).toBe(50));

    // A run starts in the session: the list is newest first, so every row moves down one place and
    // offset 50 now begins with the row the first page ended with.
    world.tasks = [taskFixture({ id: 'run-new', contextId: 'session-1' }), ...world.tasks];
    await fireEvent.click(getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(container.querySelectorAll('li').length).toBe(51));
    expect(container.textContent).not.toContain('Something went wrong');
    const ids = [...container.querySelectorAll('li code')].map((code) =>
      code.getAttribute('title'),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('are the Bureau’s tasks of that session, each linking to its page', async () => {
    const { container } = mount('session-1', [
      taskFixture({ id: 'run-1', contextId: 'session-1', status: 'completed' }),
      taskFixture({ id: 'run-2', contextId: 'session-1', status: 'input-required' }),
      taskFixture({ id: 'run-3', contextId: 'session-other' }),
    ]);
    await waitFor(() => expect(container.querySelectorAll('li').length).toBe(2));
    expect(stub?.callsTo('bureau.tasks.list').at(-1)?.params).toEqual({
      contextId: 'session-1',
      limit: 50,
      offset: 0,
    });
    const links = [...container.querySelectorAll<HTMLAnchorElement>('li a')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/tasks/run-1',
      '/tasks/run-2',
    ]);
    expect(container.textContent).toContain('Completed');
    expect(container.textContent).toContain('Waiting for input');
  });

  test('open the task in place when followed, and leave a modified click to the browser', async () => {
    const { container } = mount('session-1');
    await waitFor(() => expect(container.querySelector('li a')).not.toBeNull());
    const link = container.querySelector<HTMLAnchorElement>('li a');
    if (link === null) throw new Error('Expected the task to link');
    // A modified click is the browser's, so the page does not prevent it.
    expect(await fireEvent.click(link, { button: 0, metaKey: true })).toBe(true);
    expect(router.pathname).toBe('/');
    expect(await fireEvent.click(link, { button: 0 })).toBe(false);
    expect(router.pathname).toBe('/tasks/run-1');
  });

  test('show nothing for a session with no task, and nothing when the Bureau cannot say', async () => {
    const none = mount('session-1', []);
    await waitFor(() => expect(stub?.callsTo('bureau.tasks.list').length).toBe(1));
    expect(none.container.querySelector('section')).toBeNull();
    none.unmount();
    stub?.restore();

    stub = installBureauWorld(emptyBureauWorld());
    stub.on('bureau.tasks.list', () => {
      throw new Error('The Bureau broke.');
    });
    const failing = render(QueryPage, {
      props: { page: SessionTasks, pageProps: { sessionId: 'session-1', streaming: false } },
    } as never);
    await waitFor(() => expect(stub?.callsTo('bureau.tasks.list').length).toBe(1));
    expect(failing.container.querySelector('section')).toBeNull();
  });
});
