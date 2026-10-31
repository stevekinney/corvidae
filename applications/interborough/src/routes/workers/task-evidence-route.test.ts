/**
 * The Workers route's task view shows the result delivery history for every
 * task and the retained dead-letter result only for a dead-lettered one
 * (COR-284). The panels read their own data; the route decides when they exist.
 */
import { render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { createQueryClient } from '../../lib/query.ts';
import { router } from '../../lib/router.svelte.ts';
import { routeHappyPaths } from './index-actions.test-support.ts';
import WorkersRoute from './index.svelte';
import WorkersRouteTestHarness from './workers-route-test-harness.test-harness.svelte';
import {
  realClient,
  ScriptedFetch,
  taskLedgerDetailFixture,
} from './workers-route-test-support.test-support.ts';

let scripted: ScriptedFetch | undefined;

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate('/health/workers?tab=diagnostics&task=op_ledger_route', { replace: true });
});
afterEach(() => {
  scripted?.restore();
  scripted = undefined;
});

const NO_DELIVERIES = {
  operationId: 'op_ledger_route',
  historyLimit: 20,
  droppedCount: 0,
  deliveries: [],
};

function renderRoute() {
  return render(WorkersRouteTestHarness, {
    props: {
      client: realClient(),
      queryClient: createQueryClient(),
      component: WorkersRoute,
      principalScopes: ['system:read', 'system:admin'],
    },
  });
}

describe('Workers route — task evidence panels', () => {
  test('a queued task shows delivery history and no dead-letter panel', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);
    scripted.routeJsonRpcMethod('weft.tasks.get', taskLedgerDetailFixture());
    scripted.routeJsonRpcMethod('weft.tasks.deliveries', NO_DELIVERIES);

    const { findByText, queryByText } = renderRoute();

    expect(await findByText('No results submitted')).not.toBeNull();
    expect(queryByText('Retained dead-letter result')).toBeNull();
  });

  test('a dead-lettered task also offers its retained result', async () => {
    scripted = new ScriptedFetch();
    routeHappyPaths(scripted);
    scripted.routeJsonRpcMethod('weft.tasks.get', {
      ...taskLedgerDetailFixture(),
      state: 'deadLettered',
      attemptToken: 'token',
      pendingStatus: 'completed',
      resultDigest: 'sha256:result',
      deadLetteredAt: 1_700_000_100_000,
      persistenceFailureReason: 'result-resolution-storage-exhausted',
    });
    scripted.routeJsonRpcMethod('weft.tasks.deliveries', NO_DELIVERIES);

    const { findByText, getByRole } = renderRoute();

    expect(await findByText('Retained dead-letter result')).not.toBeNull();
    expect(getByRole('button', { name: 'Inspect retained result' })).not.toBeNull();
    expect(await findByText('No results submitted')).not.toBeNull();
  });
});
