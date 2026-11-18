import { describe, expect, it } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createOperationClientSources } from './generate-operation-client.ts';
import { FIXTURE_CLIENT_DIRECTORY, fixtureClientSources } from './operation-client-fixture.ts';
import { fixtureOptions, fixtureSnapshot } from './operation-client-test-support.ts';

async function generatedText(
  options: Parameters<typeof fixtureOptions>[0] = {},
): Promise<{ readonly sources: ReadonlyMap<string, string>; readonly text: string }> {
  const sources = await createOperationClientSources(fixtureSnapshot(), fixtureOptions(options));
  return { sources, text: [...sources.values()].join('\n') };
}

describe('createOperationClientSources for a catalog that is not Weft', () => {
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
