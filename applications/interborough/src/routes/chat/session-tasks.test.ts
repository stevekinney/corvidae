/**
 * The runs of a chat session (`bureau.tasks.list` with the session's `contextId`), said as one
 * sentence that links to the run to open (`/runs/:run`): what waits on the person, what is going,
 * what failed, and nothing when every run finished well.
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

const sentence = (container: HTMLElement) =>
  container.querySelector<HTMLAnchorElement>('.weft-chat-strip a');

describe('the runs of a chat session', () => {
  test('say how many wait on the person, and link to the first that does', async () => {
    const { container } = mount('session-1', [
      taskFixture({ id: 'run-1', contextId: 'session-1', status: 'completed' }),
      taskFixture({ id: 'run-2', contextId: 'session-1', status: 'input-required' }),
      taskFixture({ id: 'run-3', contextId: 'session-other' }),
    ]);
    await waitFor(() => expect(sentence(container)).not.toBeNull());
    expect(stub?.callsTo('bureau.tasks.list').at(-1)?.params).toEqual({
      contextId: 'session-1',
      limit: 50,
    });
    expect(sentence(container)?.textContent).toBe('1 run is waiting on you');
    expect(sentence(container)?.getAttribute('href')).toBe('/runs/run-2');
    // No run identifier is shown to the person.
    expect(container.textContent).not.toContain('run-2');
  });

  test('say that a run is working, then are read again when the run ends', async () => {
    stub = installBureauWorld(
      emptyBureauWorld({ tasks: [taskFixture({ id: 'run-1', status: 'working' })] }),
    );
    const view = render(QueryPage, {
      props: { page: SessionTasks, pageProps: { sessionId: 'session-1', streaming: true } },
    } as never);
    await waitFor(() => expect(sentence(view.container)?.textContent).toBe('1 run is working'));
    expect(stub.callsTo('bureau.tasks.list').length).toBe(1);

    stub.on('bureau.tasks.list', () => ({
      tasks: [taskFixture({ id: 'run-1', status: 'failed' })],
      nextPageToken: null,
    }));
    await view.rerender({
      page: SessionTasks,
      pageProps: { sessionId: 'session-1', streaming: false },
    } as never);
    await waitFor(() => expect(sentence(view.container)?.textContent).toBe('Run failed'));
  });

  test('count the runs that failed among several', async () => {
    const { container } = mount('session-1', [
      taskFixture({ id: 'run-1', status: 'completed' }),
      taskFixture({ id: 'run-2', status: 'failed' }),
    ]);
    await waitFor(() => expect(sentence(container)?.textContent).toBe('2 runs, 1 failed'));
    expect(sentence(container)?.getAttribute('href')).toBe('/runs/run-2');
  });

  test('say nothing when the only run finished well', async () => {
    const { container } = mount('session-1', [taskFixture({ id: 'run-1', status: 'completed' })]);
    await waitFor(() => expect(stub?.callsTo('bureau.tasks.list').length).toBe(1));
    expect(container.querySelector('.weft-chat-strip')).toBeNull();
  });

  test('open the run in place when followed, and leave a modified click to the browser', async () => {
    const { container } = mount('session-1', [taskFixture({ id: 'run-1', status: 'working' })]);
    await waitFor(() => expect(sentence(container)).not.toBeNull());
    const link = sentence(container);
    if (link === null) throw new Error('Expected the sentence to link');
    // A modified click is the browser's, so the page does not prevent it.
    expect(await fireEvent.click(link, { button: 0, metaKey: true })).toBe(true);
    expect(router.pathname).toBe('/');
    expect(await fireEvent.click(link, { button: 0 })).toBe(false);
    expect(router.pathname).toBe('/runs/run-1');
  });

  test('say nothing for a session with no run, and nothing when the Bureau cannot say', async () => {
    const none = mount('session-1', []);
    await waitFor(() => expect(stub?.callsTo('bureau.tasks.list').length).toBe(1));
    expect(none.container.querySelector('.weft-chat-strip')).toBeNull();
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
    expect(failing.container.querySelector('.weft-chat-strip')).toBeNull();
  });
});
