/**
 * The Workers page with a worker open, on a host whose state lives in a temporary directory
 * (COR-2548). The capture of the open worker read "Running on SQ…rborough-e2e-m21o32/home" under the
 * heading: the host's own path, which no page says in its own words (owner, 2026-11-19). The header
 * says the storage in plain words and holds the path only in Storage details.
 */
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { stubHostPaths } from '../../lib/bureau-stub.test-support.ts';
import { createQueryClient } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import {
  forbiddenVisibleText,
  PATH_ALLOWED_SELECTOR,
  visibleTextOutsideCopyControls,
} from '../../lib/visible-text-rules.ts';
import { routeHappyPaths, worker } from './index-actions.test-support.ts';
import WorkersRoute from './index.svelte';
import WorkersRouteTestHarness from './workers-route-test-harness.test-harness.svelte';
import { realClient, ScriptedFetch } from './workers-route-test-support.test-support.ts';

const HOME = '/tmp/interborough-e2e-m21o32/home';

let scripted: ScriptedFetch | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
});

afterEach(() => {
  cleanup();
  scripted?.restore();
  scripted = undefined;
});

describe('Workers route — no host path in the page', () => {
  test('an open worker, on a host that keeps its state in a temporary directory, shows no path outside a copy control', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted, {
      workers: [worker({ id: 'wkr_selected', name: 'E2e fleet worker 1' })],
    });
    scripted.routeRest(
      (url) => url.pathname === '/host/paths',
      () =>
        Response.json({
          ...stubHostPaths(`${HOME}/agents`, `${HOME}/workflows`),
          database: { kind: 'sqlite', path: `${HOME}/interborough.sqlite` },
        }),
    );
    router.navigate('/health/workers?worker=wkr_selected', { replace: true });

    const view = render(WorkersRouteTestHarness, {
      props: {
        client: realClient(),
        queryClient: createQueryClient(),
        component: WorkersRoute,
        principalScopes: ['system:read', 'system:admin'],
      },
    });
    const line = await view.findByTestId('storage-backend');
    await waitFor(() => expect(line.textContent).toContain('Running on SQLite'));
    const detail = await view.findByTestId('worker-detail');

    expect(line.querySelector('.ib-storage-backend__line')?.textContent?.trim()).toBe(
      'Running on SQLite',
    );
    expect(
      forbiddenVisibleText(visibleTextOutsideCopyControls(view.container, PATH_ALLOWED_SELECTOR)),
    ).toEqual([]);
    expect(detail.textContent).not.toContain(HOME);
  });
});
