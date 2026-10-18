/**
 * The model providers the host offers: which are configured, which have a key, and the catalog
 * rows that follow.
 *
 * The providers live in Bungalow's `configuration.json`, and the API keys in its secrets:
 *
 * ```json
 * { "providers": { "anthropic": {}, "openai": { "models": ["gpt-4.1"] } } }
 * ```
 *
 * A provider key is exactly one of Bureau's {@link GenerateProviderName}, `anthropic`, `openai`,
 * or `gemini`. A provider's `models` is an optional allowlist, matched on a row's `model` or one
 * of its aliases. A provider whose secret is missing is left out with a warning; an environment
 * variable is never read. The rows are Operative's `createModelCatalog().descriptors`, so the
 * catalog never holds a model the provider code cannot call.
 *
 * @module providers
 */

import type { GenerateProviderName, resolveProviderGenerate } from '@lostgradient/bureau';
import {
  createModelCatalog,
  type BackendDescriptor,
  type GenerateFunction,
} from '@lostgradient/operative';

/** The providers a configuration may name, in the order their rows are installed. */
export const PROVIDER_NAMES = [
  'anthropic',
  'openai',
  'gemini',
] as const satisfies readonly GenerateProviderName[];

/** The Bungalow secret that holds each provider's API key. */
export const PROVIDER_SECRET_KEYS: Readonly<Record<GenerateProviderName, string>> = {
  anthropic: 'anthropic-api-key',
  openai: 'openai-api-key',
  gemini: 'gemini-api-key',
};

export type ProviderEntry = {
  /** An allowlist of models, matched on a row's `model` or an alias. Absent means every model. */
  readonly models?: readonly string[];
};

export type ProviderConfigurationFile = {
  readonly providers: Readonly<Partial<Record<GenerateProviderName, ProviderEntry>>>;
};

/** A configuration that cannot be used. The message names the file and the field, never a value. */
export class ProviderConfigurationError extends Error {
  readonly path: string;
  readonly field: string;

  constructor(path: string, field: string, problem: string) {
    super(`Invalid configuration in ${path}, ${field}: ${problem}`);
    this.name = 'ProviderConfigurationError';
    this.path = path;
    this.field = field;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProviderName(value: string): value is GenerateProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

function parseModels(models: unknown, path: string, field: string): readonly string[] {
  if (!Array.isArray(models)) {
    throw new ProviderConfigurationError(path, field, 'expected a list of model names.');
  }
  if (models.length === 0) {
    throw new ProviderConfigurationError(
      path,
      field,
      'the list is empty, so no model would be offered. Remove it to offer every model.',
    );
  }
  return models.map((entry: unknown, index) => {
    if (typeof entry !== 'string' || entry === '') {
      throw new ProviderConfigurationError(
        path,
        `${field}[${index}]`,
        'expected a non-empty model name.',
      );
    }
    return entry;
  });
}

/**
 * Parse the contents of `configuration.json`. Keys outside `providers` are ignored, because the
 * file is Bungalow's and other parts of the application may add their own. Everything inside
 * `providers` is checked, so a misspelled provider or field fails startup instead of quietly
 * offering nothing.
 */
export function parseProviderConfiguration(text: string, path: string): ProviderConfigurationFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderConfigurationError(path, 'the file', 'it is not valid JSON.');
  }
  if (!isPlainObject(parsed)) {
    throw new ProviderConfigurationError(path, 'the file', 'expected a JSON object.');
  }
  const declared = parsed['providers'];
  if (declared === undefined) return { providers: {} };
  if (!isPlainObject(declared)) {
    throw new ProviderConfigurationError(path, 'providers', 'expected an object.');
  }
  const providers: Partial<Record<GenerateProviderName, ProviderEntry>> = {};
  for (const [name, entry] of Object.entries(declared)) {
    const field = `providers.${name}`;
    if (!isProviderName(name)) {
      throw new ProviderConfigurationError(
        path,
        field,
        `not a provider. Expected ${PROVIDER_NAMES.join(', ')}.`,
      );
    }
    if (!isPlainObject(entry)) {
      throw new ProviderConfigurationError(path, field, 'expected an object.');
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'models') {
        throw new ProviderConfigurationError(path, `${field}.${key}`, 'not a known field.');
      }
    }
    const models = entry['models'];
    providers[name] =
      models === undefined ? {} : { models: parseModels(models, path, `${field}.models`) };
  }
  return { providers };
}

/** Read `configuration.json`. A file that is not there means no providers. */
export async function readProviderConfiguration(path: string): Promise<ProviderConfigurationFile> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') {
      return { providers: {} };
    }
    throw new ProviderConfigurationError(path, 'the file', 'it could not be read.');
  }
  return parseProviderConfiguration(text, path);
}

function matchesEntry(row: BackendDescriptor, entry: string): boolean {
  return row.model === entry || row.aliases.some((alias) => alias.alias === entry);
}

/**
 * The catalog rows for a configuration. A row is kept when its provider is configured and has a
 * key (`available`), it is not retired, and the provider's allowlist, when it has one, names it.
 * An allowlist entry that names no non-retired row fails, whether or not the provider has a key,
 * so a stale entry does not wait for the key to appear. `descriptors` defaults to Operative's
 * static catalog.
 */
export function selectCatalogRows(input: {
  readonly configuration: ProviderConfigurationFile;
  readonly path: string;
  readonly available: ReadonlySet<GenerateProviderName>;
  readonly descriptors?: readonly BackendDescriptor[];
}): BackendDescriptor[] {
  const descriptors = input.descriptors ?? createModelCatalog().descriptors;
  const selected: BackendDescriptor[] = [];
  for (const provider of PROVIDER_NAMES) {
    const entry = input.configuration.providers[provider];
    if (entry === undefined) continue;
    const candidates = descriptors.filter(
      (row) => row.provider === provider && row.lifecycle !== 'retired',
    );
    const named = new Set<BackendDescriptor>();
    entry.models?.forEach((model, index) => {
      const matches = candidates.filter((row) => matchesEntry(row, model));
      if (matches.length === 0) {
        throw new ProviderConfigurationError(
          input.path,
          `providers.${provider}.models[${index}]`,
          `"${model}" matches no current ${provider} model.`,
        );
      }
      for (const row of matches) named.add(row);
    });
    if (!input.available.has(provider)) continue;
    selected.push(
      ...(entry.models === undefined ? candidates : candidates.filter((row) => named.has(row))),
    );
  }
  return selected;
}

/** What the host offers: the rows to install and the key each offered provider is called with. */
export type LoadedProviders = {
  readonly rows: readonly BackendDescriptor[];
  readonly apiKeys: ReadonlyMap<GenerateProviderName, string>;
};

/**
 * Read the configuration and each configured provider's secret. A provider with no secret is
 * omitted, with one warning that names it and the secret it expects, never a value. The warnings
 * come after validation, so a start that fails reports the failure and nothing else.
 */
export async function loadProviders(input: {
  readonly configurationPath: string;
  readonly readSecret: (key: string) => string | undefined;
  readonly warn: (message: string) => void;
  readonly descriptors?: readonly BackendDescriptor[];
}): Promise<LoadedProviders> {
  const configuration = await readProviderConfiguration(input.configurationPath);
  const apiKeys = new Map<GenerateProviderName, string>();
  const missing: GenerateProviderName[] = [];
  for (const provider of PROVIDER_NAMES) {
    if (configuration.providers[provider] === undefined) continue;
    const key = input.readSecret(PROVIDER_SECRET_KEYS[provider])?.trim();
    if (key === undefined || key === '') missing.push(provider);
    else apiKeys.set(provider, key);
  }
  const rows = selectCatalogRows({
    configuration,
    path: input.configurationPath,
    available: new Set(apiKeys.keys()),
    ...(input.descriptors === undefined ? {} : { descriptors: input.descriptors }),
  });
  for (const provider of missing) {
    input.warn(
      `The ${provider} provider is configured in ${input.configurationPath} but the secret "${PROVIDER_SECRET_KEYS[provider]}" is not set, so it is not offered.`,
    );
  }
  return { rows, apiKeys };
}

/** A catalog model, named by its provider and either its model or an alias. */
export type ModelSelection = {
  readonly provider: GenerateProviderName;
  readonly model: string;
};

/**
 * The generate for an agent assigned a catalog model, resolved through Bureau's provider path with
 * the provider's key. A model the catalog does not hold is refused, which is how a provider
 * without a key stays unreachable.
 */
export function createCatalogGenerate(
  selection: ModelSelection,
  dependencies: {
    readonly rows: readonly BackendDescriptor[];
    readonly apiKeys: ReadonlyMap<GenerateProviderName, string>;
    readonly resolveProviderGenerate: typeof resolveProviderGenerate;
  },
): GenerateFunction {
  const row = dependencies.rows.find(
    (candidate) =>
      candidate.provider === selection.provider && matchesEntry(candidate, selection.model),
  );
  const apiKey = dependencies.apiKeys.get(selection.provider);
  if (row === undefined || apiKey === undefined) {
    throw new Error(
      `The model catalog holds no "${selection.model}" model for the ${selection.provider} provider.`,
    );
  }
  return dependencies.resolveProviderGenerate(
    { provider: selection.provider, model: row.model, apiKey },
    undefined,
    undefined,
  );
}
