/**
 * COR-1901: a local host writes the provider configuration and a provider's key, and reloads the
 * catalog without a restart. The provider path runs against a fake client, and every key is a
 * fixture; none is a credential for anything.
 */
import { openBungalow } from '@lostgradient/bungalow';
import { resolveProviderGenerate, type ProviderConfiguration } from '@lostgradient/bureau';
import { createAgent } from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';
import { ProviderConfigurationError } from './provider-configuration-error.ts';
import { ProviderInputError } from './provider-manager.ts';

const KEY_A = 'fixture-key-a-1f3c9d';
const KEY_B = 'fixture-key-b-8e27a4';
const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const agentFile = [
  '---',
  'name: Researcher',
  'description: A file agent.',
  'model: anthropic/sonnet',
  '---',
  'You are a careful researcher.',
  '',
].join('\n');

async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'interborough-provider-changes-'));
  directories.push(directory);
  return directory;
}

/** Stores a provider key in a home no host holds. */
async function storeKey(directory: string, name: string, key: string): Promise<void> {
  const bungalow = await openBungalow({
    name: 'interborough',
    environment: { INTERBOROUGH_HOME: directory },
  });
  try {
    bungalow.writeSecret(name, key);
  } finally {
    bungalow.close();
  }
}

/** A resolver whose fake client records which key each request was made with, by name. */
function recordingResolver() {
  const handed: string[] = [];
  const requests: string[] = [];
  const resolver: typeof resolveProviderGenerate = (
    definitions,
    provider: ProviderConfiguration,
    streamEventTarget,
    streaming,
  ) => {
    const label = provider.apiKey === KEY_A ? 'A' : provider.apiKey === KEY_B ? 'B' : 'other';
    handed.push(label);
    const client = {
      messages: {
        create: async () => {
          requests.push(label);
          return {
            id: 'message-1',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5',
            content: [{ type: 'text', text: 'Answered.' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 3, output_tokens: 5 },
          };
        },
      },
    };
    return resolveProviderGenerate(
      definitions,
      Object.assign({}, provider, { client }),
      streamEventTarget,
      streaming,
    );
  };
  return { handed, requests, resolver };
}

async function startAt(directory: string, options: Parameters<typeof startHost>[0] = {}) {
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: directory },
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

function rowOf(host: Host, model: string) {
  return host.bureau.models.catalog().descriptors.find((row) => row.model === model);
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('connecting a provider', () => {
  test('stores a 0600 key, lists the provider, offers its models at once, and survives a restart', async () => {
    const directory = await home();
    const host = await startAt(directory);
    expect(pairsOf(host)).toEqual([]);
    const before = host.bureau.models.catalog().revision;

    const change = await host.providers.connect({
      provider: 'anthropic',
      apiKey: `  ${KEY_A}\n`,
      models: ['sonnet'],
    });

    expect(pairsOf(host)).toEqual(['anthropic/claude-sonnet-5']);
    expect(change.catalogRevision).toBe(before + 1);
    expect(change.providers).toEqual([{ name: 'anthropic', models: ['claude-sonnet-5'] }]);
    const secret = join(directory, 'secrets', 'anthropic-api-key');
    expect(statSync(secret).mode & 0o777).toBe(0o600);
    expect(await readFile(secret, 'utf8')).toBe(KEY_A);
    expect(JSON.parse(await readFile(join(directory, 'configuration.json'), 'utf8'))).toEqual({
      providers: { anthropic: { models: ['sonnet'] } },
    });
    expect(statSync(join(directory, 'configuration.json')).mode & 0o777).toBe(0o600);
    expect(host.generateFor({ provider: 'anthropic', model: 'sonnet' })).toBeFunction();

    await host.close();
    const restarted = await startAt(directory);
    expect(pairsOf(restarted)).toEqual(['anthropic/claude-sonnet-5']);
  });

  test('keeps the keys of the other providers and the file’s other keys, and an allowlist it was not given', async () => {
    const directory = await home();
    await writeFile(
      join(directory, 'configuration.json'),
      JSON.stringify({ note: 'mine', providers: { anthropic: { models: ['sonnet'] } } }),
    );
    await storeKey(directory, 'anthropic-api-key', KEY_A);
    const host = await startAt(directory);

    await host.providers.connect({ provider: 'openai', apiKey: KEY_B });
    await host.providers.connect({ provider: 'anthropic', apiKey: KEY_B });

    const written = JSON.parse(await readFile(join(directory, 'configuration.json'), 'utf8'));
    expect(written).toEqual({
      note: 'mine',
      providers: { anthropic: { models: ['sonnet'] }, openai: {} },
    });
    expect(await readFile(join(directory, 'secrets', 'anthropic-api-key'), 'utf8')).toBe(KEY_B);
    expect(pairsOf(host)).toContain('anthropic/claude-sonnet-5');
    expect(pairsOf(host).some((pair) => pair.startsWith('openai/'))).toBe(true);

    await host.providers.connect({ provider: 'anthropic', apiKey: KEY_B, models: null });
    expect(pairsOf(host).filter((pair) => pair.startsWith('anthropic/')).length).toBeGreaterThan(1);
  });

  test('uses the request as it was when it was made, not as the caller changes it while it waits', async () => {
    const directory = await home();
    const host = await startAt(directory);
    const models = ['sonnet'];

    const pending = host.providers.connect({ provider: 'anthropic', apiKey: KEY_A, models });
    models.push('no-such-model');
    await pending;

    expect(JSON.parse(await readFile(join(directory, 'configuration.json'), 'utf8'))).toEqual({
      providers: { anthropic: { models: ['sonnet'] } },
    });
  });

  test('names the field and never the key when the request cannot be used, and writes nothing', async () => {
    const directory = await home();
    const warnings: string[] = [];
    const host = await startAt(directory, { warn: (message) => warnings.push(message) });

    const unknownModel = await failureOf(
      host.providers.connect({ provider: 'anthropic', apiKey: KEY_A, models: ['no-such-model'] }),
    );
    expect(unknownModel).toBeInstanceOf(ProviderConfigurationError);
    expect(String(unknownModel)).toContain('providers.anthropic.models[0]');

    const unknownProvider = await failureOf(
      host.providers.connect({ provider: 'voyage', apiKey: KEY_A }),
    );
    expect(unknownProvider).toBeInstanceOf(ProviderInputError);
    expect(String(unknownProvider)).toContain('provider');

    for (const apiKey of ['', '   ', `${KEY_A}\nsecond line`, 42, undefined, 'x'.repeat(5000)]) {
      const failure = await failureOf(host.providers.connect({ provider: 'openai', apiKey }));
      expect(failure).toBeInstanceOf(ProviderInputError);
      expect((failure as ProviderInputError).field).toBe('apiKey');
    }

    const everything = [
      String(unknownModel),
      String(unknownProvider),
      JSON.stringify(unknownModel),
      ...warnings,
    ].join('\n');
    expect(everything.includes(KEY_A)).toBe(false);
    // A refused request leaves nothing on disk.
    expect(existsSync(join(directory, 'configuration.json'))).toBe(false);
    expect(existsSync(join(directory, 'secrets', 'anthropic-api-key'))).toBe(false);
    expect(existsSync(join(directory, 'secrets', 'openai-api-key'))).toBe(false);
  });

  test('refuses to write over a configuration that is already invalid, and says which field', async () => {
    const directory = await home();
    const host = await startAt(directory);
    await writeFile(join(directory, 'configuration.json'), '{"providers":{"voyage":{}}}');

    const failure = await failureOf(host.providers.connect({ provider: 'openai', apiKey: KEY_A }));

    expect(failure).toBeInstanceOf(ProviderConfigurationError);
    expect(String(failure)).toContain('providers.voyage');
    expect(await readFile(join(directory, 'configuration.json'), 'utf8')).toBe(
      '{"providers":{"voyage":{}}}',
    );
    expect(existsSync(join(directory, 'secrets', 'openai-api-key'))).toBe(false);
  });

  test('never reports a key: not in the change, the snapshot, the diagnostics, or a warning', async () => {
    const directory = await home();
    const warnings: string[] = [];
    const host = await startAt(directory, { warn: (message) => warnings.push(message) });

    const change = await host.providers.connect({ provider: 'anthropic', apiKey: KEY_A });
    const snapshot = await host.providers.snapshot();

    expect(snapshot.providers.find((entry) => entry.name === 'anthropic')).toEqual({
      name: 'anthropic',
      configured: true,
      hasKey: true,
    });
    const everything = JSON.stringify([change, snapshot, host.diagnostics().providers, warnings]);
    expect(everything.includes(KEY_A)).toBe(false);
  });
});

describe('a key that changes under running work', () => {
  test('a generate resolved before the change keeps its key, and one resolved after uses the new one', async () => {
    const directory = await home();
    await writeFile(
      join(directory, 'configuration.json'),
      JSON.stringify({ providers: { anthropic: { models: ['sonnet'] } } }),
    );
    await storeKey(directory, 'anthropic-api-key', KEY_A);
    const { requests, resolver } = recordingResolver();
    const host = await startAt(directory, { resolveProviderGenerate: resolver });
    const started = host.generateFor({ provider: 'anthropic', model: 'sonnet' });

    await host.providers.connect({ provider: 'anthropic', apiKey: KEY_B });
    const later = host.generateFor({ provider: 'anthropic', model: 'sonnet' });

    await createAgent({ name: 'started-before', generate: started }).run('Hello').result();
    await createAgent({ name: 'started-after', generate: later }).run('Hello').result();
    expect(requests).toEqual(['A', 'B']);
  });

  test('a file agent runs with the new key from the first run after the change', async () => {
    const directory = await home();
    await writeFile(
      join(directory, 'configuration.json'),
      JSON.stringify({ providers: { anthropic: { models: ['sonnet'] } } }),
    );
    await storeKey(directory, 'anthropic-api-key', KEY_A);
    await mkdir(join(directory, 'agents'), { recursive: true });
    await writeFile(join(directory, 'agents', 'researcher.md'), agentFile);
    const { requests, resolver } = recordingResolver();
    const host = await startAt(directory, { resolveProviderGenerate: resolver });

    const first = await host.bureau.tasks.start('researcher', 'First');
    await first.result();
    await host.providers.connect({ provider: 'anthropic', apiKey: KEY_B });
    const second = await host.bureau.tasks.start('researcher', 'Second');
    await second.result();

    expect(requests).toEqual(['A', 'B']);
  });

  test('a run in flight finishes with the provider it started with', async () => {
    const directory = await home();
    await writeFile(
      join(directory, 'configuration.json'),
      JSON.stringify({ providers: { anthropic: { models: ['sonnet'] } } }),
    );
    await storeKey(directory, 'anthropic-api-key', KEY_A);
    await mkdir(join(directory, 'agents'), { recursive: true });
    await writeFile(join(directory, 'agents', 'researcher.md'), agentFile);
    const requests: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolver: typeof resolveProviderGenerate = (
      definitions,
      provider,
      streamEventTarget,
      streaming,
    ) => {
      const label = provider.apiKey === KEY_A ? 'A' : 'B';
      const client = {
        messages: {
          create: async () => {
            requests.push(`${label} started`);
            // The first request holds here until the test has changed the key.
            if (label === 'A') await gate;
            requests.push(`${label} finished`);
            return {
              id: 'message-1',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-5',
              content: [{ type: 'text', text: 'Answered.' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 3, output_tokens: 5 },
            };
          },
        },
      };
      return resolveProviderGenerate(
        definitions,
        Object.assign({}, provider, { client }),
        streamEventTarget,
        streaming,
      );
    };
    const host = await startAt(directory, { resolveProviderGenerate: resolver });

    const inFlight = await host.bureau.tasks.start('researcher', 'Long');
    await waitUntil(() => requests.includes('A started'));
    await host.providers.connect({ provider: 'anthropic', apiKey: KEY_B });
    const newRun = await host.bureau.tasks.start('researcher', 'New');
    await newRun.result();
    expect(requests).toEqual(['A started', 'B started', 'B finished']);

    release();
    await inFlight.result();
    expect(requests).toEqual(['A started', 'B started', 'B finished', 'A finished']);
  });
});

describe('catalog edits', () => {
  async function startWithAnthropic() {
    const directory = await home();
    await writeFile(
      join(directory, 'configuration.json'),
      JSON.stringify({ providers: { anthropic: {} } }),
    );
    await storeKey(directory, 'anthropic-api-key', KEY_A);
    return { directory, host: await startAt(directory) };
  }

  test('turn a model off, change its price and limits, and add a row, live and across a restart', async () => {
    const { directory, host } = await startWithAnthropic();
    const original = rowOf(host, 'claude-sonnet-5');
    expect(original).toBeDefined();
    const revision = host.bureau.models.catalog().revision;

    const change = await host.providers.editCatalog([
      { provider: 'anthropic', model: 'haiku', off: true },
      {
        provider: 'anthropic',
        model: 'sonnet',
        pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 2, currency: 'USD' },
        contextWindowTokens: 100_000,
        maxOutputTokens: 8_000,
      },
      { provider: 'anthropic', model: 'claude-next', basedOn: 'sonnet', maxOutputTokens: 4_000 },
    ]);

    expect(change.catalogRevision).toBe(revision + 1);
    const check = (target: Host) => {
      expect(rowOf(target, 'claude-haiku-4-5')?.availability).toBe('unavailable');
      expect(rowOf(target, 'claude-sonnet-5')).toMatchObject({
        availability: original?.availability,
        pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 2, currency: 'USD' },
        contextWindowTokens: 100_000,
        maxOutputTokens: 8_000,
      });
      expect(rowOf(target, 'claude-next')).toMatchObject({
        provider: 'anthropic',
        aliases: [],
        contextWindowTokens: original?.contextWindowTokens,
        maxOutputTokens: 4_000,
      });
    };
    check(host);
    // A model that is off is kept from agents, but stays listed so it can be turned back on.
    expect(() => host.generateFor({ provider: 'anthropic', model: 'haiku' })).toThrow('turned off');
    expect(host.generateFor({ provider: 'anthropic', model: 'claude-next' })).toBeFunction();

    await host.close();
    check(await startAt(directory));
  });

  test('an empty list removes the edits and restores the built-in rows', async () => {
    const { directory, host } = await startWithAnthropic();
    const original = rowOf(host, 'claude-haiku-4-5');
    await host.providers.editCatalog([{ provider: 'anthropic', model: 'haiku', off: true }]);
    expect(rowOf(host, 'claude-haiku-4-5')?.availability).toBe('unavailable');

    await host.providers.editCatalog([]);

    expect(rowOf(host, 'claude-haiku-4-5')?.availability).toBe(original?.availability);
    expect(JSON.parse(await readFile(join(directory, 'configuration.json'), 'utf8'))).toEqual({
      providers: { anthropic: {} },
    });
  });

  test('refuse an edit that cannot apply, naming the field, and leave the file as it was', async () => {
    const { directory, host } = await startWithAnthropic();
    const before = await readFile(join(directory, 'configuration.json'), 'utf8');

    const cases: readonly [unknown, string][] = [
      [[{ provider: 'anthropic', model: 'claude-unheard-of' }], 'catalog[0].model'],
      [[{ provider: 'anthropic', model: 'x', basedOn: 'claude-unheard-of' }], 'catalog[0].basedOn'],
      [
        [{ provider: 'anthropic', model: 'haiku', pricing: { currency: 'USD' } }],
        'catalog[0].pricing.inputPerMillionTokens',
      ],
      [
        [{ provider: 'anthropic', model: 'haiku', contextWindowTokens: 10, maxOutputTokens: 20 }],
        'catalog[0].maxOutputTokens',
      ],
      [[{ provider: 'anthropic', model: 'haiku', basedOn: 'sonnet' }], 'catalog[0].basedOn'],
      [[{ provider: 'voyage', model: 'haiku' }], 'catalog[0].provider'],
      [[{ provider: 'anthropic', model: 'haiku', colour: 'red' }], 'catalog[0].colour'],
      [
        [
          { provider: 'anthropic', model: 'haiku', off: true },
          { provider: 'anthropic', model: 'haiku', off: false },
        ],
        'catalog[1].model',
      ],
      ['not a list', 'catalog'],
    ];
    for (const [edits, field] of cases) {
      const failure = await failureOf(host.providers.editCatalog(edits));
      expect(failure).toBeInstanceOf(ProviderConfigurationError);
      expect((failure as ProviderConfigurationError).field).toBe(field);
    }
    expect(await readFile(join(directory, 'configuration.json'), 'utf8')).toBe(before);
    expect(rowOf(host, 'claude-haiku-4-5')?.availability).not.toBe('unavailable');
  });
});

describe('reloading', () => {
  test('applies a configuration and a key a person put on disk by hand', async () => {
    const directory = await home();
    const host = await startAt(directory);
    expect(pairsOf(host)).toEqual([]);

    await writeFile(
      join(directory, 'configuration.json'),
      JSON.stringify({ providers: { anthropic: { models: ['sonnet'] } } }),
    );
    await writeFile(join(directory, 'secrets', 'anthropic-api-key'), KEY_A, { mode: 0o600 });
    const change = await host.providers.reload();

    expect(pairsOf(host)).toEqual(['anthropic/claude-sonnet-5']);
    expect(change.providers).toEqual([{ name: 'anthropic', models: ['claude-sonnet-5'] }]);
  });

  test('keeps the previous providers when the file on disk is not valid', async () => {
    const directory = await home();
    await writeFile(
      join(directory, 'configuration.json'),
      JSON.stringify({ providers: { anthropic: { models: ['sonnet'] } } }),
    );
    await storeKey(directory, 'anthropic-api-key', KEY_A);
    const host = await startAt(directory);
    await writeFile(join(directory, 'configuration.json'), '{ not json');

    const failure = await failureOf(host.providers.reload());

    expect(failure).toBeInstanceOf(ProviderConfigurationError);
    expect(pairsOf(host)).toEqual(['anthropic/claude-sonnet-5']);
  });
});

describe('the provider routes', () => {
  async function send(host: Host, method: string, path: string, body?: unknown, headers = {}) {
    return fetch(new URL(path, host.url), {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
  }

  test('connect a provider, report it without its key, edit the catalog, and reload', async () => {
    const directory = await home();
    const host = await startAt(directory);

    const connected = await send(host, 'PUT', '/host/providers/anthropic', {
      apiKey: KEY_A,
      models: ['sonnet'],
    });
    expect(connected.status).toBe(200);
    expect(pairsOf(host)).toEqual(['anthropic/claude-sonnet-5']);

    const report = await send(host, 'GET', '/host/providers');
    const text = await report.text();
    expect(report.status).toBe(200);
    expect(text.includes(KEY_A)).toBe(false);
    expect(JSON.parse(text)).toMatchObject({
      providers: expect.arrayContaining([
        { name: 'anthropic', configured: true, hasKey: true, models: ['sonnet'] },
      ]),
      catalog: [],
    });

    const edited = await send(host, 'PUT', '/host/catalog', {
      edits: [{ provider: 'anthropic', model: 'sonnet', off: true }],
    });
    expect(edited.status).toBe(200);
    expect(rowOf(host, 'claude-sonnet-5')?.availability).toBe('unavailable');

    const reloaded = await send(host, 'POST', '/host/providers/reload');
    expect(reloaded.status).toBe(200);
  });

  test('answer 400 naming the field, and never echo the key', async () => {
    const host = await startAt(await home());

    const unknownProvider = await send(host, 'PUT', '/host/providers/voyage', { apiKey: KEY_A });
    const noKey = await send(host, 'PUT', '/host/providers/openai', {
      apiKey: `${KEY_A}\n${KEY_A}`,
    });
    const notJson = await send(host, 'PUT', '/host/providers/openai', `{ ${KEY_A}`);
    const badModels = await send(host, 'PUT', '/host/providers/openai', {
      apiKey: KEY_A,
      models: ['gpt-nonexistent'],
    });

    const bodies = [];
    for (const response of [unknownProvider, noKey, notJson, badModels]) {
      expect(response.status).toBe(400);
      bodies.push(await response.text());
    }
    expect(bodies.map((body) => JSON.parse(body).field)).toEqual([
      'provider',
      'apiKey',
      'body',
      'providers.openai.models[0]',
    ]);
    expect(bodies.join('\n').includes(KEY_A)).toBe(false);
  });

  test('refuse a request from another origin before reading it', async () => {
    const directory = await home();
    const host = await startAt(directory);

    const response = await send(
      host,
      'PUT',
      '/host/providers/anthropic',
      { apiKey: KEY_A },
      { origin: 'http://evil.example' },
    );

    expect(response.status).toBe(403);
    expect(existsSync(join(directory, 'secrets', 'anthropic-api-key'))).toBe(false);
  });
});
