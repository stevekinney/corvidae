import { createModelCatalog, type BackendDescriptor } from '@lostgradient/operative';
import { anthropicProvider } from '@lostgradient/operative-anthropic';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderConfigurationError } from './provider-configuration-error.ts';
import { contributedFixtures } from './provider-fixtures.test-support.ts';
import {
  createCatalogGenerate,
  loadProviders,
  parseDocument,
  parseProviderConfiguration,
  readAllowlists,
  selectCatalogRows,
  type ContributedProvider,
  type ProviderConfigurationFile,
} from './providers.ts';

const PATH = '/home/interborough/configuration.json';
const STATIC_ROWS = createModelCatalog().descriptors;
const contributed = contributedFixtures;

const ALL = new Set(['anthropic', 'openai', 'gemini']);
const NONE: ReadonlyMap<string, readonly string[]> = new Map();

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'interborough-providers-'));
  directories.push(directory);
  return directory;
}

/**
 * What Bungalow's `readConfiguration()` supplies for a local file: its text, or `undefined` when it
 * is absent. Anything else (a directory, a permission error) rejects.
 */
function fileReader(path: string): {
  readonly location: string;
  readonly configurationLocation: string;
  readonly read: () => Promise<string | undefined>;
  readonly readConfiguration: () => Promise<string | undefined>;
} {
  const read = async (): Promise<string | undefined> => {
    try {
      return await Bun.file(path).text();
    } catch (error) {
      if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  };
  return { location: path, configurationLocation: path, read, readConfiguration: read };
}

function failureOf(run: () => unknown): ProviderConfigurationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderConfigurationError);
    return error as ProviderConfigurationError;
  }
  throw new Error('Expected the configuration to be refused.');
}

function pairs(rows: readonly BackendDescriptor[]): string[] {
  return rows.map((row) => `${row.provider}/${row.model}`).toSorted();
}

describe('the configuration shape', () => {
  test('reads the catalog edits, and leaves them out when there are none', () => {
    const edit = { provider: 'openai', model: 'gpt-4.1', off: true };
    expect(parseProviderConfiguration(JSON.stringify({ catalog: [edit] }), PATH)).toEqual({
      catalog: [edit],
    });
    expect(parseProviderConfiguration('{"catalog":[]}', PATH)).toEqual({ catalog: [] });
    expect(Object.hasOwn(parseProviderConfiguration('{}', PATH), 'catalog')).toBe(false);
  });

  test('ignores every other key, a top-level providers key among them', () => {
    expect(
      parseProviderConfiguration(
        JSON.stringify({ somethingElse: { nested: true }, providers: { voyage: 1 }, version: 2 }),
        PATH,
      ),
    ).toEqual({});
  });

  test('refuses an edit that names a provider outside the names it was given, and only then', () => {
    const text = JSON.stringify({ catalog: [{ provider: 'voyage', model: 'x', off: true }] });
    const failure = failureOf(() => parseProviderConfiguration(text, PATH, ['anthropic']));
    expect(failure.message).toContain(PATH);
    expect(failure.message).toContain('catalog[0].provider');
    expect(parseProviderConfiguration(text, PATH)).toEqual({
      catalog: [{ provider: 'voyage', model: 'x', off: true }],
    });
  });

  test('refuses malformed JSON, naming the file', () => {
    const failure = failureOf(() => parseProviderConfiguration('{ "catalog": ', PATH));
    expect(failure.message).toContain(PATH);
    expect(failure.message).toContain('JSON');
  });

  test('refuses a file that is not an object, naming the field', () => {
    for (const text of ['[]', 'null']) {
      const failure = failureOf(() => parseProviderConfiguration(text, PATH));
      expect(failure.message, text).toContain(PATH);
      expect(failure.message, text).toContain('the file');
    }
  });

  test('a missing file is an empty document, not an error', () => {
    expect(parseDocument(undefined, PATH)).toEqual({});
  });
});

describe('the allowlists', () => {
  test('are the models of each named plugin’s configuration', () => {
    const document = {
      plugins: {
        anthropic: { configuration: { models: ['sonnet'] } },
        openai: { enabled: true },
        gemini: { configuration: {} },
        voyage: { configuration: { models: [1] } },
      },
    };
    expect(readAllowlists(document, PATH, ['anthropic', 'openai', 'gemini'])).toEqual(
      new Map([['anthropic', ['sonnet']]]),
    );
  });

  test('ignore a plugin entry that is not an object, and a document with no plugins', () => {
    expect(readAllowlists({ plugins: [] }, PATH, ['openai'])).toEqual(NONE);
    expect(readAllowlists({ plugins: { openai: 3 } }, PATH, ['openai'])).toEqual(NONE);
    expect(readAllowlists({}, PATH, ['openai'])).toEqual(NONE);
  });

  test('never answer from an inherited key', () => {
    expect(readAllowlists({ plugins: {} }, PATH, ['constructor', 'toString'])).toEqual(NONE);
  });

  test('refuse a models value that is not a non-empty list of non-empty strings, naming the field', () => {
    for (const [models, field] of [
      ['"gpt-4.1"', 'plugins.openai.configuration.models'],
      ['[]', 'plugins.openai.configuration.models'],
      ['[1]', 'plugins.openai.configuration.models[0]'],
      ['["gpt-4.1",""]', 'plugins.openai.configuration.models[1]'],
    ] as const) {
      const failure = failureOf(() =>
        readAllowlists(
          { plugins: { openai: { configuration: { models: JSON.parse(models) as unknown } } } },
          PATH,
          ['openai'],
        ),
      );
      expect(failure.message, models).toContain(PATH);
      expect(failure.message, models).toContain(field);
    }
  });
});

describe('the catalog rows', () => {
  const select = (input: {
    readonly configuration?: ProviderConfigurationFile;
    readonly allowlists?: ReadonlyMap<string, readonly string[]>;
    readonly available?: ReadonlySet<string>;
    readonly providers?: readonly ContributedProvider[];
  }) =>
    selectCatalogRows({
      configuration: input.configuration ?? {},
      allowlists: input.allowlists ?? NONE,
      path: PATH,
      available: input.available ?? ALL,
      providers: input.providers ?? contributed(),
    });
  const allow = (plugin: string, ...models: string[]) => new Map([[plugin, models]]);

  test('apply an edit only to a provider that has a key, but check the edit either way', () => {
    const off = { catalog: [{ provider: 'openai', model: 'gpt-4.1', off: true }] };
    const withKey = select({ configuration: off });
    expect(withKey.find((row) => row.model === 'gpt-4.1')?.availability).toBe('unavailable');
    expect(
      select({ configuration: off, available: new Set(['anthropic']) }).some(
        (row) => row.provider === 'openai',
      ),
    ).toBe(false);
    const stale = failureOf(() =>
      select({
        configuration: { catalog: [{ provider: 'openai', model: 'gpt-unheard-of' }] },
        available: new Set(),
      }),
    );
    expect(stale.field).toBe('catalog[0].model');
    expect(stale.message).not.toContain('gpt-unheard-of');
  });

  test('ignore an edit for a provider no loaded plugin contributes', () => {
    const rows = select({
      configuration: { catalog: [{ provider: 'openai', model: 'gpt-unheard-of', off: true }] },
      providers: contributed(['anthropic']),
    });
    expect(new Set(rows.map((row) => row.provider))).toEqual(new Set(['anthropic']));
  });

  test('let an allowlist name an added row, and keep an added row the allowlist leaves out out', () => {
    const added = { provider: 'openai', model: 'gpt-next', basedOn: 'gpt-4.1' };
    const named = select({
      configuration: { catalog: [added] },
      allowlists: allow('openai', 'gpt-4.1', 'gpt-next'),
      providers: contributed(['openai']),
    });
    expect(named.map((row) => row.model)).toEqual(['gpt-4.1', 'gpt-next']);
    const left = select({
      configuration: { catalog: [added] },
      allowlists: allow('openai', 'gpt-4.1'),
      providers: contributed(['openai']),
    });
    expect(left.map((row) => row.model)).toEqual(['gpt-4.1']);
    // Without the edit that adds it, the same allowlist entry matches nothing and is refused.
    const stale = failureOf(() => select({ allowlists: allow('openai', 'gpt-4.1', 'gpt-next') }));
    expect(stale.field).toBe('plugins.openai.configuration.models[1]');
  });

  test('refuse two edits that name one model under different names, naming the second', () => {
    const failure = failureOf(() =>
      select({
        configuration: {
          catalog: [
            { provider: 'anthropic', model: 'claude-haiku-4-5', off: true },
            { provider: 'anthropic', model: 'haiku', off: true },
          ],
        },
        available: new Set(),
      }),
    );
    expect(failure.field).toBe('catalog[1].model');
  });

  test('leave an allowlisted-out row out even when an edit names it', () => {
    const rows = select({
      configuration: { catalog: [{ provider: 'openai', model: 'o3', off: true }] },
      allowlists: allow('openai', 'gpt-4.1'),
    });
    expect(rows.filter((row) => row.provider === 'openai').map((row) => row.model)).toEqual([
      'gpt-4.1',
    ]);
  });

  test('are every contributed provider’s rows when no allowlist is given', () => {
    const rows = select({ providers: contributed(['anthropic', 'gemini']) });
    expect(pairs(rows)).toEqual(
      pairs(STATIC_ROWS.filter((row) => row.provider === 'anthropic' || row.provider === 'gemini')),
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  test('are empty when no plugin contributes a provider', () => {
    expect(select({ providers: [] })).toEqual([]);
  });

  test('leave out a provider that has no key', () => {
    const rows = select({ available: new Set(['openai']) });
    expect(new Set(rows.map((row) => row.provider))).toEqual(new Set(['openai']));
  });

  test('narrow to an allowlist matched on the model or an alias', () => {
    const rows = select({
      allowlists: new Map([
        ['anthropic', ['claude-opus-4-8', 'sonnet']],
        ['openai', ['gpt-4.1']],
      ]),
    });
    expect(pairs(rows.filter((row) => row.provider !== 'gemini'))).toEqual([
      'anthropic/claude-opus-4-8',
      'anthropic/claude-sonnet-5',
      'openai/gpt-4.1',
    ]);
  });

  test('count a row once however many entries name it', () => {
    const rows = select({
      allowlists: allow('anthropic', 'sonnet', 'claude-sonnet-5', 'sonnet'),
      providers: contributed(['anthropic']),
    });
    expect(pairs(rows)).toEqual(['anthropic/claude-sonnet-5']);
  });

  test('exclude a retired row, and refuse an allowlist entry that names only a retired row', () => {
    const retired: BackendDescriptor = {
      ...STATIC_ROWS.find((row) => row.model === 'claude-opus-4-8')!,
      lifecycle: 'retired',
    };
    const rowsOf = [...STATIC_ROWS.filter((row) => row.model !== 'claude-opus-4-8'), retired];
    const all = select({ providers: contributed(['anthropic'], rowsOf) });
    expect(pairs(all)).not.toContain('anthropic/claude-opus-4-8');
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((row) => row.lifecycle !== 'retired')).toBe(true);

    const failure = failureOf(() =>
      select({
        allowlists: allow('anthropic', 'claude-opus-4-8'),
        providers: contributed(['anthropic'], rowsOf),
      }),
    );
    expect(failure.message).toContain('plugins.anthropic.configuration.models[0]');
  });

  test('refuse an allowlist entry that matches no row, naming the file and the field', () => {
    const failure = failureOf(() =>
      select({ allowlists: allow('openai', 'gpt-4.1', 'gpt-nonexistent') }),
    );
    expect(failure.message).toContain(PATH);
    expect(failure.message).toContain('plugins.openai.configuration.models[1]');
    // The entry might be a secret pasted by mistake, so its value is never echoed.
    expect(failure.message).not.toContain('gpt-nonexistent');
  });

  test('refuse a stale allowlist entry even when the provider has no key', () => {
    const failure = failureOf(() =>
      select({ allowlists: allow('openai', 'gpt-nonexistent'), available: new Set() }),
    );
    expect(failure.message).toContain('plugins.openai.configuration.models[0]');
  });

  test('an entry for one plugin does not match another plugin’s model', () => {
    const failure = failureOf(() => select({ allowlists: allow('openai', 'claude-opus-4-8') }));
    expect(failure.message).toContain('plugins.openai.configuration.models[0]');
  });

  test('take the rows a plugin contributes, whatever Operative’s catalog holds', () => {
    const [seed] = STATIC_ROWS;
    const own: BackendDescriptor = { ...seed!, provider: 'lender', model: 'lender-1', aliases: [] };
    const lender: ContributedProvider = {
      plugin: 'lender',
      name: 'lender',
      definition: { ...anthropicProvider, name: 'lender' },
      rows: [own],
      secretKey: 'lender-api-key',
    };
    expect(pairs(select({ providers: [lender], available: new Set(['lender']) }))).toEqual([
      'lender/lender-1',
    ]);
  });
});

describe('loading the providers', () => {
  const FIXTURE_VALUE = 'fixture-secret-value-0001';

  async function configurationAt(contents: unknown): Promise<string> {
    const directory = await scratch();
    const path = join(directory, 'configuration.json');
    await writeFile(path, JSON.stringify(contents));
    return path;
  }

  const keyedBy = (key: string) => (name: string) => (name === key ? FIXTURE_VALUE : undefined);

  test('keeps a provider whose key is present, and hands back the key', async () => {
    const path = await configurationAt({
      plugins: { anthropic: { configuration: { models: ['sonnet'] } } },
    });
    const warnings: string[] = [];
    const loaded = await loadProviders({
      ...fileReader(path),
      readSecret: keyedBy('anthropic-api-key'),
      warn: (message) => warnings.push(message),
      providers: contributed(['anthropic']),
    });
    expect(pairs(loaded.rows)).toEqual(['anthropic/claude-sonnet-5']);
    expect(loaded.apiKeys.get('anthropic')).toBe(FIXTURE_VALUE);
    expect(warnings).toEqual([]);
  });

  test('offers a provider with a key and no stored configuration at all', async () => {
    const path = await configurationAt({});
    const loaded = await loadProviders({
      ...fileReader(path),
      readSecret: keyedBy('openai-api-key'),
      warn: () => undefined,
      providers: contributed(),
    });
    expect(new Set(loaded.rows.map((row) => row.provider))).toEqual(new Set(['openai']));
  });

  test('omits a provider whose key is missing, and warns once, naming the provider and the key but no value, only when its plugin has an allowlist', async () => {
    const path = await configurationAt({
      plugins: { openai: { configuration: { models: ['gpt-4.1'] } } },
    });
    const warnings: string[] = [];
    const loaded = await loadProviders({
      ...fileReader(path),
      readSecret: keyedBy('anthropic-api-key'),
      warn: (message) => warnings.push(message),
      providers: contributed(),
    });
    expect(new Set(loaded.rows.map((row) => row.provider))).toEqual(new Set(['anthropic']));
    expect(loaded.apiKeys.has('openai')).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('openai');
    expect(warnings[0]).toContain('openai-api-key');
    expect(warnings[0]).not.toContain(FIXTURE_VALUE);
  });

  test('treats an empty secret as missing', async () => {
    const path = await configurationAt({});
    const loaded = await loadProviders({
      ...fileReader(path),
      readSecret: () => '  \n',
      warn: () => undefined,
      providers: contributed(['gemini']),
    });
    expect(loaded.rows).toEqual([]);
  });

  test('never echoes a model entry, which may be a pasted secret, in any startup error', async () => {
    const pasted = 'fixture-pasted-secret-0000';
    const path = await configurationAt({
      plugins: { anthropic: { configuration: { models: [pasted] } } },
    });
    const stale = await loadProviders({
      ...fileReader(path),
      readSecret: () => undefined,
      warn: () => undefined,
      providers: contributed(),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(stale).toBeInstanceOf(ProviderConfigurationError);
    expect(String(stale)).toContain(path);
    expect(String(stale)).toContain('plugins.anthropic.configuration.models[0]');
    expect(String(stale)).not.toContain(pasted);

    const directory = await scratch();
    const broken = join(directory, 'configuration.json');
    await writeFile(broken, `{"plugins":{"anthropic":{"configuration":{"models":["${pasted}"`);
    const malformed = await loadProviders({
      ...fileReader(broken),
      readSecret: () => undefined,
      warn: () => undefined,
      providers: contributed(),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(malformed).toBeInstanceOf(ProviderConfigurationError);
    expect(String(malformed)).not.toContain(pasted);

    for (const models of [
      [1, pasted],
      [pasted, ''],
    ]) {
      const wrong = failureOf(() =>
        readAllowlists({ plugins: { openai: { configuration: { models } } } }, PATH, ['openai']),
      );
      expect(wrong.message).not.toContain(pasted);
    }
  });

  test('emits no warning when the configuration is refused', async () => {
    // `anthropic` has an allowlist and no key, so it would warn, but `openai`'s stale entry fails startup first.
    const path = await configurationAt({
      plugins: {
        anthropic: { configuration: { models: ['sonnet'] } },
        openai: { configuration: { models: ['gpt-nonexistent'] } },
      },
    });
    const warnings: string[] = [];
    const failure = await loadProviders({
      ...fileReader(path),
      readSecret: () => undefined,
      warn: (message) => warnings.push(message),
      providers: contributed(),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProviderConfigurationError);
    expect(warnings).toEqual([]);
  });

  test('trims whitespace around a secret before it is kept', async () => {
    const path = await configurationAt({});
    const loaded = await loadProviders({
      ...fileReader(path),
      readSecret: () => `  \n${FIXTURE_VALUE}\n`,
      warn: () => undefined,
      providers: contributed(['anthropic']),
    });
    expect(loaded.apiKeys.get('anthropic')).toBe(FIXTURE_VALUE);
  });

  test('reads no secret and offers nothing when no plugin contributes a provider', async () => {
    const directory = await scratch();
    const read: string[] = [];
    const loaded = await loadProviders({
      ...fileReader(join(directory, 'configuration.json')),
      readSecret: (key) => {
        read.push(key);
        return undefined;
      },
      warn: () => undefined,
      providers: [],
    });
    expect(loaded.rows).toEqual([]);
    expect(read).toEqual([]);
  });

  test('a configuration path that is a directory is refused, naming the path', async () => {
    const directory = await scratch();
    const failure = await loadProviders({
      ...fileReader(directory),
      readSecret: () => undefined,
      warn: () => undefined,
      providers: contributed(),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProviderConfigurationError);
    expect(String(failure)).toContain(directory);
  });
});

describe('a model’s generate', () => {
  const providers = contributed(['anthropic']);
  const rows = selectCatalogRows({
    configuration: {},
    allowlists: NONE,
    path: PATH,
    available: ALL,
    providers,
  });
  const apiKeys = new Map([['anthropic', 'fixture-key'] as const]);

  test('is resolved through the provider path with the contributed definitions, the model and the key', () => {
    const seen: unknown[] = [];
    const seenDefinitions: unknown[] = [];
    const generate = async () => ({ content: 'ok', toolCalls: [] });
    const resolved = createCatalogGenerate(
      { provider: 'anthropic', model: 'sonnet' },
      {
        rows,
        apiKeys,
        providers,
        resolveProviderGenerate: (definitions, provider) => {
          seenDefinitions.push(definitions);
          seen.push(provider);
          return generate;
        },
      },
    );
    expect(resolved).toBe(generate);
    expect(seenDefinitions).toEqual([[anthropicProvider]]);
    expect(seen).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'fixture-key' },
    ]);
  });

  test('refuses a model that is not in the catalog', () => {
    const resolveProviderGenerate = () => async () => ({ content: '', toolCalls: [] });
    expect(() =>
      createCatalogGenerate(
        { provider: 'anthropic', model: 'gpt-4.1' },
        { rows, apiKeys, providers, resolveProviderGenerate },
      ),
    ).toThrow('gpt-4.1');
    expect(() =>
      createCatalogGenerate(
        { provider: 'openai', model: 'gpt-4.1' },
        { rows, apiKeys, providers, resolveProviderGenerate },
      ),
    ).toThrow('openai');
  });
});
