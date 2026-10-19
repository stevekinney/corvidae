/**
 * A reloaded page of a completed session task resumes from the cursor it kept, and the Bureau
 * replays nothing past it and ends the stream at once. The page tells the follower the task is over
 * (`isOver` in `task-detail.svelte`), because without it the follower would see a clean end with a
 * cursor and resume every second for as long as the page is open.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';

import { taskFixture } from '../../lib/bureau-fixtures.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorldStub,
} from '../../lib/bureau-world.test-support.ts';
import { settle } from '../../lib/fake-timers.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { taskCursorKey } from './task-follower.svelte.ts';
import Harness from './tasks-area.test-harness.svelte';

let stub: BureauWorldStub | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
  jest.useRealTimers();
});

test('a reloaded completed session task does not resubscribe every second', async () => {
  window.sessionStorage.setItem(
    taskCursorKey('run-r'),
    JSON.stringify({
      cursor: '12',
      artifact: { artifactId: 'run-r:result', text: 'Kept answer.', truncated: false },
    }),
  );
  stub = installBureauWorld(
    emptyBureauWorld({
      tasks: [taskFixture({ id: 'run-r', contextId: 'session-1', status: 'completed' })],
    }),
  );
  router.navigate('/tasks/run-r', { replace: true });
  const { findByText } = render(Harness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
  await findByText('Completed');
  await findByText('Kept answer.');
  await waitFor(() => expect(stub?.streams.length).toBeGreaterThanOrEqual(1));

  // Ten simulated seconds in which the Bureau ends every stream the page opens, as it does for a
  // stream resumed past a task's end.
  jest.useFakeTimers();
  let ended = 0;
  for (let second = 0; second < 10; second += 1) {
    for (const stream of stub?.streams.slice(ended) ?? []) stream.end();
    ended = stub?.streams.length ?? 0;
    await settle();
    jest.advanceTimersByTime(1_000);
    await settle();
  }

  // The first stream resumed from the kept cursor, and at most one more was opened before the
  // page had read the task as over; unguarded, it was eleven.
  expect(stub?.streams.length).toBeLessThanOrEqual(3);
  expect(stub?.streams[0]?.lastEventId).toBe('12');
});
