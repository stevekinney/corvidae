import { createModelCatalog, type BackendDescriptor } from '@lostgradient/operative';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderConfigurationError } from './provider-configuration-error.ts';
import {
  createCatalogGenerate,
  loadProviders,
  parseProviderConfiguration,
  PROVIDER_DEFINITIONS,
  PROVIDER_SECRET_KEYS,
  readProviderConfiguration,
  selectCatalogRows,
  type ProviderConfigurationFile,
} from './providers.ts';

const PATH = '/home/interborough/configuration.json';
const ALL = new Set(['anthropic', 'openai', 'gemini'] as const);
const STATIC_ROWS = createModelCatalog().descriptors;

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
  test('accepts a provider with and without a model allowlist', () => {
    const configuration = parseProviderConfiguration(
      JSON.stringify({ providers: { anthropic: {}, openai: { models: ['gpt-4.1', 'o3'] } } }),
      PATH,
    );
    expect(configuration).toEqual({
      providers: { anthropic: {}, openai: { models: ['gpt-4.1', 'o3'] } },
    });
  });

  test('ignores keys outside providers, which belong to other parts of the application', () => {
    const configuration = parseProviderConfiguration(
      JSON.stringify({ somethingElse: { nested: true }, providers: { gemini: {} }, version: 2 }),
      PATH,
    );
    expect(configuration).toEqual({ providers: { gemini: {} } });
  });

  test('reads the catalog edits beside the providers, and leaves them out when there are none', () => {
    const edit = { provider: 'openai', model: 'gpt-4.1', off: true };
    expect(
      parseProviderConfiguration(JSON.stringify({ providers: {}, catalog: [edit] }), PATH),
    ).toEqual({ providers: {}, catalog: [edit] });
    expect(parseProviderConfiguration('{"catalog":[]}', PATH)).toEqual({
      providers: {},
      catalog: [],
    });
    expect(Object.hasOwn(parseProviderConfiguration('{"providers":{}}', PATH), 'catalog')).toBe(
      false,
    );
  });

  test('an empty providers object, and an empty file object, mean no providers', () => {
    expect(parseProviderConfiguration('{"providers":{}}', PATH)).toEqual({ providers: {} });
    expect(parseProviderConfiguration('{}', PATH)).toEqual({ providers: {} });
  });

  test('refuses a provider key that is not anthropic, openai, or gemini, naming the file and the field', () => {
    for (const unknown of ['voyage', 'ollama', 'Anthropic', 'mistral']) {
      const failure = failureOf(() =>
        parseProviderConfiguration(JSON.stringify({ providers: { [unknown]: {} } }), PATH),
      );
      expect(failure.message).toContain(PATH);
      expect(failure.message).toContain(`providers.${unknown}`);
    }
  });

  test('refuses malformed JSON, naming the file', () => {
    const failure = failureOf(() => parseProviderConfiguration('{ "providers": ', PATH));
    expect(failure.message).toContain(PATH);
    expect(failure.message).toContain('JSON');
  });

  test('refuses a file or a providers value that is not an object, naming the field', () => {
    for (const [text, field] of [
      ['[]', 'the file'],
      ['null', 'the file'],
      ['{"providers":[]}', 'providers'],
      ['{"providers":"anthropic"}', 'providers'],
      ['{"providers":null}', 'providers'],
    ] as const) {
      const failure = failureOf(() => parseProviderConfiguration(text, PATH));
      expect(failure.message, text).toContain(PATH);
      expect(failure.message, text).toContain(field);
    }
  });

  test('refuses a provider entry that is not an object or that carries another field', () => {
    const notAnObject = failureOf(() =>
      parseProviderConfiguration('{"providers":{"anthropic":true}}', PATH),
    );
    expect(notAnObject.message).toContain('providers.anthropic');
    const extra = failureOf(() =>
      parseProviderConfiguration('{"providers":{"openai":{"apiKey":"x"}}}', PATH),
    );
    expect(extra.message).toContain(PATH);
    expect(extra.message).toContain('providers.openai.apiKey');
    // The value of a misplaced key never appears in the error.
    expect(extra.message).not.toContain('"x"');
  });

  test('refuses a models value that is not a non-empty list of non-empty strings', () => {
    for (const [models, field] of [
      ['"gpt-4.1"', 'providers.openai.models'],
      ['[]', 'providers.openai.models'],
      ['[1]', 'providers.openai.models[0]'],
      ['["gpt-4.1",""]', 'providers.openai.models[1]'],
    ] as const) {
      const failure = failureOf(() =>
        parseProviderConfiguration(`{"providers":{"openai":{"models":${models}}}}`, PATH),
      );
      expect(failure.message, models).toContain(PATH);
      expect(failure.message, models).toContain(field);
    }
  });

  test('a missing file means no providers, not an error', async () => {
    const directory = await scratch();
    const configuration = await readProviderConfiguration(
      fileReader(join(directory, 'configuration.json')),
    );
    expect(configuration).toEqual({ providers: {} });
  });

  test('reads the file at the path it was given, and names that path when it is invalid', async () => {
    const directory = await scratch();
    const path = join(directory, 'configuration.json');
    await writeFile(path, '{"providers":{"gemini":{}}}');
    expect(await readProviderConfiguration(fileReader(path))).toEqual({
      providers: { gemini: {} },
    });

    await writeFile(path, '{"providers":{"nope":{}}}');
    const failure = await readProviderConfiguration(fileReader(path)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProviderConfigurationError);
    expect(String(failure)).toContain(path);
  });

  test('a configuration path that is a directory is refused, naming the path', async () => {
    const directory = await scratch();
    const failure = await readProviderConfiguration(fileReader(directory)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProviderConfigurationError);
    expect(String(failure)).toContain(directory);
  });
});

describe('the secret keys', () => {
  test('are the provider name and -api-key', () => {
    expect(PROVIDER_SECRET_KEYS).toEqual({
      anthropic: 'anthropic-api-key',
      openai: 'openai-api-key',
      gemini: 'gemini-api-key',
    });
  });
});

describe('the catalog rows', () => {
  const configure = (
    providers: ProviderConfigurationFile['providers'],
    catalog?: ProviderConfigurationFile['catalog'],
  ) => ({ providers, ...(catalog === undefined ? {} : { catalog }) });

  test('apply an edit only to a provider that has a key, but check the edit either way', () => {
    const off = [{ provider: 'openai', model: 'gpt-4.1', off: true }];
    const withKey = selectCatalogRows({
      configuration: configure({ openai: {} }, off),
      path: PATH,
      available: ALL,
    });
    expect(withKey.find((row) => row.model === 'gpt-4.1')?.availability).toBe('unavailable');
    expect(
      selectCatalogRows({
        configuration: configure({ openai: {} }, off),
        path: PATH,
        available: new Set(['anthropic'] as const),
      }),
    ).toEqual([]);
    const stale = failureOf(() =>
      selectCatalogRows({
        configuration: configure({ openai: {} }, [{ provider: 'openai', model: 'gpt-unheard-of' }]),
        path: PATH,
        available: new Set<'openai'>(),
      }),
    );
    expect(stale.field).toBe('catalog[0].model');
    expect(stale.message).not.toContain('gpt-unheard-of');
  });

  test('let an allowlist name an added row, and keep an added row the allowlist leaves out out', () => {
    const added = { provider: 'openai', model: 'gpt-next', basedOn: 'gpt-4.1' };
    const named = selectCatalogRows({
      configuration: configure({ openai: { models: ['gpt-4.1', 'gpt-next'] } }, [added]),
      path: PATH,
      available: ALL,
    });
    expect(named.map((row) => row.model)).toEqual(['gpt-4.1', 'gpt-next']);
    const left = selectCatalogRows({
      configuration: configure({ openai: { models: ['gpt-4.1'] } }, [added]),
      path: PATH,
      available: ALL,
    });
    expect(left.map((row) => row.model)).toEqual(['gpt-4.1']);
    // Without the edit that adds it, the same allowlist entry matches nothing and is refused.
    const stale = failureOf(() =>
      selectCatalogRows({
        configuration: configure({ openai: { models: ['gpt-4.1', 'gpt-next'] } }),
        path: PATH,
        available: ALL,
      }),
    );
    expect(stale.field).toBe('providers.openai.models[1]');
  });

  test('refuse two edits that name one model under different names, naming the second', () => {
    const failure = failureOf(() =>
      selectCatalogRows({
        configuration: configure({ anthropic: {} }, [
          { provider: 'anthropic', model: 'claude-haiku-4-5', off: true },
          { provider: 'anthropic', model: 'haiku', off: true },
        ]),
        path: PATH,
        available: new Set<'anthropic'>(),
      }),
    );
    expect(failure.field).toBe('catalog[1].model');
  });

  test('leave an allowlisted-out row out even when an edit names it', () => {
    const rows = selectCatalogRows({
      configuration: configure({ openai: { models: ['gpt-4.1'] } }, [
        { provider: 'openai', model: 'o3', off: true },
      ]),
      path: PATH,
      available: ALL,
    });
    expect(rows.map((row) => row.model)).toEqual(['gpt-4.1']);
  });

  test('are exactly the configured providers’ rows when no allowlist is given', () => {
    const rows = selectCatalogRows({
      configuration: configure({ anthropic: {}, gemini: {} }),
      path: PATH,
      available: ALL,
    });
    expect(pairs(rows)).toEqual(
      pairs(STATIC_ROWS.filter((row) => row.provider === 'anthropic' || row.provider === 'gemini')),
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  test('are empty when no provider is configured', () => {
    expect(selectCatalogRows({ configuration: configure({}), path: PATH, available: ALL })).toEqual(
      [],
    );
  });

  test('leave out a configured provider that has no key', () => {
    const rows = selectCatalogRows({
      configuration: configure({ anthropic: {}, openai: {} }),
      path: PATH,
      available: new Set(['openai'] as const),
    });
    expect(new Set(rows.map((row) => row.provider))).toEqual(new Set(['openai']));
  });

  test('narrow to an allowlist matched on the model or an alias', () => {
    const rows = selectCatalogRows({
      configuration: configure({
        anthropic: { models: ['claude-opus-4-8', 'sonnet'] },
        openai: { models: ['gpt-4.1'] },
      }),
      path: PATH,
      available: ALL,
    });
    expect(pairs(rows)).toEqual([
      'anthropic/claude-opus-4-8',
      'anthropic/claude-sonnet-5',
      'openai/gpt-4.1',
    ]);
  });

  test('count a row once however many entries name it', () => {
    const rows = selectCatalogRows({
      configuration: configure({ anthropic: { models: ['sonnet', 'claude-sonnet-5', 'sonnet'] } }),
      path: PATH,
      available: ALL,
    });
    expect(pairs(rows)).toEqual(['anthropic/claude-sonnet-5']);
  });

  test('exclude a retired row, and refuse an allowlist entry that names only a retired row', () => {
    const retired: BackendDescriptor = {
      ...STATIC_ROWS.find((row) => row.model === 'claude-opus-4-8')!,
      lifecycle: 'retired',
    };
    const descriptors = [...STATIC_ROWS.filter((row) => row.model !== 'claude-opus-4-8'), retired];
    const all = selectCatalogRows({
      configuration: configure({ anthropic: {} }),
      path: PATH,
      available: ALL,
      descriptors,
    });
    expect(pairs(all)).not.toContain('anthropic/claude-opus-4-8');
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((row) => row.lifecycle !== 'retired')).toBe(true);

    const failure = failureOf(() =>
      selectCatalogRows({
        configuration: configure({ anthropic: { models: ['claude-opus-4-8'] } }),
        path: PATH,
        available: ALL,
        descriptors,
      }),
    );
    expect(failure.message).toContain('providers.anthropic.models[0]');
  });

  test('refuse an allowlist entry that matches no row, naming the file and the field', () => {
    const failure = failureOf(() =>
      selectCatalogRows({
        configuration: configure({ openai: { models: ['gpt-4.1', 'gpt-nonexistent'] } }),
        path: PATH,
        available: ALL,
      }),
    );
    expect(failure.message).toContain(PATH);
    expect(failure.message).toContain('providers.openai.models[1]');
    // The entry might be a secret pasted by mistake, so its value is never echoed.
    expect(failure.message).not.toContain('gpt-nonexistent');
  });

  test('refuse a stale allowlist entry even when the provider has no key', () => {
    const failure = failureOf(() =>
      selectCatalogRows({
        configuration: configure({ openai: { models: ['gpt-nonexistent'] } }),
        path: PATH,
        available: new Set(),
      }),
    );
    expect(failure.message).toContain('providers.openai.models[0]');
  });

  test('an entry for one provider does not match another provider’s model', () => {
    const failure = failureOf(() =>
      selectCatalogRows({
        configuration: configure({ openai: { models: ['claude-opus-4-8'] } }),
        path: PATH,
        available: ALL,
      }),
    );
    expect(failure.message).toContain('providers.openai.models[0]');
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

  test('keeps a configured provider whose key is present, and hands back the key', async () => {
    const path = await configurationAt({ providers: { anthropic: { models: ['sonnet'] } } });
    const warnings: string[] = [];
    const loaded = await loadProviders({
      ...fileReader(path),
      readSecret: (key) => (key === 'anthropic-api-key' ? FIXTURE_VALUE : undefined),
      warn: (message) => warnings.push(message),
    });
    expect(pairs(loaded.rows)).toEqual(['anthropic/claude-sonnet-5']);
    expect(loaded.apiKeys.get('anthropic')).toBe(FIXTURE_VALUE);
    expect(warnings).toEqual([]);
  });

  test('omits a configured provider whose key is missing, with one warning that names the provider and the key but no value', async () => {
    const path = await configurationAt({ providers: { anthropic: {}, openai: {} } });
    const warnings: string[] = [];
    const loaded = await loadProviders({
      ...fileReader(path),
      readSecret: (key) => (key === 'anthropic-api-key' ? FIXTURE_VALUE : undefined),
      warn: (message) => warnings.push(message),
    });
    expect(new Set(loaded.rows.map((row) => row.provider))).toEqual(new Set(['anthropic']));
    expect(loaded.apiKeys.has('openai')).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('openai');
    expect(warnings[0]).toContain('openai-api-key');
    expect(warnings[0]).not.toContain(FIXTURE_VALUE);
  });

  test('treats an empty secret as missing', async () => {
    const path = await configurationAt({ providers: { gemini: {} } });
    const warnings: string[] = [];
    const loaded = await loadProviders({
      ...fileReader(path),
      readSecret: () => '  \n',
      warn: (message) => warnings.push(message),
    });
    expect(loaded.rows).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  test('never echoes a model entry, which may be a pasted secret, in any startup error', async () => {
    const pasted = 'fixture-pasted-secret-0000';
    const path = await configurationAt({ providers: { anthropic: { models: [pasted] } } });
    const stale = await loadProviders({
      ...fileReader(path),
      readSecret: () => undefined,
      warn: () => undefined,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(stale).toBeInstanceOf(ProviderConfigurationError);
    expect(String(stale)).toContain(path);
    expect(String(stale)).toContain('providers.anthropic.models[0]');
    expect(String(stale)).not.toContain(pasted);

    const directory = await scratch();
    const broken = join(directory, 'configuration.json');
    await writeFile(broken, `{"providers":{"anthropic":{"models":["${pasted}"`);
    const malformed = await readProviderConfiguration(fileReader(broken)).then(
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
        parseProviderConfiguration(JSON.stringify({ providers: { openai: { models } } }), PATH),
      );
      expect(wrong.message).not.toContain(pasted);
    }
  });

  test('emits no warning when the configuration is refused', async () => {
    // `anthropic` has no key, so it would warn, but `openai`'s stale entry fails startup first.
    const path = await configurationAt({
      providers: { anthropic: {}, openai: { models: ['gpt-nonexistent'] } },
    });
    const warnings: string[] = [];
    const failure = await loadProviders({
      ...fileReader(path),
      readSecret: () => undefined,
      warn: (message) => warnings.push(message),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProviderConfigurationError);
    expect(warnings).toEqual([]);
  });

  test('trims whitespace around a secret before it is kept', async () => {
    const path = await configurationAt({ providers: { anthropic: {} } });
    const loaded = await loadProviders({
      ...fileReader(path),
      readSecret: () => `  \n${FIXTURE_VALUE}\n`,
      warn: () => undefined,
    });
    expect(loaded.apiKeys.get('anthropic')).toBe(FIXTURE_VALUE);
  });

  test('reads no secret and warns of nothing when no provider is configured', async () => {
    const directory = await scratch();
    const read: string[] = [];
    const warnings: string[] = [];
    const loaded = await loadProviders({
      ...fileReader(join(directory, 'configuration.json')),
      readSecret: (key) => {
        read.push(key);
        return undefined;
      },
      warn: (message) => warnings.push(message),
    });
    expect(loaded.rows).toEqual([]);
    expect(read).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe('a model’s generate', () => {
  const rows = selectCatalogRows({
    configuration: { providers: { anthropic: {} } },
    path: PATH,
    available: ALL,
  });
  const apiKeys = new Map([['anthropic', 'fixture-key'] as const]);

  test('is resolved through the provider path with the model and the key', () => {
    const seen: unknown[] = [];
    const seenDefinitions: unknown[] = [];
    const generate = async () => ({ content: 'ok', toolCalls: [] });
    const resolved = createCatalogGenerate(
      { provider: 'anthropic', model: 'sonnet' },
      {
        rows,
        apiKeys,
        resolveProviderGenerate: (definitions, provider) => {
          seenDefinitions.push(definitions);
          seen.push(provider);
          return generate;
        },
      },
    );
    expect(resolved).toBe(generate);
    expect(seenDefinitions).toEqual([PROVIDER_DEFINITIONS]);
    expect(seen).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'fixture-key' },
    ]);
  });

  test('refuses a model that is not in the catalog', () => {
    expect(() =>
      createCatalogGenerate(
        { provider: 'anthropic', model: 'gpt-4.1' },
        {
          rows,
          apiKeys,
          resolveProviderGenerate: () => async () => ({ content: '', toolCalls: [] }),
        },
      ),
    ).toThrow('gpt-4.1');
    expect(() =>
      createCatalogGenerate(
        { provider: 'openai', model: 'gpt-4.1' },
        {
          rows,
          apiKeys,
          resolveProviderGenerate: () => async () => ({ content: '', toolCalls: [] }),
        },
      ),
    ).toThrow('openai');
  });
});
