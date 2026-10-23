/**
 * The start wizard reads the engine, so `/runs` tells a caller without
 * `workflows:read` so, in the words copy.ts holds, instead of sending them to a form the engine
 * would refuse.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { VIEW_COPY } from '../../../app/copy.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorldStub,
} from '../../../lib/bureau-world.test-support.ts';
import { scopeReason } from '../../../lib/scopes.svelte.ts';
import { landAt } from '../../chat/pages.test-support.ts';

let stub: BureauWorldStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

function open(path: string) {
  stub = installBureauWorld(emptyBureauWorld());
  stub.on('bureau.goals.list', () => ({ goals: [], nextOffset: null }));
  stub.on('bureau.contexts.list', () => ({ contexts: [], nextOffset: null }));
  stub.on('bureau.agents.list', () => ({ agents: [] }));
  landAt(path);
  return render(RouteOutletHarness, {
    props: { client: new HttpClient({ baseUrl: 'http://localhost/api' }), scopes: [] },
  } as never);
}

describe('the engine’s start wizard for a caller who may not read the engine', () => {
  test('?view=start says the engine’s scope is needed', async () => {
    const view = open('/runs?view=start');

    await view.findByRole('heading', { level: 1, name: VIEW_COPY.runs.forbidden.title });
    expect(view.getByText(scopeReason('workflows:read'))).not.toBeNull();
  });
});
