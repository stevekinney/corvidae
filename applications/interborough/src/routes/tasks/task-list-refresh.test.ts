/**
 * `/tasks` stays current while it is open: it asks the Bureau again every five seconds
 * (`REVIEW_POLL_MILLISECONDS`), as `/reviews` does. The clock is fake, so no case waits five seconds.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';

import { taskFixture } from '../../lib/bureau-fixtures.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorld,
  type BureauWorldStub,
} from '../../lib/bureau-world.test-support.ts';
import { settle, until } from '../../lib/fake-timers.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import Harness from './tasks-area.test-harness.svelte';

let stub: BureauWorldStub | undefined;
let world: BureauWorld;

// The route's code is loaded once, under real timers, so the outlet does not wait on the module
// system with the clock faked.
beforeAll(async () => {
  await import('./index.svelte');
});

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  jest.useFakeTimers();
});

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
  jest.useRealTimers();
});

const rows = (container: HTMLElement) => container.querySelectorAll('tbody tr').length;

test('the task list shows a task that arrives after five seconds, and not before', async () => {
  world = emptyBureauWorld({ tasks: [taskFixture({ id: 'run-a' })] });
  stub = installBureauWorld(world);
  router.navigate('/tasks', { replace: true });
  const { container } = render(Harness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
  await until(() => expect(rows(container)).toBe(1));

  world.tasks = [taskFixture({ id: 'run-b' }), ...world.tasks];
  // Not at four seconds: the poll is every five, and the fake clock may have moved a millisecond
  // while the page rendered, so the boundary is checked with a margin on either side.
  jest.advanceTimersByTime(4_000);
  await settle();
  expect(rows(container)).toBe(1);

  jest.advanceTimersByTime(1_000);
  await until(() => expect(rows(container)).toBe(2));
});

function openTasks() {
  router.navigate('/tasks', { replace: true });
  return render(Harness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

const named = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    taskFixture({ id: `run-${String(index).padStart(2, '0')}` }),
  );

test('a task created between the poll’s page reads is not repeated, and the page stays', async () => {
  world = emptyBureauWorld({ tasks: named(60) });
  stub = installBureauWorld(world);
  const view = openTasks();
  await until(() => expect(rows(view.container)).toBe(50));
  await fireEvent.click(view.getByRole('button', { name: 'Load more' }));
  await until(() => expect(rows(view.container)).toBe(60));

  // The poll reads page 0, then a task is created, then it reads page 1 from page 0's offset: the
  // page now starts with the row page 0 ended with.
  stub.on('bureau.tasks.list', (params) => {
    const offset = typeof params['offset'] === 'number' ? params['offset'] : 0;
    const page = world.tasks.slice(offset, offset + 50);
    const answer = {
      tasks: page,
      nextOffset: offset + page.length < world.tasks.length ? offset + page.length : null,
    };
    if (offset === 0) world.tasks = [taskFixture({ id: 'run-new' }), ...world.tasks];
    return answer;
  });
  jest.advanceTimersByTime(5_000);
  await settle(30);

  expect(view.container.textContent).not.toContain('Something went wrong');
  expect(rows(view.container)).toBe(60);
  const ids = [...view.container.querySelectorAll('a[href^="/tasks/"] code')].map((code) =>
    code.getAttribute('title'),
  );
  expect(new Set(ids).size).toBe(ids.length);
});

test('a poll that fails after the rows loaded keeps them, with the fault beside them', async () => {
  world = emptyBureauWorld({ tasks: named(2) });
  stub = installBureauWorld(world);
  const view = openTasks();
  await until(() => expect(rows(view.container)).toBe(2));

  stub.on('bureau.tasks.list', () => {
    throw new Error('The Bureau restarted.');
  });
  jest.advanceTimersByTime(5_000);
  await until(() => expect(view.container.querySelector('[role="alert"]')).not.toBeNull());

  expect(rows(view.container)).toBe(2);
  expect(view.container.textContent).not.toContain('The tasks could not be loaded');

  // Retry asks again, and a Bureau that answers takes the banner away.
  const asked = stub.callsTo('bureau.tasks.list').length;
  stub.on('bureau.tasks.list', () => ({ tasks: world.tasks, nextOffset: null }));
  await fireEvent.click(view.getByRole('button', { name: 'Retry' }));
  await until(() => expect(view.container.querySelector('[role="alert"]')).toBeNull());
  expect(stub.callsTo('bureau.tasks.list').length).toBeGreaterThan(asked);
  expect(rows(view.container)).toBe(2);
});

test('a first load that fails shows the error state in place of the table', async () => {
  world = emptyBureauWorld({ tasks: named(2) });
  stub = installBureauWorld(world);
  // The view frame asks once to learn the caller has a task; the list's own first read is the
  // second, and it fails.
  let reads = 0;
  stub.on('bureau.tasks.list', () => {
    reads += 1;
    if (reads > 1) throw new Error('The Bureau restarted.');
    return { tasks: world.tasks.slice(0, 1), nextOffset: null };
  });
  const view = openTasks();
  await until(() => expect(view.container.textContent).toContain('The tasks could not be loaded'));
  expect(rows(view.container)).toBe(0);
});
