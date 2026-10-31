/**
 * The guard reads "is the server unreachable" from inside `fetch` and `callBureau`, which run in
 * effects. A tracked read made the effect that opened the Bureau's event stream run again each time
 * the server stopped answering, which restarted the stream (COR-1839, found by the task-follower
 * spec). This pins that reading it does not make the caller depend on it.
 */
import { render } from '@testing-library/svelte';
import { expect, test } from 'bun:test';
import { flushSync } from 'svelte';

import Harness from './write-guard.test-harness.svelte';

test('a fetch and a refuseWrite made inside an effect do not make it depend on the guard’s state', () => {
  const target = {
    fetch: Object.assign(async () => new Response('{}'), { preconnect: fetch.preconnect }),
  };
  let runs = 0;
  let control: { setDown: (down: boolean) => void } | undefined;
  const view = render(Harness, {
    props: {
      target,
      onRun: () => {
        runs += 1;
      },
      onReady: (ready: { setDown: (down: boolean) => void }) => {
        control = ready;
      },
    },
  } as never);
  flushSync();
  expect(runs).toBe(1);

  control!.setDown(true);
  flushSync();
  expect(runs).toBe(1);
  view.unmount();
});
