/**
 * `/tasks` stays current while it is open: it asks the Bureau again every five seconds
 * (`REVIEW_POLL_MILLISECONDS`), as `/reviews` does. The clock is fake, so no case waits five seconds.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, render } from '@testing-library/svelte';
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
