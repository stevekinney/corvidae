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
import { installFetchImplementation } from '../lib/live-source/fetch.test-support.ts';
import { probeFor, RUNS_RECHECK_MS, type ViewProbeFault } from './view-probes.ts';

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

describe('the plugin page probe (COR-2213)', () => {
  const PANEL = {
    plugin: 'acme',
    app: 'queue',
    title: 'Review queue',
    uri: 'ui://acme/queue/v1',
    placements: [{ kind: 'page', path: 'reviews/queue' }],
  };

  /** A host that lists `panels`, and `plugins` by name, title and status; a plugin read can be made to fail. */
  function host(options: {
    panels: readonly unknown[];
    plugins?: readonly { name: string; title: string; status: string }[];
    pluginsFail?: boolean;
    pageFails?: boolean;
  }): { restore: () => void; reads: string[] } {
    const reads: string[] = [];
    const restore = installFetchImplementation(async (input) => {
      const text =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(text, 'http://localhost').pathname;
      reads.push(path);
      if (path === '/host/panels') return Response.json({ apps: options.panels });
      if (/^\/host\/plugins\/[^/]+\/apps\/[^/]+$/.test(path)) {
        return options.pageFails === true
          ? new Response('no', { status: 500 })
          : Response.json({ html: '<div id="root"></div>', ui: {} });
      }
      if (path === '/host/plugins') {
        if (options.pluginsFail === true) return new Response('no', { status: 500 });
        return Response.json({
          configurationRevision: null,
          unloaded: [],
          plugins: (options.plugins ?? []).map(({ name, title, status }) => ({
            descriptor: {
              name,
              title,
              version: '1.0.0',
              description: '',
              required: false,
              enabledByDefault: true,
            },
            source: 'package',
            location: name,
            status,
            problems: [],
            contributions: [],
            enabled: status !== 'disabled',
            configuration: {},
            configurationSchema: null,
            running: { enabled: status !== 'disabled', configuration: {} },
            secrets: [],
            restartRequired: false,
          })),
        });
      }
      return new Response('not found', { status: 404 });
    });
    return { restore, reads };
  }

  async function probe(plugin: string, path: string) {
    const run = probeFor('plugin-page', { plugin, '*': path }, '/plugins/:plugin/*');
    if (run === undefined) throw new Error('A plugin page has a probe.');
    return run(new HttpClient({ baseUrl: 'http://localhost/api' }), new QueryClient());
  }

  test('finds a page a listed panel places, however many segments its path has, loads it, and reads no plugin', async () => {
    const served = host({ panels: [PANEL] });
    try {
      const queryClient = new QueryClient();
      const run = probeFor('plugin-page', { plugin: 'acme', '*': 'reviews/queue' });
      if (run === undefined) throw new Error('A plugin page has a probe.');
      expect(await run(new HttpClient({ baseUrl: 'http://localhost/api' }), queryClient)).toEqual({
        empty: false,
      });
      expect(served.reads).toEqual(['/host/panels', '/host/plugins/acme/apps/queue']);
      // The page reads the answer from the cache under its own key instead of asking again.
      expect(queryClient.getQueryData(['host', 'panels', 'page', 'acme', 'queue'])).toMatchObject({
        html: '<div id="root"></div>',
      });
    } finally {
      served.restore();
    }
  });

  test('fails when the page the panel serves cannot be read, which is the frame’s failed state, not a missing page', async () => {
    const served = host({ panels: [PANEL], pageFails: true });
    try {
      const fault = await rejectionOf(probe('acme', 'reviews/queue'));
      expect(fault).toBeInstanceOf(Error);
      expect(fault).not.toMatchObject({ status: 404 });
      expect(served.reads).toEqual(['/host/panels', '/host/plugins/acme/apps/queue']);
    } finally {
      served.restore();
    }
  });

  test('has no probe without the plugin and the path the route captures', () => {
    expect(probeFor('plugin-page', {}, '/plugins/:plugin/*')).toBeUndefined();
    expect(probeFor('plugin-page', { plugin: 'acme' }, '/plugins/:plugin/*')).toBeUndefined();
  });

  test('is not found, with no words of its own, for an address no panel places a page at', async () => {
    const served = host({
      panels: [PANEL],
      plugins: [{ name: 'acme', title: 'Acme', status: 'running' }],
    });
    try {
      const fault = await rejectionOf(probe('acme', 'elsewhere'));
      expect(fault).toMatchObject({ status: 404 });
      expect((fault as ViewProbeFault).words).toBeUndefined();
      // A page of another plugin at the same path is not this plugin's.
      expect(await rejectionOf(probe('other', 'reviews/queue'))).toMatchObject({ status: 404 });
    } finally {
      served.restore();
    }
  });

  test('says the plugin is disabled, in its words, when the host lists it as disabled', async () => {
    const served = host({
      panels: [],
      plugins: [{ name: 'acme', title: 'Acme reports', status: 'disabled' }],
    });
    try {
      const fault = (await rejectionOf(probe('acme', 'reviews/queue'))) as ViewProbeFault;
      expect(fault.status).toBe(404);
      expect(fault.words).toEqual({
        title: 'Acme reports is disabled',
        description: 'Its pages come back when you enable it and restart.',
        back: { label: 'Open Acme reports in Settings', href: '/settings/plugins?plugin=acme' },
      });
    } finally {
      served.restore();
    }
  });

  test('is only not found for a plugin the host lists as running with no such page, or cannot list at all', async () => {
    const running = host({
      panels: [],
      plugins: [{ name: 'acme', title: 'Acme', status: 'running' }],
    });
    try {
      expect(((await rejectionOf(probe('acme', 'x'))) as ViewProbeFault).words).toBeUndefined();
    } finally {
      running.restore();
    }
    const failing = host({ panels: [], pluginsFail: true });
    try {
      const fault = (await rejectionOf(probe('acme', 'x'))) as ViewProbeFault;
      expect(fault.status).toBe(404);
      expect(fault.words).toBeUndefined();
    } finally {
      failing.restore();
    }
  });

  test('lets a host that cannot list its panels fail the probe, which the page words itself', async () => {
    const restore = installFetchImplementation(async () => new Response('no', { status: 500 }));
    try {
      expect(await rejectionOf(probe('acme', 'reviews/queue'))).toBeInstanceOf(Error);
    } finally {
      restore();
    }
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
