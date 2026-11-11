import { rejectionOf } from '@lostgradient/testing';
import { HttpClient } from '@lostgradient/weft';
import { QueryClient } from '@tanstack/svelte-query';
import { afterEach, describe, expect, test } from 'bun:test';

import { agentsListQuery } from '../lib/agent-queries.ts';
import { goalFixture, taskFixture } from '../lib/bureau-fixtures.test-support.ts';
import {
  faults,
  installBureauStub,
  readyAgent,
  StubFault,
  type BureauStub,
} from '../lib/bureau-stub.test-support.ts';
import { probeFor, RUNS_RECHECK_MS } from './view-probes.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

async function probeRuns(options: { tasks?: unknown[]; goals?: unknown[] }) {
  // A probe run earlier in the same test left its stub behind; restoring first keeps the original `fetch`.
  stub?.restore();
  stub = installBureauStub({
    'bureau.tasks.list': () => ({ tasks: options.tasks ?? [], nextPageToken: null }),
    'bureau.goals.list': () => ({ goals: options.goals ?? [], nextOffset: null }),
  });
  const probe = probeFor('runs', {});
  if (probe === undefined) throw new Error('The runs list has a probe.');
  return probe(new HttpClient({ baseUrl: 'http://localhost/api' }), new QueryClient());
}

describe('the runs probe', () => {
  test('asks again while the runs are empty, so a first run is noticed without leaving the page, and names the Bureau’s feed as the one that reports it', async () => {
    expect(await probeRuns({})).toEqual({
      empty: true,
      recheckMs: RUNS_RECHECK_MS,
      liveSource: 'bureau',
    });
  });

  test('stops asking once the Bureau has a task or a goal', async () => {
    expect(await probeRuns({ tasks: [taskFixture()] })).toEqual({ empty: false });
    expect(await probeRuns({ goals: [goalFixture('goal-1')] })).toEqual({ empty: false });
  });
});

describe('the workflows probe', () => {
  test('asks the list, and a type, but nothing for the page that makes a workflow', () => {
    expect(probeFor('workflows', {}, '/workflows')).toBeDefined();
    expect(probeFor('workflows', { type: 'digest' }, '/workflows/:workflow')).toBeDefined();
    // The first workflow is written here, so there is nothing to find before the page is shown.
    expect(probeFor('workflows', {}, '/workflows/new')).toBeUndefined();
  });
});

describe('the agents probe', () => {
  test('shares the list read with the page query while the route chunk loads', async () => {
    let calls = 0;
    stub = installBureauStub({
      'bureau.agents.list': () => {
        calls += 1;
        return {
          agents: [
            {
              name: 'alpha',
              displayName: 'Alpha',
              description: null,
              definitionRevision: 1,
              kind: 'code',
              a2a: false,
              media: null,
            },
          ],
        };
      },
    });
    const queryClient = new QueryClient();
    const page = queryClient.fetchQuery(agentsListQuery());
    const probe = probeFor('agents', { agent: 'alpha' });
    if (probe === undefined) throw new Error('Expected an agent probe.');

    await Promise.all([
      page,
      probe(new HttpClient({ baseUrl: 'http://localhost/api' }), queryClient),
    ]);
    expect(calls).toBe(1);
  });

  test('rechecks existence after a completed prefetch so a deleted agent becomes not found', async () => {
    let calls = 0;
    stub = installBureauStub({
      'bureau.agents.list': () => {
        calls += 1;
        return calls === 1
          ? {
              agents: [
                {
                  name: 'alpha',
                  displayName: 'Alpha',
                  description: null,
                  definitionRevision: 1,
                  kind: 'code',
                  a2a: false,
                  media: null,
                },
              ],
            }
          : { agents: [] };
      },
      'bureau.agents.definitions.get': () => {
        throw faults.notFound('alpha');
      },
    });
    const queryClient = new QueryClient();
    await queryClient.fetchQuery(agentsListQuery());
    const probe = probeFor('agents', { agent: 'alpha' });
    if (probe === undefined) throw new Error('Expected an agent probe.');

    expect(
      await rejectionOf(probe(new HttpClient({ baseUrl: 'http://localhost/api' }), queryClient)),
    ).toMatchObject({ status: 404 });
    expect(calls).toBe(2);
  });

  test('keeps forbidden and missing-agent faults at the probe boundary', async () => {
    stub = installBureauStub({
      'bureau.agents.list': () => {
        throw new StubFault('forbidden', 403, 'forbidden');
      },
    });
    const forbidden = probeFor('agents', { agent: 'alpha' });
    if (forbidden === undefined) throw new Error('Expected an agent probe.');
    expect(
      await rejectionOf(
        forbidden(new HttpClient({ baseUrl: 'http://localhost/api' }), new QueryClient()),
      ),
    ).toMatchObject({ status: 403 });

    stub.restore();
    stub = installBureauStub({
      'bureau.agents.list': () => ({ agents: [] }),
      'bureau.agents.definitions.get': () => {
        throw faults.notFound('alpha');
      },
    });
    const missing = probeFor('agents', { agent: 'alpha' });
    if (missing === undefined) throw new Error('Expected an agent probe.');
    expect(
      await rejectionOf(
        missing(new HttpClient({ baseUrl: 'http://localhost/api' }), new QueryClient()),
      ),
    ).toMatchObject({ status: 404 });
  });

  test('lets through an agent a disabled plugin ships, which the list leaves out, on every tab', async () => {
    stub = installBureauStub({
      'bureau.agents.list': () => ({ agents: [] }),
      'bureau.agents.definitions.get': () =>
        readyAgent({
          id: 'demo:release-helper',
          source: 'code',
          state: 'unavailable',
          unavailable: { code: 'plugin-disabled', message: 'Plugin Demo is disabled' },
          definition: null,
        }),
    });
    const queryClient = new QueryClient();
    for (const pattern of ['/agents/:agent', '/agents/:agent/memory']) {
      const probe = probeFor('agents', { agent: 'demo:release-helper' }, pattern);
      if (probe === undefined) throw new Error('Expected an agent probe.');
      expect(await probe(new HttpClient({ baseUrl: 'http://localhost/api' }), queryClient)).toEqual(
        { empty: false },
      );
    }
    // The page reads the same answer instead of asking again.
    expect(queryClient.getQueryData(['agents', 'definition', 'demo:release-helper'])).toMatchObject(
      { state: 'unavailable' },
    );
  });

  test('is not found for an agent the list leaves out that no plugin holds back', async () => {
    stub = installBureauStub({
      'bureau.agents.list': () => ({ agents: [] }),
      'bureau.agents.definitions.get': () => readyAgent({ id: 'broken', state: 'invalid' }),
    });
    const probe = probeFor('agents', { agent: 'broken' });
    if (probe === undefined) throw new Error('Expected an agent probe.');
    expect(
      await rejectionOf(
        probe(new HttpClient({ baseUrl: 'http://localhost/api' }), new QueryClient()),
      ),
    ).toMatchObject({ status: 404 });
  });
});

describe('the settings probe', () => {
  test('asks nothing for API reference and Plugins, whose parts read for themselves', () => {
    expect(probeFor('settings', {}, '/settings/api-reference')).toBeUndefined();
    expect(probeFor('settings', {}, '/settings/plugins')).toBeUndefined();
    expect(probeFor('settings', {}, '/settings')).toBeDefined();
    expect(probeFor('settings', {}, '/settings/data-and-retention')).toBeDefined();
  });
});
