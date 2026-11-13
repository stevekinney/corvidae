import { initializeWorkspaceHome } from './workspace-home.test-support.ts';
/**
 * COR-1884 — the model catalog is assembled from the providers the loaded plugins contribute. A
 * plugin carries a provider, its catalog rows and the secret that holds its key; the host reads an
 * allowlist from `plugins.<name>.configuration.models`; and a top-level `providers` key is not read.
 */
import { openBungalow } from '@lostgradient/bungalow';
import { resolveProviderGenerate } from '@lostgradient/bureau';
import { definePlugin } from '@lostgradient/interborough-plugin';
import {
  createActiveRun,
  createAgent,
  createModelCatalog,
  MediaAdmissionError,
  readBackendDescriptors,
  withBackendDescriptors,
  type BackendDescriptor,
} from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, test } from 'bun:test';
import { Conversation, type MediaContent } from 'conversationalist';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

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
  await initializeWorkspaceHome(home);
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
      await bungalow.deploymentSecrets.write(key, value);
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
    ...options,
  });
  hosts.push(host);
  return host;
}

function pairsOf(host: Host): string[] {
  return host.bureau.models
    .catalog()
    .descriptors.filter((row) => row.availability !== 'unavailable')
    .map((row) => `${row.provider}/${row.model}`)
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
        if (found.generate === undefined) throw new Error('Provider has no generate capability.');
        return found.generate(provider, {});
      },
    });

    expect(pairsOf(host)).toEqual(['lender/lender-1']);
    const generate = host.generateFor({ provider: 'lender', model: 'lender-1' });
    expect(await generate({ messages: [] } as never)).toMatchObject({ content: 'lent' });
    expect(handed).toEqual([{ provider: 'lender', model: 'lender-1', apiKey: KEY }]);
  });

  test('sends the secret its secretKey names, not the first one the plugin declares (COR-2142)', async () => {
    const [seed] = staticRows;
    if (seed === undefined) throw new Error('The static catalog is empty.');
    const handed: unknown[] = [];
    const lender = definePlugin({
      name: 'lender',
      version: '1.0.0',
      description: 'Contributes a model provider beside another secret.',
      secrets: ['lender-signing-key', 'lender-api-key'],
      setup: () => ({
        providers: [
          {
            name: 'lender',
            secretKey: 'lender-api-key',
            generate: (configuration: unknown) => {
              handed.push(configuration);
              return async () => ({ content: 'lent', toolCalls: [] });
            },
            stream: () => {
              throw new Error('The fixture provider does not stream.');
            },
            rows: [{ ...seed, provider: 'lender', model: 'lender-1', aliases: [] }],
          },
        ],
      }),
    });
    const home = await prepareHome({
      secrets: { 'lender-signing-key': 'the-signing-value', 'lender-api-key': KEY },
    });
    const host = await startAt(home, {
      plugins: [{ descriptor: lender, source: 'package', location: '@fixture/lender' }],
      resolveProviderGenerate: (definitions, provider) => {
        const found = definitions.find((candidate) => candidate.name === provider.provider);
        if (found?.generate === undefined) throw new Error('No such provider.');
        return found.generate(provider, {});
      },
    });

    await host.generateFor({ provider: 'lender', model: 'lender-1' })({ messages: [] } as never);
    expect(handed).toEqual([{ provider: 'lender', model: 'lender-1', apiKey: KEY }]);
  });

  test('keeps schema defaults and transforms on reload, and rejects invalid stored configuration', async () => {
    const [seed] = staticRows;
    if (seed === undefined) throw new Error('The static catalog is empty.');
    const handed: unknown[] = [];
    const lender = definePlugin({
      name: 'configured-lender',
      version: '1.0.0',
      description: 'Contributes a provider with schema-parsed configuration.',
      configuration: z.object({
        endpoint: z
          .string()
          .default('default')
          .transform((value) => value.toUpperCase()),
      }),
      secrets: ['configured-lender-api-key'],
      setup: () => ({
        providers: [
          {
            name: 'configured-lender',
            generate: (configuration: unknown, pluginConfiguration: unknown) => {
              void configuration;
              handed.push(pluginConfiguration);
              return async () => ({ content: 'lent', toolCalls: [] });
            },
            stream: () => {
              throw new Error('The fixture provider does not stream.');
            },
            rows: [
              { ...seed, provider: 'configured-lender', model: 'configured-lender-1', aliases: [] },
            ],
          },
        ],
      }),
    });
    const home = await prepareHome({ secrets: { 'configured-lender-api-key': KEY } });
    const host = await startAt(home, {
      plugins: [{ descriptor: lender, source: 'package', location: '@fixture/configured-lender' }],
      resolveProviderGenerate: (
        definitions,
        provider,
        streamEventTarget,
        streaming,
        pluginConfiguration,
      ) =>
        resolveProviderGenerate(
          definitions,
          provider,
          streamEventTarget,
          streaming,
          pluginConfiguration,
        ),
    });

    await createAgent({
      name: 'configured-lender-default',
      generate: host.generateFor({ provider: 'configured-lender', model: 'configured-lender-1' }),
    })
      .run('First')
      .result();
    await host.plugins.update('configured-lender', { configuration: { endpoint: 'next' } });
    await createAgent({
      name: 'configured-lender-transformed',
      generate: host.generateFor({ provider: 'configured-lender', model: 'configured-lender-1' }),
    })
      .run('Second')
      .result();
    expect(handed).toEqual([{ endpoint: 'DEFAULT' }, { endpoint: 'NEXT' }]);

    await writeFile(
      join(home, 'configuration.json'),
      JSON.stringify({ plugins: { 'configured-lender': { configuration: { endpoint: 7 } } } }),
    );
    const failure = await host.providers.reload().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProviderConfigurationError);
  });

  test('keeps the rows of a plugin whose secret is not set, unavailable', async () => {
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
    // The row stays, unavailable, so the catalog can tell "needs a key" from "no such model".
    const kept = host.bureau.models
      .catalog()
      .descriptors.filter((row) => row.provider === 'lender');
    expect(kept.map((row) => [row.model, row.availability])).toEqual([['lender-1', 'unavailable']]);
  });
});

describe('media admission reads the catalog row a generate was built from (COR-2146)', () => {
  /** A 3 KiB image: inside the seed row's per-part image limit, over the lowered one below. */
  const image: MediaContent = {
    type: 'image',
    mimeType: 'image/png',
    source: { kind: 'inline', data: 'QUJD'.repeat(1024), encoding: 'base64' },
  };
  const anthropicSeed = staticRows.find((row) => row.provider === 'anthropic');

  /** A plugin whose one row has `mediaLimits`, served by a vendor whose generate is stamped with the seed row. */
  async function startWith(
    mediaLimits: BackendDescriptor['mediaLimits'],
    catalog?: readonly unknown[],
  ) {
    if (anthropicSeed === undefined) throw new Error('The static catalog has no anthropic row.');
    const lender = definePlugin({
      name: 'lender',
      version: '1.0.0',
      description: 'Contributes a model provider whose row states its own media limits.',
      secrets: ['lender-api-key'],
      setup: () => ({
        providers: [
          {
            name: 'lender',
            generate: () => async () => ({ content: 'lent', toolCalls: [] }),
            stream: () => {
              throw new Error('The fixture provider does not stream.');
            },
            rows: [
              { ...anthropicSeed, provider: 'lender', model: 'lender-1', aliases: [], mediaLimits },
            ],
          },
        ],
      }),
    });
    const home = await prepareHome({
      secrets: { 'lender-api-key': KEY },
      ...(catalog === undefined ? {} : { configuration: { catalog } }),
    });
    return startAt(home, {
      plugins: [{ descriptor: lender, source: 'package', location: '@fixture/lender' }],
      // A vendor factory stamps its own static row, as the shipped providers do.
      resolveProviderGenerate: (definitions, provider) => {
        const found = definitions.find((candidate) => candidate.name === provider.provider);
        if (found?.generate === undefined) throw new Error('No such provider.');
        return withBackendDescriptors(found.generate(provider, {}), [anthropicSeed]);
      },
    });
  }

  async function runWithImage(host: Host) {
    const conversation = new Conversation();
    conversation.appendUserMessage([image]);
    return createActiveRun({
      generate: host.generateFor({ provider: 'lender', model: 'lender-1' }),
      toolbox: createToolbox([]),
      conversation,
      stopWhen: () => true,
    }).result;
  }

  test('attaches the row, so a plugin row’s own limit is the one admission reads', async () => {
    const host = await startWith([{ scope: 'per-part', modality: 'image', maxBytes: 1024 }]);
    const generate = host.generateFor({ provider: 'lender', model: 'lender-1' });

    const [attached] = readBackendDescriptors(generate);
    expect(attached).toMatchObject({ provider: 'lender', model: 'lender-1' });
    expect(attached?.mediaLimits).toEqual([
      { scope: 'per-part', modality: 'image', maxBytes: 1024 },
    ]);
    const refused = await runWithImage(host);
    expect(refused.error).toBeInstanceOf(MediaAdmissionError);
  });

  test('admits the same image under a row whose limit is larger', async () => {
    const host = await startWith([
      { scope: 'per-part', modality: 'image', maxBytes: 10 * 1024 * 1024 },
    ]);
    const result = await runWithImage(host);
    expect(result.error).toBeUndefined();
  });

  test('an owner edit lowering an image limit refuses what the row would admit (COR-2413)', async () => {
    const limits: BackendDescriptor['mediaLimits'] = [
      { scope: 'per-part', modality: 'image', maxBytes: 10 * 1024 * 1024 },
    ];
    const admitted = await startWith(limits);
    const admission = await runWithImage(admitted);
    expect(admission.error).toBeUndefined();

    const lowered = await startWith(limits, [
      {
        provider: 'lender',
        model: 'lender-1',
        mediaLimits: [{ scope: 'per-part', modality: 'image', maxBytes: 1024 }],
      },
    ]);
    const [attached] = readBackendDescriptors(
      lowered.generateFor({ provider: 'lender', model: 'lender-1' }),
    );
    expect(attached?.mediaLimits).toEqual([
      { scope: 'per-part', modality: 'image', maxBytes: 1024 },
    ]);
    const refusal = await runWithImage(lowered);
    expect(refusal.error).toBeInstanceOf(MediaAdmissionError);
  });

  test('attaches the row with the owner’s catalog edits applied', async () => {
    const home = await prepareHome({
      configuration: {
        plugins: { openai: { configuration: { models: ['gpt-4.1'] } } },
        catalog: [{ provider: 'openai', model: 'gpt-4.1', contextWindowTokens: 123_456 }],
      },
      secrets: { 'openai-api-key': KEY },
    });
    const host = await startAt(home);
    const [attached] = readBackendDescriptors(
      host.generateFor({ provider: 'openai', model: 'gpt-4.1' }),
    );
    expect(attached?.contextWindowTokens).toBe(123_456);
  });
});

describe('a provider that contributes no rows (COR-2145)', () => {
  test('is listed with a provider-empty problem, and the plugin’s other contributions still load', async () => {
    const lender = definePlugin({
      name: 'lender',
      version: '1.0.0',
      description: 'Contributes a provider with no rows, and a tool.',
      setup: () => ({
        providers: [
          {
            name: 'nowhere',
            generate: () => async () => ({ content: '', toolCalls: [] }),
            stream: () => {
              throw new Error('The fixture provider does not stream.');
            },
          },
        ],
        tools: [createTool({ name: 'lend', description: 'Lends.', execute: async () => 'ok' })],
      }),
    });
    const host = await startAt(await prepareHome({}), {
      plugins: [{ descriptor: lender, source: 'package', location: '@fixture/lender' }],
    });

    const snapshot = await host.plugins.snapshot();
    const listed = snapshot.plugins.find((plugin) => plugin.descriptor.name === 'lender');
    expect(listed?.status).toBe('running');
    expect(listed?.problems).toEqual([{ code: 'provider-empty', provider: 'nowhere' }]);
    expect(listed?.contributions.map(({ kind }) => kind)).toContain('tool');
  });
});

describe('a plugin row with an effort mapping of its own (COR-2150)', () => {
  test('receives the effort of the run’s agent file in the step’s steering', async () => {
    const [seed] = staticRows;
    if (seed === undefined) throw new Error('The static catalog is empty.');
    const efforts: unknown[] = [];
    const lender = definePlugin({
      name: 'lender',
      version: '1.0.0',
      description: 'Contributes a model provider whose row takes an effort no vendor names.',
      secrets: ['lender-api-key'],
      setup: () => ({
        providers: [
          {
            name: 'lender',
            // The provider translates the level of the request to its own parameter.
            generate: () => async (context) => {
              efforts.push(context.steering?.effort);
              return { content: 'lent', toolCalls: [] };
            },
            stream: () => {
              throw new Error('The fixture provider does not stream.');
            },
            rows: [
              {
                ...seed,
                provider: 'lender',
                model: 'lender-1',
                aliases: [],
                effort: {
                  portable: ['high'],
                  nativeMapping: 'native',
                  degradesTo: { high: 'high' },
                },
              },
            ],
          },
        ],
      }),
    });
    const home = await prepareHome({
      secrets: { 'lender-api-key': KEY },
      agents: {
        'thinker.md': [
          '---',
          'name: thinker',
          'description: An agent.',
          'model: lender/lender-1',
          'effort: high',
          '---',
          'Think.',
          '',
        ].join('\n'),
      },
    });
    const host = await startAt(home, {
      plugins: [{ descriptor: lender, source: 'package', location: '@fixture/lender' }],
    });
    expect(host.bureau.agents.list().find((entry) => entry.id === 'thinker')).toMatchObject({
      state: 'ready',
    });

    const task = await host.bureau.tasks.start('thinker', 'Go');
    const result = await task.result();

    expect(result.content).toBe('lent');
    expect(efforts).toEqual(['high']);
  });
});

describe('a keyless provider (COR-2144)', () => {
  /** A provider fixture whose plugin declares `secrets`, recording every configuration it is handed. */
  function lenderPlugin(name: string, secrets: readonly string[], handed: unknown[]) {
    const [seed] = staticRows;
    if (seed === undefined) throw new Error('The static catalog is empty.');
    return definePlugin({
      name,
      version: '1.0.0',
      description: 'Contributes a model provider.',
      ...(secrets.length === 0 ? {} : { secrets }),
      setup: () => ({
        providers: [
          {
            name,
            generate: (configuration: unknown) => {
              handed.push(configuration);
              return async () => ({ content: 'lent', toolCalls: [] });
            },
            stream: () => {
              throw new Error('The fixture provider does not stream.');
            },
            rows: [{ ...seed, provider: name, model: `${name}-1`, aliases: [] }],
          },
        ],
      }),
    });
  }

  const passThrough: typeof resolveProviderGenerate = (definitions, provider) => {
    const found = definitions.find((candidate) => candidate.name === provider.provider);
    if (found?.generate === undefined) throw new Error('No such provider.');
    return found.generate(provider, {});
  };

  test('offers its rows as available and calls its definition with apiKey omitted', async () => {
    const handed: unknown[] = [];
    const local = lenderPlugin('local-lender', [], handed);
    const host = await startAt(await prepareHome({}), {
      plugins: [{ descriptor: local, source: 'package', location: '@fixture/local-lender' }],
      resolveProviderGenerate: passThrough,
    });

    expect(pairsOf(host)).toEqual(['local-lender/local-lender-1']);
    const [row] = host.bureau.models.catalog().descriptors;
    expect(row?.availability).not.toBe('unavailable');
    const generate = host.generateFor({ provider: 'local-lender', model: 'local-lender-1' });
    expect(await generate({ messages: [] } as never)).toMatchObject({ content: 'lent' });
    expect(handed).toEqual([{ provider: 'local-lender', model: 'local-lender-1' }]);
    expect(Object.hasOwn(handed[0] as object, 'apiKey')).toBe(false);
  });

  test('is not the case of a plugin that declares a secret and has none saved, which stays unavailable', async () => {
    const handed: unknown[] = [];
    const keyed = lenderPlugin('keyed-lender', ['keyed-lender-api-key'], handed);
    const host = await startAt(await prepareHome({}), {
      plugins: [{ descriptor: keyed, source: 'package', location: '@fixture/keyed-lender' }],
      resolveProviderGenerate: passThrough,
    });

    expect(pairsOf(host)).toEqual([]);
    expect(
      host.bureau.models
        .catalog()
        .descriptors.filter((row) => row.provider === 'keyed-lender')
        .map((row) => row.availability),
    ).toEqual(['unavailable']);
    expect(() => host.generateFor({ provider: 'keyed-lender', model: 'keyed-lender-1' })).toThrow(
      /save the secret "keyed-lender-api-key"/,
    );
    expect(handed).toEqual([]);
  });
});

describe('the providers the workspace ships', () => {
  test('declare exactly the four keys the host has always used, and the demo plugin one of its own', () => {
    // The inspectors plugin ships panels, not a provider, and declares no secret.
    expect(
      workspacePlugins()
        .filter(({ descriptor }) => descriptor.secrets !== undefined)
        .map(({ descriptor }) => [descriptor.name, descriptor.secrets]),
    ).toEqual([
      ['anthropic', ['anthropic-api-key']],
      ['openai', ['openai-api-key']],
      ['gemini', ['gemini-api-key']],
      ['typesafe', ['typesafe-api-key']],
      ['demo', [{ key: 'demo-approval-secret', generated: true }]],
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
  test('is invalid with unknown-model, the label for a disabled provider, when only anthropic is enabled', async () => {
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

describe('an agent on a model of a provider whose key is not saved (COR-2143)', () => {
  test('is invalid naming the secret to save, and is ready once the key is saved with no restart', async () => {
    const home = await prepareHome({
      agents: {
        'needs-key.md': [
          '---',
          'name: needs-key',
          'description: An agent.',
          'model: openai/gpt-4.1',
          '---',
          'Help.',
          '',
        ].join('\n'),
      },
    });
    const host = await startAt(home);
    const listing = () => host.bureau.agents.list().find((entry) => entry.id === 'needs-key');

    expect(listing()).toMatchObject({ state: 'invalid', problem: { code: 'unknown-model' } });
    expect(JSON.stringify(listing())).toContain('openai-api-key');
    expect(JSON.stringify(listing())).not.toContain('not in the deployment');

    await host.plugins.saveSecret('openai', 'openai-api-key', KEY);

    expect(listing()).toMatchObject({ state: 'ready' });
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
      secretBindings: { 'openai-api-key': expect.any(String) },
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

  test('uses the updated endpoint on the next model call after a live plugin update', async () => {
    const responseBody = {
      id: 'chatcmpl_reload_test',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-4.1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const requests: string[] = [];
    const serverA = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch() {
        requests.push('A');
        return Response.json(responseBody);
      },
    });
    const serverB = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch() {
        requests.push('B');
        return Response.json(responseBody);
      },
    });
    try {
      const home = await prepareHome({
        configuration: {
          plugins: { openai: { configuration: { baseURL: `http://127.0.0.1:${serverA.port}` } } },
        },
        secrets: { 'openai-api-key': KEY },
      });
      const host = await startAt(home);
      await createAgent({
        name: 'reload-a',
        generate: host.generateFor({ provider: 'openai', model: 'gpt-4.1' }),
      })
        .run('First')
        .result();

      await host.plugins.update('openai', {
        configuration: { baseURL: `http://127.0.0.1:${serverB.port}` },
      });
      await createAgent({
        name: 'reload-b',
        generate: host.generateFor({ provider: 'openai', model: 'gpt-4.1' }),
      })
        .run('Second')
        .result();

      expect(requests).toEqual(['A', 'B']);
    } finally {
      serverA.stop();
      serverB.stop();
    }
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

describe('a stored allowlist that names a model the provider does not offer', () => {
  const rowOf = async (host: Host, name: string) => {
    const snapshot = await host.plugins.snapshot();
    return snapshot.plugins.find((plugin) => plugin.descriptor.name === name);
  };

  test('skips the plugin with configuration-invalid at startup and starts, and the route fixes it', async () => {
    const home = await prepareHome({
      configuration: { plugins: { openai: { enabled: false } } },
      secrets: { 'openai-api-key': KEY },
    });
    const first = await startAt(home);
    // Disabled, the plugin is not loaded, so the route cannot check its models: both calls succeed.
    await first.plugins.update('openai', { configuration: { models: ['gpt-nonexistent'] } });
    await first.plugins.update('openai', { enabled: true });
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);

    const second = await startAt(home);

    expect(await rowOf(second, 'openai')).toMatchObject({
      status: 'skipped',
      problems: [{ code: 'configuration-invalid', field: 'models[0]' }],
    });
    const skipped = await rowOf(second, 'openai');
    // The message never repeats the entry, which may be a secret.
    expect(JSON.stringify(skipped?.problems)).not.toContain('gpt-nonexistent');
    expect(pairsOf(second).filter((pair) => pair.startsWith('openai/'))).toEqual([]);

    await second.plugins.update('openai', { configuration: { models: ['gpt-4.1'] } });
    await second.close();
    hosts.splice(hosts.indexOf(second), 1);

    const third = await startAt(home);
    expect(await rowOf(third, 'openai')).toMatchObject({ status: 'running' });
    expect(pairsOf(third).filter((pair) => pair.startsWith('openai/'))).toEqual(['openai/gpt-4.1']);
  });

  test('still starts a plugin whose allowlist names a row the catalog edits add', async () => {
    const home = await prepareHome({
      configuration: {
        catalog: [{ provider: 'openai', model: 'gpt-next', basedOn: 'gpt-4.1' }],
        plugins: { openai: { configuration: { models: ['gpt-next'] } } },
      },
      secrets: { 'openai-api-key': KEY },
    });
    const host = await startAt(home);
    expect(await rowOf(host, 'openai')).toMatchObject({ status: 'running' });
    expect(pairsOf(host).filter((pair) => pair.startsWith('openai/'))).toEqual(['openai/gpt-next']);
  });
});

describe('an allowlist written while the catalog edits change', () => {
  const addsRow = { provider: 'openai', model: 'gpt-next', basedOn: 'gpt-4.1' };

  async function openHome() {
    const home = await prepareHome({
      configuration: { catalog: [addsRow] },
      secrets: { 'openai-api-key': KEY },
    });
    return { home, host: await startAt(home) };
  }

  async function restartsCleanly(home: string, host: Host): Promise<void> {
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    await startAt(home);
  }

  test('is refused when the edit that removes its model lands first, and nothing invalid is stored', async () => {
    const { home, host } = await openHome();

    // The edit is queued before the allowlist's write, as the plugin route's old separate check
    // let it be: the write must be judged against the document the edit left.
    const edit = host.providers.editCatalog([]);
    const write = host.plugins.update('openai', { configuration: { models: ['gpt-next'] } });
    const [edited, written] = await Promise.allSettled([edit, write]);

    expect(edited.status).toBe('fulfilled');
    expect(written.status).toBe('rejected');
    expect((written as PromiseRejectedResult).reason).toBeInstanceOf(ProviderConfigurationError);
    expect(await readFile(join(home, 'configuration.json'), 'utf8')).not.toContain('gpt-next');
    await restartsCleanly(home, host);
  });

  test('refuses the edit that would remove the model, when the allowlist is written first', async () => {
    const { home, host } = await openHome();

    const [written, edited] = await Promise.allSettled([
      host.plugins.update('openai', { configuration: { models: ['gpt-next'] } }),
      host.providers.editCatalog([]),
    ]);

    expect(written.status).toBe('fulfilled');
    expect(edited.status).toBe('rejected');
    await restartsCleanly(home, host);
  });
});
