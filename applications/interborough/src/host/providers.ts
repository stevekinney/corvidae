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
 * A provider key is exactly one of the {@link InterboroughProviderName}s the host registers in
 * {@link PROVIDER_DEFINITIONS}: `anthropic`, `openai`, or `gemini`. A provider's `models` is an optional allowlist, matched on a row's `model` or one
 * of its aliases. A provider whose secret is missing is left out with a warning; an environment
 * variable is never read. The rows are Operative's `createModelCatalog().descriptors`, so the
 * catalog never holds a model the provider code cannot call.
 *
 * @module providers
 */

import type { resolveProviderGenerate } from '@lostgradient/bureau';
import {
  createModelCatalog,
  type BackendDescriptor,
  type GenerateFunction,
} from '@lostgradient/operative';
import { anthropicProvider } from '@lostgradient/operative-anthropic';
import { geminiProvider } from '@lostgradient/operative-gemini';
import { openaiProvider } from '@lostgradient/operative-openai';

/** The provider definitions the host registers with Bureau's `resolveProviderGenerate`. */
export const PROVIDER_DEFINITIONS = [anthropicProvider, openaiProvider, geminiProvider] as const;

/** The name of a provider the host registers. Adding a definition above makes a missing secret key a type error. */
export type InterboroughProviderName = (typeof PROVIDER_DEFINITIONS)[number]['name'];

/** The providers a configuration may name, in the order their rows are installed. */
export const PROVIDER_NAMES = [
  'anthropic',
  'openai',
  'gemini',
] as const satisfies readonly InterboroughProviderName[];

/** The Bungalow secret that holds each provider's API key. */
export const PROVIDER_SECRET_KEYS: Readonly<Record<InterboroughProviderName, string>> = {
  anthropic: 'anthropic-api-key',
  openai: 'openai-api-key',
  gemini: 'gemini-api-key',
};

/**
 * The Bungalow secret that holds the TypeSafe API key (the `TYPESAFE_API_KEY` of the project
 * document, spelled as Bungalow requires: its secret keys are lowercase and hyphenated, as
 * `anthropic-api-key` is). When it is set, Bureau's decisions are
 * answered by `typesafeJev` (from `@lostgradient/operative-typesafe`) for the kinds it serves (`boolean`, `choice`, `scale`); every other
 * kind, and every kind when it is not set, goes to the catalog's language-model fallback.
 */
export const TYPESAFE_SECRET_KEY = 'typesafe-api-key';

/** One provider's entry in the provider configuration file. */
export type ProviderEntry = {
  /** An allowlist of models, matched on a row's `model` or an alias. Absent means every model. */
  readonly models?: readonly string[];
};

/** The shape of the provider configuration file: an entry per provider the host may call. */
export type ProviderConfigurationFile = {
  readonly providers: Readonly<Partial<Record<InterboroughProviderName, ProviderEntry>>>;
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

function isProviderName(value: string): value is InterboroughProviderName {
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
  const providers: Partial<Record<InterboroughProviderName, ProviderEntry>> = {};
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

/**
 * Read the configuration through `read`, which Bungalow supplies as `readConfiguration()`. A
 * configuration that is not there (`undefined`) means no providers; a read that fails is refused,
 * naming `location`.
 */
export async function readProviderConfiguration(input: {
  readonly location: string;
  readonly read: () => Promise<string | undefined>;
}): Promise<ProviderConfigurationFile> {
  let text: string | undefined;
  try {
    text = await input.read();
  } catch {
    throw new ProviderConfigurationError(input.location, 'the file', 'it could not be read.');
  }
  if (text === undefined) return { providers: {} };
  return parseProviderConfiguration(text, input.location);
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
  readonly available: ReadonlySet<InterboroughProviderName>;
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
          `the entry matches no current ${provider} model. Its value is not repeated here, because it may be a secret.`,
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
  readonly apiKeys: ReadonlyMap<InterboroughProviderName, string>;
};

/**
 * Read the configuration and each configured provider's secret. A provider with no secret is
 * omitted, with one warning that names it and the secret it expects, never a value. The warnings
 * come after validation, so a start that fails reports the failure and nothing else.
 */
export async function loadProviders(input: {
  /** Where the configuration lives, named in every message about it. */
  readonly configurationLocation: string;
  /** The configuration's text, or `undefined` when none exists: Bungalow's `readConfiguration`. */
  readonly readConfiguration: () => Promise<string | undefined>;
  readonly readSecret: (key: string) => string | undefined;
  readonly warn: (message: string) => void;
  readonly descriptors?: readonly BackendDescriptor[];
}): Promise<LoadedProviders> {
  const configuration = await readProviderConfiguration({
    location: input.configurationLocation,
    read: input.readConfiguration,
  });
  const apiKeys = new Map<InterboroughProviderName, string>();
  const missing: InterboroughProviderName[] = [];
  for (const provider of PROVIDER_NAMES) {
    if (configuration.providers[provider] === undefined) continue;
    const key = input.readSecret(PROVIDER_SECRET_KEYS[provider])?.trim();
    if (key === undefined || key === '') missing.push(provider);
    else apiKeys.set(provider, key);
  }
  const rows = selectCatalogRows({
    configuration,
    path: input.configurationLocation,
    available: new Set(apiKeys.keys()),
    ...(input.descriptors === undefined ? {} : { descriptors: input.descriptors }),
  });
  for (const provider of missing) {
    input.warn(
      `The ${provider} provider is configured in ${input.configurationLocation} but the secret "${PROVIDER_SECRET_KEYS[provider]}" is not set, so it is not offered.`,
    );
  }
  return { rows, apiKeys };
}

/** A catalog model, named by its provider and either its model or an alias. */
export type ModelSelection = {
  readonly provider: InterboroughProviderName;
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
    readonly apiKeys: ReadonlyMap<InterboroughProviderName, string>;
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
    PROVIDER_DEFINITIONS,
    { provider: selection.provider, model: row.model, apiKey },
    undefined,
    undefined,
  );
}
