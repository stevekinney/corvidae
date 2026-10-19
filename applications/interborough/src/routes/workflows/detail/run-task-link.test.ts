/**
 * A run's page links to its task at `/tasks/:id`, but only when the Bureau answers
 * `bureau.tasks.get` for that identifier: a run of the engine's own, or a task the caller may not
 * see, has no such page to go to.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { taskFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorldStub,
} from '../../../lib/bureau-world.test-support.ts';
import { router } from '../../../lib/router.svelte.ts';
import Harness from './run-task-link.test-harness.svelte';

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

describe('a run’s link to its task', () => {
  test('is there when the Bureau answers for the run’s identifier', async () => {
    stub = installBureauWorld(emptyBureauWorld({ tasks: [taskFixture({ id: 'run-1' })] }));
    const { container } = render(Harness, { props: { runId: 'run-1' } });
    await waitFor(() => expect(container.querySelector('a')).not.toBeNull());
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/tasks/run-1');
    expect(link?.textContent).toBe('View the task');
    expect(stub.callsTo('bureau.tasks.get').at(-1)?.params).toEqual({ taskId: 'run-1' });
  });

  test('opens the task in place when followed, and leaves a modified click to the browser', async () => {
    stub = installBureauWorld(emptyBureauWorld({ tasks: [taskFixture({ id: 'run-1' })] }));
    const { container } = render(Harness, { props: { runId: 'run-1' } });
    await waitFor(() => expect(container.querySelector('a')).not.toBeNull());
    const link = container.querySelector('a');
    if (link === null) throw new Error('Expected the link');
    expect(await fireEvent.click(link, { button: 0, metaKey: true })).toBe(true);
    expect(router.pathname).toBe('/');
    expect(await fireEvent.click(link, { button: 0 })).toBe(false);
    expect(router.pathname).toBe('/tasks/run-1');
  });

  test('is not there when the Bureau has no such task', async () => {
    stub = installBureauWorld(emptyBureauWorld({ tasks: [] }));
    const { container } = render(Harness, { props: { runId: 'engine-run-9' } });
    await waitFor(() => expect(stub?.callsTo('bureau.tasks.get').length).toBe(1));
    // The answer has been read, and it left nothing on the page.
    await Bun.sleep(20);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('');
  });

  test('is not there when the Bureau cannot answer, because a run must not wait on it', async () => {
    stub = installBureauWorld(emptyBureauWorld());
    stub.on('bureau.tasks.get', () => {
      throw new Error('The Bureau broke.');
    });
    const { container } = render(Harness, { props: { runId: 'run-1' } });
    await waitFor(() => expect(stub?.callsTo('bureau.tasks.get').length).toBe(1));
    await Bun.sleep(20);
    expect(container.querySelector('a')).toBeNull();
  });
});
