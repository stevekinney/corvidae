/**
 * The host's model providers: the catalog it installs from Bungalow's `configuration.json` and
 * secrets, and the generate an agent assigned a catalog model resolves through Bureau's provider
 * path. No real provider key is ever used. The provider path runs against a fake client, and the
 * secret is a fixture written for the test.
 */
import { openBungalow } from '@lostgradient/bungalow';
import { resolveProviderGenerate, type ProviderConfiguration } from '@lostgradient/bureau';
import { createAgent, createModelCatalog } from '@lostgradient/operative';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host, type HostOptions } from './host.ts';
import { runTask } from './run-task.test-support.ts';

const FIXTURE_KEY = 'fixture-anthropic-key-7f3a';
const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'interborough-providers-'));
  directories.push(directory);
  return directory;
}

type Setup = {
  readonly configuration?: unknown;
  readonly secrets?: Readonly<Record<string, string>>;
};

/** A home directory holding the configuration file and secrets a test names. */
async function prepareHome(setup: Setup): Promise<string> {
  const home = await scratch();
  if (setup.configuration !== undefined) {
    await writeFile(join(home, 'configuration.json'), JSON.stringify(setup.configuration));
  }
  if (setup.secrets !== undefined) {
    const bungalow = await openBungalow({
      name: 'interborough',
      environment: { INTERBOROUGH_HOME: home },
    });
    try {
      for (const [key, value] of Object.entries(setup.secrets)) bungalow.writeSecret(key, value);
    } finally {
      bungalow.close();
    }
  }
  return home;
}

async function startAt(home: string, options: HostOptions = {}): Promise<Host> {
  const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0, ...options });
  hosts.push(host);
  return host;
}

async function start(setup: Setup, options: HostOptions = {}): Promise<Host> {
  return startAt(await prepareHome(setup), options);
}

function pairsOf(host: Host): string[] {
  return host.bureau.models
    .catalog()
    .descriptors.map((descriptor) => `${descriptor.provider}/${descriptor.model}`)
    .toSorted();
}

function staticPairs(providers: readonly string[]): string[] {
  return createModelCatalog()
    .descriptors.filter((descriptor) => providers.includes(descriptor.provider))
    .map((descriptor) => `${descriptor.provider}/${descriptor.model}`)
    .toSorted();
}

describe('a configuration that is not valid', () => {
  test('fails startup naming the file and the field when the catalog edits are wrong, and releases the home', async () => {
    const home = await prepareHome({
      configuration: { catalog: [{ provider: 'anthropic', model: 'sonnet', color: 'red' }] },
    });
    const failure = await startAt(home).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(String(failure)).toContain(join(home, 'configuration.json'));
    expect(String(failure)).toContain('catalog[0].color');

    // The failed start released Bungalow's lock, so a corrected file starts.
    await writeFile(join(home, 'configuration.json'), JSON.stringify({ catalog: [] }));
    const host = await startAt(home);
    expect(host.bureau.models.catalog().descriptors).toEqual([]);
  });

  test('starts, and skips the plugin, on an allowlist entry that matches no row', async () => {
    const home = await prepareHome({
      configuration: {
        plugins: { openai: { configuration: { models: ['gpt-4.1', 'gpt-nonexistent'] } } },
      },
      secrets: { 'openai-api-key': FIXTURE_KEY },
    });
    const host = await startAt(home);
    const snapshot = await host.plugins.snapshot();
    const standing = snapshot.plugins.find((plugin) => plugin.descriptor.name === 'openai');
    expect(standing).toMatchObject({
      status: 'skipped',
      problems: [{ code: 'configuration-invalid', field: 'models[1]' }],
    });
    expect(host.bureau.models.catalog().descriptors.map((row) => row.provider)).not.toContain(
      'openai',
    );
  });
});

describe('the installed catalog', () => {
  test('holds no model when no provider is configured, and a seeded scripted agent still runs', async () => {
    const warnings: string[] = [];
    const host = await start({}, { warn: (message) => warnings.push(message) });

    expect(host.bureau.models.catalog().descriptors).toEqual([]);
    const result = await runTask(host.bureau, 'assistant', 'Hello');
    expect(result.content).toBe(
      'Hello from the assistant. This reply is scripted; no model was called.',
    );
    expect(warnings).toEqual([]);
  });

  test('holds no model when no provider has a key, whatever the configuration says', async () => {
    const host = await start({ configuration: { providers: { anthropic: {} }, plugins: {} } });
    expect(host.bureau.models.catalog().descriptors).toEqual([]);
  });

  test('is the keyed providers’ rows, each stamped as the host’s, and survives a replace', async () => {
    const host = await start({
      configuration: { plugins: { gemini: { configuration: { models: ['pro'] } } } },
      secrets: { 'anthropic-api-key': FIXTURE_KEY, 'gemini-api-key': `${FIXTURE_KEY}-gemini` },
    });
    const expected = [...staticPairs(['anthropic']), 'gemini/gemini-2.5-pro'].toSorted();

    const before = host.bureau.models.catalog();
    expect(pairsOf(host)).toEqual(expected);
    expect(new Set(pairsOf(host)).size).toBe(before.descriptors.length);
    // Rows a host supplies are stamped as its own, never `static`.
    expect(
      before.descriptors.every((descriptor) => descriptor.source === 'operator-override'),
    ).toBe(true);

    const replaced = host.bureau.models.replace(before.descriptors);
    expect(replaced.revision).toBe(before.revision + 1);
    // Replacing with the rows it already holds keeps exactly those rows, so a replace cannot bring
    // a provider without a key back.
    expect(pairsOf(host)).toEqual(expected);
    expect(host.bureau.models.catalog().descriptors.length).toBe(expected.length);
  });

  test('omits a provider whose key is missing and warns once, naming the provider and key but no value, when it has an allowlist', async () => {
    const warnings: string[] = [];
    const host = await start(
      {
        configuration: { plugins: { openai: { configuration: { models: ['gpt-4.1'] } } } },
        secrets: { 'anthropic-api-key': FIXTURE_KEY },
      },
      { warn: (message) => warnings.push(message) },
    );

    expect(pairsOf(host)).toEqual(staticPairs(['anthropic']));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('openai');
    expect(warnings[0]).toContain('openai-api-key');
    expect(warnings.join('\n')).not.toContain(FIXTURE_KEY);
  });
});

/** A fake Anthropic client that answers every request with one fixed reply and records the requests. */
function createFakeClient(reply: string) {
  const requests: unknown[] = [];
  const client = {
    messages: {
      create: async (parameters: unknown) => {
        requests.push(parameters);
        return {
          id: 'message-1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: reply }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 5 },
        };
      },
    },
  };
  return { client, requests };
}

describe('an agent assigned a catalog model', () => {
  test('generates through the provider path with the secret, and the output comes back', async () => {
    const { client, requests } = createFakeClient('A reply from the fake provider.');
    const handed: ProviderConfiguration[] = [];
    const host = await start(
      {
        configuration: { plugins: { anthropic: { configuration: { models: ['sonnet'] } } } },
        secrets: { 'anthropic-api-key': FIXTURE_KEY },
      },
      {
        // Bureau’s own resolver builds the real provider function; the fake client stands in for
        // the SDK so no request leaves the process.
        resolveProviderGenerate: (definitions, provider, streamEventTarget, streaming) => {
          handed.push(provider);
          const withClient: ProviderConfiguration = Object.assign({}, provider, { client });
          return resolveProviderGenerate(definitions, withClient, streamEventTarget, streaming);
        },
      },
    );

    const agent = createAgent({
      name: 'catalog-agent',
      generate: host.generateFor({ provider: 'anthropic', model: 'sonnet' }),
    });
    const result = await agent.run('Hello').result();

    expect(result.content).toBe('A reply from the fake provider.');
    expect(requests).toHaveLength(1);
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      apiKey: FIXTURE_KEY,
    });
  });

  test('resolves through Bureau’s own resolver by default, without a request until a run generates', async () => {
    const requests: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL) => {
        requests.push(input instanceof Request ? input.url : input.toString());
        return Promise.reject(new Error('Resolving a generate must not touch the network.'));
      },
      { preconnect: original.preconnect },
    );
    try {
      const host = await start({
        configuration: {},
        secrets: { 'anthropic-api-key': `  ${FIXTURE_KEY}\n` },
      });
      // No `resolveProviderGenerate` option: this is the resolver the host ships with.
      expect(typeof host.generateFor({ provider: 'anthropic', model: 'sonnet' })).toBe('function');
    } finally {
      globalThis.fetch = original;
    }
    expect(requests).toEqual([]);
  });

  test('sends the trimmed secret to the provider through the shipped default resolver', async () => {
    const host = await start({
      configuration: {},
      secrets: { 'anthropic-api-key': `  ${FIXTURE_KEY}\n` },
    });
    // The fetch stub is installed after the host starts, so it sees only the run's request.
    const original = globalThis.fetch;
    const keyMatches: boolean[] = [];
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
        // Compared, never printed: a failure must not show the value.
        keyMatches.push(headers.get('x-api-key') === FIXTURE_KEY);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'message-1',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-5',
              content: [{ type: 'text', text: 'stubbed reply' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
      { preconnect: original.preconnect },
    );
    try {
      const agent = createAgent({
        name: 'default-path',
        generate: host.generateFor({ provider: 'anthropic', model: 'sonnet' }),
      });
      const result = await agent.run('Hello').result();
      expect(result.content).toBe('stubbed reply');
    } finally {
      globalThis.fetch = original;
    }
    expect(keyMatches).toEqual([true]);
  });

  test('hands the resolver the secret without the whitespace around it', async () => {
    const handed: ProviderConfiguration[] = [];
    const host = await start(
      {
        configuration: {},
        secrets: { 'anthropic-api-key': `\n  ${FIXTURE_KEY}  \n` },
      },
      {
        resolveProviderGenerate: (definitions, provider, streamEventTarget, streaming) => {
          handed.push(provider);
          return resolveProviderGenerate(definitions, provider, streamEventTarget, streaming);
        },
      },
    );
    host.generateFor({ provider: 'anthropic', model: 'sonnet' });
    expect(handed).toHaveLength(1);
    // Compared, not printed: a failure must not show the value.
    expect(handed[0]?.apiKey === FIXTURE_KEY).toBe(true);
  });

  test('cannot be given a model the catalog does not hold', async () => {
    const host = await start(
      {
        secrets: { 'anthropic-api-key': FIXTURE_KEY },
      },
      { warn: () => undefined },
    );

    // `openai` has no key, so it is not in the catalog.
    expect(() => host.generateFor({ provider: 'openai', model: 'gpt-4.1' })).toThrow('openai');
    expect(() => host.generateFor({ provider: 'anthropic', model: 'gpt-4.1' })).toThrow('gpt-4.1');
  });
});
