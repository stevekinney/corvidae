/**
 * COR-1884 — the model catalog is assembled from the providers the loaded plugins contribute. A
 * plugin carries a provider, its catalog rows and the secret that holds its key; the host reads an
 * allowlist from `plugins.<name>.configuration.models`; and a top-level `providers` key is not read.
 */
import { openBungalow } from '@lostgradient/bungalow';
import { definePlugin } from '@lostgradient/interborough-plugin';
import { createModelCatalog } from '@lostgradient/operative';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';
import { workspacePlugins } from './plugins.ts';
import { ProviderConfigurationError } from './provider-configuration-error.ts';

const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** A home holding the configuration, secrets and agent files a test names. */
async function prepareHome(setup: {
  readonly configuration?: unknown;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly agents?: Readonly<Record<string, string>>;
}): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-provider-plugins-'));
  directories.push(home);
  if (setup.configuration !== undefined) {
    await writeFile(join(home, 'configuration.json'), JSON.stringify(setup.configuration));
  }
  const bungalow = await openBungalow({
    name: 'interborough',
    environment: { INTERBOROUGH_HOME: home },
  });
  try {
    for (const [key, value] of Object.entries(setup.secrets ?? {}))
      bungalow.writeSecret(key, value);
  } finally {
    bungalow.close();
  }
  await mkdir(join(home, 'agents'), { recursive: true });
  for (const [name, text] of Object.entries(setup.agents ?? {})) {
    await writeFile(join(home, 'agents', name), text);
  }
  return home;
}

async function startAt(home: string, options: Parameters<typeof startHost>[0] = {}) {
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    seed: false,
    ...options,
  });
  hosts.push(host);
  return host;
}

function pairsOf(host: Host): string[] {
  return host.bureau.models
    .catalog()
    .descriptors.map((row) => `${row.provider}/${row.model}`)
    .toSorted();
}

const staticRows = createModelCatalog().descriptors;
const KEY = 'fixture-provider-plugin-key-1';

describe('a plugin that contributes a provider', () => {
  test('puts the provider’s catalog row in the model catalog, and its key reaches the provider path', async () => {
    const [seed] = staticRows;
    if (seed === undefined) throw new Error('The static catalog is empty.');
    const handed: unknown[] = [];
    const definition = {
      name: 'lender',
      generate: (configuration: unknown) => {
        handed.push(configuration);
        return async () => ({ content: 'lent', toolCalls: [] });
      },
      stream: () => {
        throw new Error('The fixture provider does not stream.');
      },
    };
    const lender = definePlugin({
      name: 'lender',
      version: '1.0.0',
      description: 'Contributes a model provider with one row.',
      secrets: ['lender-api-key'],
      setup: () => ({
        providers: [
          {
            ...definition,
            rows: [{ ...seed, provider: 'lender', model: 'lender-1', aliases: [] }],
          },
        ],
      }),
    });
    const home = await prepareHome({ secrets: { 'lender-api-key': KEY } });

    const host = await startAt(home, {
      plugins: [{ descriptor: lender, source: 'package', location: '@fixture/lender' }],
      resolveProviderGenerate: (definitions, provider) => {
        const found = definitions.find((candidate) => candidate.name === provider.provider);
        if (found === undefined) throw new Error('No such provider.');
        return found.generate(provider);
      },
    });

    expect(pairsOf(host)).toEqual(['lender/lender-1']);
    const generate = host.generateFor({ provider: 'lender', model: 'lender-1' });
    expect(await generate({ messages: [] } as never)).toMatchObject({ content: 'lent' });
    expect(handed).toEqual([{ provider: 'lender', model: 'lender-1', apiKey: KEY }]);
  });

  test('offers nothing from a plugin whose secret is not set', async () => {
    const [seed] = staticRows;
    const lender = definePlugin({
      name: 'lender',
      version: '1.0.0',
      description: 'Contributes a model provider with one row.',
      secrets: ['lender-api-key'],
      setup: () => ({
        providers: [
          {
            name: 'lender',
            generate: () => async () => ({ content: '', toolCalls: [] }),
            stream: () => {
              throw new Error('The fixture provider does not stream.');
            },
            rows: [{ ...seed!, provider: 'lender', model: 'lender-1', aliases: [] }],
          },
        ],
      }),
    });
    const host = await startAt(await prepareHome({}), {
      plugins: [{ descriptor: lender, source: 'package', location: '@fixture/lender' }],
    });
    expect(pairsOf(host)).toEqual([]);
  });
});

describe('the providers the workspace ships', () => {
  test('declare exactly the three keys the host has always used', () => {
    expect(
      workspacePlugins().map(({ descriptor }) => [descriptor.name, descriptor.secrets]),
    ).toEqual([
      ['anthropic', ['anthropic-api-key']],
      ['openai', ['openai-api-key']],
      ['gemini', ['gemini-api-key']],
    ]);
  });

  test('offer the rows of every provider that has a key, and none without one', async () => {
    const home = await prepareHome({
      secrets: { 'anthropic-api-key': KEY, 'gemini-api-key': `${KEY}-2` },
    });
    const host = await startAt(home);
    const expected = staticRows
      .filter((row) => row.provider === 'anthropic' || row.provider === 'gemini')
      .map((row) => `${row.provider}/${row.model}`)
      .toSorted();
    expect(pairsOf(host)).toEqual(expected);
  });
});

describe('the allowlist', () => {
  test('in plugins.openai.configuration.models limits the catalog to the listed models', async () => {
    const home = await prepareHome({
      configuration: { plugins: { openai: { configuration: { models: ['gpt-4.1'] } } } },
      secrets: { 'openai-api-key': KEY },
    });
    const host = await startAt(home);
    expect(pairsOf(host)).toEqual(['openai/gpt-4.1']);
  });

  test('is not read from a top-level providers key, which has no effect', async () => {
    const home = await prepareHome({
      configuration: { providers: { openai: { models: ['gpt-4.1'] }, voyage: {} } },
      secrets: { 'openai-api-key': KEY },
    });
    const host = await startAt(home);
    const all = staticRows
      .filter((row) => row.provider === 'openai')
      .map((row) => `${row.provider}/${row.model}`)
      .toSorted();
    expect(all.length).toBeGreaterThan(1);
    expect(pairsOf(host)).toEqual(all);
  });
});

describe('an agent on a model of a plugin that is not enabled', () => {
  test('reports it unavailable when only anthropic is enabled', async () => {
    const agent = (name: string, model: string) =>
      [
        '---',
        `name: ${name}`,
        'description: An agent.',
        `model: ${model}`,
        '---',
        'Help.',
        '',
      ].join('\n');
    const home = await prepareHome({
      configuration: {
        plugins: { openai: { enabled: false }, gemini: { enabled: false } },
      },
      secrets: { 'anthropic-api-key': KEY, 'openai-api-key': `${KEY}-2` },
      agents: {
        'on-anthropic.md': agent('on-anthropic', 'anthropic/sonnet'),
        'on-openai.md': agent('on-openai', 'openai/gpt-4.1'),
      },
    });
    const host = await startAt(home);

    const listings = Object.fromEntries(
      host.bureau.agents.list().map((listing) => [listing.id, listing]),
    );
    expect(listings['on-anthropic']).toMatchObject({ state: 'ready' });
    expect(listings['on-openai']).toMatchObject({
      state: 'invalid',
      problem: { code: 'unknown-model' },
    });
  });
});

describe('connecting a provider', () => {
  test('writes the allowlist under the plugin, which reports it and asks for no restart', async () => {
    const home = await prepareHome({});
    const host = await startAt(home);

    await host.providers.connect({ provider: 'openai', apiKey: KEY, models: ['gpt-4.1'] });

    const written = JSON.parse(await readFile(join(home, 'configuration.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(written).toEqual({
      plugins: { openai: { configuration: { models: ['gpt-4.1'] } } },
    });
    expect(pairsOf(host)).toEqual(['openai/gpt-4.1']);
    const snapshot = await host.plugins.snapshot();
    const standing = snapshot.plugins.find((plugin) => plugin.descriptor.name === 'openai');
    expect(standing?.configuration).toEqual({ models: ['gpt-4.1'] });
    expect(standing?.restartRequired).toBe(false);
  });

  test('still asks for a restart when the plugin is turned off', async () => {
    const host = await startAt(await prepareHome({}));
    await host.plugins.update('openai', { enabled: false });
    const snapshot = await host.plugins.snapshot();
    const standing = snapshot.plugins.find((plugin) => plugin.descriptor.name === 'openai');
    expect(standing?.restartRequired).toBe(true);
  });
});

describe('changing a provider plugin’s configuration through the plugin routes', () => {
  const openaiPairs = (host: Host) => pairsOf(host).filter((pair) => pair.startsWith('openai/'));

  test('limits and restores the catalog at once, with no restart', async () => {
    const home = await prepareHome({ secrets: { 'openai-api-key': KEY } });
    const host = await startAt(home);
    const all = openaiPairs(host);
    expect(all.length).toBeGreaterThan(1);

    const limited = await host.plugins.update('openai', { configuration: { models: ['gpt-4.1'] } });

    expect(limited.restartRequired).toBe(false);
    expect(openaiPairs(host)).toEqual(['openai/gpt-4.1']);

    await host.plugins.update('openai', { configuration: null });

    expect(openaiPairs(host)).toEqual(all);
  });

  test('refuses an allowlist entry that matches no model, writes nothing, and keeps the catalog', async () => {
    const home = await prepareHome({ secrets: { 'openai-api-key': KEY } });
    const host = await startAt(home);
    const before = pairsOf(host);

    const failure = await host.plugins
      .update('openai', { configuration: { models: ['gpt-nonexistent'] } })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(ProviderConfigurationError);
    expect(String(failure)).toContain('plugins.openai.configuration.models[0]');
    expect(String(failure)).not.toContain('gpt-nonexistent');
    expect(existsSync(join(home, 'configuration.json'))).toBe(false);
    expect(pairsOf(host)).toEqual(before);
  });
});
