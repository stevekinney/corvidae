import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createProbeClientWithFetch } from '../src/__fixtures__/probe-client/fetch-operation-client.generated.ts';
import { createProbeClientWithTransport } from '../src/__fixtures__/probe-client/portable-operation-client.generated.ts';
import { CatalogClientError } from '../src/client/index.ts';
import { createOperationClientSources } from './generate-operation-client.ts';
import { FIXTURE_CLIENT_DIRECTORY, fixtureClientSources } from './operation-client-fixture.ts';
import {
  fixtureHandler,
  fixtureOptions,
  fixtureSnapshot,
} from './operation-client-test-support.ts';
import { svelteFixtureSources } from './svelte-client-fixture.ts';

async function generatedText(
  options: Parameters<typeof fixtureOptions>[0] = {},
): Promise<{ readonly sources: ReadonlyMap<string, string>; readonly text: string }> {
  const sources = await createOperationClientSources(fixtureSnapshot(), fixtureOptions(options));
  return { sources, text: [...sources.values()].join('\n') };
}

describe('createOperationClientSources for a catalog that is not Weft', () => {
  it('matches the committed paged Svelte catalog fixture', async () => {
    const sources = await svelteFixtureSources();
    const directory = join(import.meta.dir, '../../backchannel-svelte/tests/fixture/generated');
    const names = await readdir(directory);
    expect(names.toSorted()).toEqual([...sources.keys()].toSorted());
    for (const [name, source] of sources)
      expect(await Bun.file(join(directory, name)).text()).toBe(source);
    const svelte = sources.get('operation-client.svelte.ts') ?? '';
    expect(svelte).toContain('createPagination');
    expect(svelte).toContain('useProbeJobsWatch');
    expect(svelte).toContain('ProbeProvider');
  });
  it('generates scoped Svelte reads and explicit commands only for declared behavior', async () => {
    const snapshot = fixtureSnapshot();
    const operations = snapshot.operations.map((operation) => {
      if (operation.name === 'probe.jobs.list')
        return { ...operation, behavior: { kind: 'read' as const, key: ['limit'] } };
      if (operation.name === 'probe.jobs.cancel')
        return {
          ...operation,
          behavior: { kind: 'command' as const, invalidates: ['probe.jobs.list'] },
        };
      return operation;
    });
    const sources = await createOperationClientSources(
      { ...snapshot, operations },
      { ...fixtureOptions({ portableEntries: true }), svelte: true },
    );
    const generated = sources.get('operation-client.svelte.ts') ?? '';
    expect(generated).toContain('useProbeJobsList');
    expect(generated).toContain('useProbeJobsCancel');
    expect(generated).toMatch(/["']probe\.jobs\.list["']/u);
    expect(generated).not.toContain('useProbeUsersGet');
    expect(generated).toContain('@lostgradient/backchannel-svelte');
  });
  it('emits no Weft name, path, domain or example', async () => {
    const { text } = await generatedText();
    expect(text).not.toMatch(/weft/iu);
  });

  it('names the factory, the package and the server from its options', async () => {
    const { sources } = await generatedText();
    const main = sources.get('operation-client.generated.ts') ?? '';
    expect(main).toContain('export function createProbeClient(connection: JsonRpcHttpConnection)');
    expect(main).toContain("import { CATALOG_OPERATION_NAMES } from '@example/probe';");
    expect(main).toContain('Build a typed client for a remote Probe server');
    expect(main).toContain("from '@lostgradient/backchannel/client';");
  });

  it('groups operations by tag and writes one file per domain', async () => {
    const { sources } = await generatedText();
    expect([...sources.keys()].toSorted()).toEqual([
      'jobs-operations.generated.ts',
      'operation-client.generated.ts',
      'users-operations.generated.ts',
    ]);
  });

  it('lists the JSON-RPC operations and the REST-only ones apart', async () => {
    const { sources } = await generatedText();
    const main = sources.get('operation-client.generated.ts') ?? '';
    expect(main).toMatch(
      /CATALOG_OPERATION_NAMES = \[\s*'probe\.jobs\.cancel',\s*'probe\.jobs\.list',\s*\] as const/u,
    );
    expect(main).toMatch(
      /CLIENT_OPERATION_NAMES = \[\s*'probe\.jobs\.cancel',\s*'probe\.jobs\.list',\s*'probe\.users\.get',\s*\] as const/u,
    );
  });

  it('strips the REST path prefix its options name', async () => {
    const { sources } = await generatedText();
    expect(sources.get('operation-client.generated.ts')).toContain('"path":"/users/:id"');
    const unprefixed = await generatedText({ restPathPrefix: undefined });
    expect(unprefixed.sources.get('operation-client.generated.ts')).toContain(
      '"path":"/api/users/:id"',
    );
  });

  it('takes its examples from the snapshot unless the options name them', async () => {
    const { sources } = await generatedText();
    expect(sources.get('operation-client.generated.ts')).toContain(
      "const requested = 'probe.jobs.cancel';",
    );
    const named = await generatedText({ examples: { callable: 'probe.jobs.list' } });
    expect(named.sources.get('operation-client.generated.ts')).toContain(
      "const requested = 'probe.jobs.list';",
    );
  });

  it('takes its connection from its options, importing it beside the runtime or elsewhere', async () => {
    const own = await generatedText({
      connection: {
        typeName: 'ProbeConnection',
        transportName: 'probeTransport',
        importSpecifier: '../probe-transport.ts',
        defaultValue: '{}',
        description: ['Pass nothing to use the environment.'],
        example: '{}',
      },
    });
    const main = own.sources.get('operation-client.generated.ts') ?? '';
    expect(main).toContain("from '../probe-transport.ts';");
    expect(main).toContain('connection: ProbeConnection = {}');
    expect(main).toContain('probeTransport(connection)');
    expect(main).not.toContain('httpJsonRpcTransport');
  });

  it('excludes the REST-only operations of a tag its options exclude', async () => {
    const { sources } = await generatedText({ excludedRestTags: ['Users'] });
    expect(sources.get('operation-client.generated.ts')).not.toContain('probe.users.get');
  });

  it('is deterministic across runs', async () => {
    const first = await generatedText();
    const second = await generatedText();
    expect([...first.sources]).toEqual([...second.sources]);
  });

  it('formats each file with the formatter it is given, naming the file', async () => {
    const seen: string[] = [];
    await generatedText({
      format: async (source, filePath) => {
        seen.push(filePath);
        return source;
      },
    });
    expect(seen).toContain('src/generated/operation-client.generated.ts');
  });
});

describe('createOperationClientSources: subscription methods', () => {
  const MAIN = 'operation-client.generated.ts';
  const TYPES = 'subscription-operations.generated.ts';

  it("emits none with subscriptions 'none', which is the default", async () => {
    for (const options of [{}, { subscriptions: 'none' as const }]) {
      const { sources, text } = await generatedText(options);
      expect(sources.has(TYPES)).toBe(false);
      expect(text).not.toContain('SUBSCRIPTION_OPERATION_NAMES');
      expect(text).not.toContain('probe.jobs.watch');
      expect(sources.get(MAIN)).toContain('): CatalogOperations {');
    }
  });

  it("emits a method for each subscription with an HTTP route under 'generic'", async () => {
    const { sources } = await generatedText({ subscriptions: 'generic' });
    expect(sources.get(MAIN)).toMatch(
      /SUBSCRIPTION_OPERATION_NAMES = \[\s*'other\.feed\.watch',\s*'probe\.jobs\.watch',\s*\] as const/u,
    );
    // The subscription without an HTTP route is not served on the route, so it gets no method.
    expect(sources.get(MAIN)).not.toContain('probe.jobs.audit');
    expect(sources.get(TYPES)).not.toContain('probe.jobs.audit');
    expect(sources.get(MAIN)).toContain('): CatalogOperations & SubscriptionOperations {');
  });

  it('types each subscription with its input and the event its eventSchema declares', async () => {
    const { sources } = await generatedText({
      subscriptions: 'generic',
      // One subscription, so its shapes are not shared with another and stay inline.
      subscriptionRoutes: { include: (operation) => operation.name === 'probe.jobs.watch' },
    });
    const types = sources.get(TYPES) ?? '';
    expect(types).toContain("'probe.jobs.watch': {");
    expect(types).toContain('readonly input: {');
    expect(types).toMatch(/readonly event: \{[^}]*"emittedAtMs": number/u);
    expect(types).toMatch(/readonly event: \{[^}]*"payload": Record<string, unknown>/u);
  });

  it('leaves out the subscriptions the route options do not include', async () => {
    const { sources } = await generatedText({
      subscriptions: 'generic',
      subscriptionRoutes: { include: (operation) => operation.name.startsWith('probe.') },
    });
    expect(sources.get(MAIN)).toContain("'probe.jobs.watch'");
    expect(sources.get(MAIN)).not.toContain('other.feed.watch');
    expect(sources.get(TYPES)).not.toContain('other.feed.watch');
  });

  it('serves the routes under the path prefix its options name', async () => {
    const standard = await generatedText({ subscriptions: 'generic' });
    expect(standard.sources.get(MAIN)).toContain('routePrefix: "/v1/subscriptions"');
    const mounted = await generatedText({
      subscriptions: 'generic',
      subscriptionRoutes: { pathPrefix: '/probe/v1/subscriptions' },
    });
    expect(mounted.sources.get(MAIN)).toContain('routePrefix: "/probe/v1/subscriptions"');
  });

  it('emits no Weft name either', async () => {
    const { text } = await generatedText({ subscriptions: 'generic' });
    expect(text).not.toMatch(/weft/iu);
  });

  it('adds no file when no subscription is selected', async () => {
    const { sources } = await generatedText({
      subscriptions: 'generic',
      subscriptionRoutes: { include: () => false },
    });
    expect(sources.has(TYPES)).toBe(false);
    expect(sources.get(MAIN)).toContain('): CatalogOperations {');
  });

  it('emits Fetch subscriptions only for selected routes', async () => {
    const configured = await generatedText({
      portableEntries: true,
      subscriptions: 'generic',
      subscriptionRoutes: {
        include: (operation) => operation.name.startsWith('probe.'),
        pathPrefix: '/custom',
      },
    });
    const fetchEntry = configured.sources.get('fetch-operation-client.generated.ts') ?? '';
    expect(fetchEntry).toContain("'probe.jobs.watch'");
    expect(fetchEntry).not.toContain('other.feed.watch');
    expect(fetchEntry).toContain('routePrefix: "/custom"');
    const without = await generatedText({ portableEntries: true, subscriptions: 'none' });
    expect(without.sources.get('fetch-operation-client.generated.ts')).not.toContain(
      'Subscription',
    );
  });
});

describe('the checked-in fixture client', () => {
  it('is what the generator emits now (run scripts/update-client-fixture.ts to refresh it)', async () => {
    const sources = await fixtureClientSources();
    const onDisk = new Map<string, string>();
    for (const fileName of await readdir(FIXTURE_CLIENT_DIRECTORY)) {
      onDisk.set(fileName, await Bun.file(join(FIXTURE_CLIENT_DIRECTORY, fileName)).text());
    }
    expect([...onDisk.keys()].toSorted()).toEqual([...sources.keys()].toSorted());
    for (const [fileName, source] of sources) expect(onDisk.get(fileName)).toBe(source);
  });
});

describe('portable generated entries', () => {
  it('opens the generated Fetch subscription on the configured route and aborts it', async () => {
    const { host, handler } = fixtureHandler();
    host.feed.publish('first');
    const controller = new AbortController();
    const requests: Request[] = [];
    const client = createProbeClientWithFetch({
      baseUrl: 'http://localhost',
      headers: { authorization: 'Bearer test' },
      fetch: async (url, init) => {
        const request = new Request(url, init);
        requests.push(request);
        const target = new URL(request.url);
        target.pathname = target.pathname.replace('/probe/v1/', '/v1/');
        return handler(new Request(target, request));
      },
    });
    const stream = client['probe.jobs.watch']({ topic: 'jobs' }, { signal: controller.signal });
    const iterator = stream[Symbol.asyncIterator]();
    const event = await iterator.next();
    expect(event.value).toMatchObject({ type: 'event', id: '1', data: { kind: 'first' } });
    expect(await iterator.next()).toEqual({ done: false, value: { type: 'replay-complete' } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'http://localhost/probe/v1/subscriptions/probe.jobs.watch?topic=jobs',
    );
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer test');
    controller.abort();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(requests[0]?.signal.aborted).toBe(true);
  });

  it('regenerates deterministically when an operation is added', async () => {
    const snapshot = fixtureSnapshot();
    const options = fixtureOptions({ portableEntries: true });
    const initial = {
      ...snapshot,
      operations: snapshot.operations.filter((operation) => operation.name !== 'probe.jobs.cancel'),
    };
    const before = await createOperationClientSources(initial, options);
    const after = await createOperationClientSources(snapshot, options);
    expect([...after]).toEqual([...(await createOperationClientSources(snapshot, options))]);
    expect(before.get('portable-operation-client.generated.ts')).not.toContain('probe.jobs.cancel');
    expect(after.get('portable-operation-client.generated.ts')).toContain('probe.jobs.cancel');
    expect(before.get('fetch-operation-client.generated.ts')).toBe(
      after.get('fetch-operation-client.generated.ts'),
    );
    expect(after.get('portable-operation-client.generated.ts')).not.toContain(
      'operation-client.generated.ts',
    );
  });

  it('forwards calls, cancellation, and structured faults through the supplied transport', async () => {
    const calls: unknown[] = [];
    const controller = new AbortController();
    const client = createProbeClientWithTransport(async (name, input, options) => {
      calls.push([name, input]);
      if (options?.signal) {
        return new Promise((_resolve, reject) => {
          options.signal!.addEventListener('abort', () => reject(options.signal!.reason), {
            once: true,
          });
        });
      }
      return null;
    });
    await client['probe.jobs.list']({ limit: 3 });
    await client['probe.jobs.cancel']({ id: 'job' });
    expect(calls).toEqual([
      ['probe.jobs.list', { limit: 3 }],
      ['probe.jobs.cancel', { id: 'job' }],
    ]);
    const pending = client['probe.jobs.list']({}, { signal: controller.signal });
    controller.abort();
    expect(await rejectionOf(pending)).toBe(controller.signal.reason);
    expect(calls).toHaveLength(3);
    const fault = new CatalogClientError('probe.jobs.list', {
      code: -32001,
      message: 'Denied',
      data: { remediation: 'Sign in' },
    });
    const failing = createProbeClientWithTransport(async () => {
      throw fault;
    });
    expect(await rejectionOf(failing['probe.jobs.list']({}))).toBe(fault);
    expect(fault.data).toEqual({ remediation: 'Sign in' });
  });

  it('sends a Fetch call without mutating its input or headers', async () => {
    const input = { id: 'job' };
    const headers = { authorization: 'Bearer test' };
    const originalInput = structuredClone(input);
    const originalHeaders = structuredClone(headers);
    const requests: [string | URL | Request, RequestInit | undefined][] = [];
    const client = createProbeClientWithFetch({
      baseUrl: '/api/',
      headers,
      fetch: async (url, init) => {
        requests.push([url, init]);
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
        return Response.json({
          jsonrpc: '2.0',
          id: (JSON.parse(init.body) as { id: string }).id,
          result: null,
        });
      },
    });
    await client['probe.jobs.cancel'](input);
    expect(requests[0]?.[0]).toBe('/api/jsonrpc');
    expect(requests[0]?.[1]?.headers).toEqual({ 'content-type': 'application/json', ...headers });
    expect(JSON.parse(requests[0]?.[1]?.body as string)).toEqual({
      jsonrpc: '2.0',
      id: expect.stringMatching(/^catalog-client-\d+$/u),
      method: 'probe.jobs.cancel',
      params: input,
    });
    expect(input).toEqual(originalInput);
    expect(headers).toEqual(originalHeaders);
  });
});
