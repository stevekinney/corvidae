/**
 * The Tasks routes through the route outlet and the view frame: a Bureau that refuses the list
 * leaves `/tasks` forbidden, and one that has no such task leaves `/tasks/:id` not found. Both are
 * the frame's, so the page behind them never mounts and never reads the task.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { VIEW_COPY } from '../../app/copy.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
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

function open(path: string) {
  stub = installBureauWorld(emptyBureauWorld());
  router.navigate(path, { replace: true });
  return render(Harness, {
    props: { client: new HttpClient({ baseUrl: 'http://localhost/api' }), scopes: AUTHORIZATION_SCOPES },
  } as never);
}

describe('the Tasks routes', () => {
  test('/tasks is forbidden, in data-state, when the Bureau refuses the caller its tasks', async () => {
    stub = installBureauWorld(emptyBureauWorld());
    stub.on('bureau.tasks.list', () => {
      throw new StubFault('Forbidden', 403, 'No.');
    });
    router.navigate('/tasks', { replace: true });
    const view = render(Harness, {
      props: { client: new HttpClient({ baseUrl: 'http://localhost/api' }), scopes: AUTHORIZATION_SCOPES },
    } as never);
    await waitFor(() =>
      expect(view.container.querySelector('[data-view="tasks"]')?.getAttribute('data-state')).toBe(
        'forbidden',
      ),
    );
    expect(view.container.querySelector('h1')?.textContent).toBe(VIEW_COPY.tasks.forbidden.title);
  });

  test('/tasks/:id is not found, in data-state, when the Bureau answers NotFound for the task', async () => {
    const { container } = open('/tasks/run-9');
    await waitFor(() =>
      expect(container.querySelector('[data-view="tasks"]')?.getAttribute('data-state')).toBe(
        'not-found',
      ),
    );
    expect(container.querySelector('h1')?.textContent).toBe(VIEW_COPY.tasks.notFound?.title);
    // The page behind the frame never mounted, so it asked for nothing after the probe.
    expect(stub?.callsTo('bureau.tasks.get').length).toBe(1);
    expect(stub?.streams.length).toBe(0);
  });
});
