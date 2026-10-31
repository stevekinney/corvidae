/**
 * The model providers the host offers: which plugins contribute them, which have a key, and the
 * catalog rows that follow (COR-1884).
 *
 * A provider is contributed by a plugin (`plugins/anthropic`, `plugins/openai`, `plugins/gemini`),
 * together with the catalog rows of its models, and its API key is the first secret the plugin
 * declares. A plugin's choices live in Bungalow's `configuration.json`, and a provider's allowlist
 * is the `models` of its plugin's configuration:
 *
 * ```json
 * { "plugins": { "openai": { "configuration": { "models": ["gpt-4.1"] } } } }
 * ```
 *
 * A `catalog` list beside `plugins` edits the rows (`catalog-edits.ts`): turn a model off, change
 * its price or limits, or add a row. A `providers` key is not read.
 *
 * An allowlist is matched on a row's `model` or one of its aliases. A provider whose secret is
 * missing is not offered; an environment variable is never read. A plugin that is disabled or
 * skipped contributes no provider, so its allowlist and the catalog edits for its rows wait,
 * ignored, for it to load again.
 *
 * @module providers
 */

import type {
  BureauPluginEntry,
  PluginModelContributions,
  resolveProviderGenerate,
} from '@lostgradient/bureau';
import type {
  BackendDescriptor,
  GenerateFunction,
  ProviderDefinition,
} from '@lostgradient/operative/provider-kit';

import { applyCatalogEdits, parseCatalogEdits, type CatalogEdit } from './catalog-edits.ts';
import { ProviderConfigurationError } from './provider-configuration-error.ts';

/** A model provider a loaded plugin contributes, with what the host needs to call it. */
export type ContributedProvider = {
  /** The plugin that contributed it, whose `configuration.models` is the provider's allowlist. */
  readonly plugin: string;
  /** The provider's name, which a catalog row's `provider` and an agent file's `model` prefix use. */
  readonly name: string;
  /** The definition Bureau's `resolveProviderGenerate` builds a generate from. */
  readonly definition: ProviderDefinition;
  /** The catalog rows of its models, before the allowlist and the catalog edits. */
  readonly rows: readonly BackendDescriptor[];
  /** The Bungalow secret that holds its API key: the first the plugin declares. */
  readonly secretKey: string | undefined;
};

/** The providers the running plugins contributed, each with the secret its plugin declared first. */
export function contributedProviders(
  contributions: PluginModelContributions,
  entries: readonly BureauPluginEntry[],
): readonly ContributedProvider[] {
  return contributions.providers.map(({ plugin, definition, rows }) => {
    const first = entries.find((entry) => entry.descriptor.name === plugin)?.descriptor
      .secrets?.[0];
    return {
      plugin,
      name: definition.name,
      definition,
      rows,
      secretKey: first === undefined ? undefined : typeof first === 'string' ? first : first.key,
    };
  });
}

/** The shape of the part of `configuration.json` this module reads: the edits to the catalog's rows. */
export type ProviderConfigurationFile = {
  /** The edits to the catalog's rows. Absent means none. */
  readonly catalog?: readonly CatalogEdit[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * Parse the contents of `configuration.json`. Keys outside `catalog` are ignored, because the file
 * is Bungalow's and other parts of the application may add their own, a `providers` key among
 * them. Everything inside `catalog` is checked, so a misspelled field fails startup instead of
 * quietly changing nothing. When `providerNames` is given, an edit may name only those providers.
 */
export function parseProviderConfiguration(
  text: string,
  path: string,
  providerNames?: readonly string[],
): ProviderConfigurationFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderConfigurationError(path, 'the file', 'it is not valid JSON.');
  }
  if (!isPlainObject(parsed)) {
    throw new ProviderConfigurationError(path, 'the file', 'expected a JSON object.');
  }
  return parsed['catalog'] === undefined
    ? {}
    : { catalog: parseCatalogEdits(parsed['catalog'], path, providerNames) };
}

/**
 * The allowlists of the plugins named in `plugins`, from the parsed configuration document: each
 * plugin's `plugins.<name>.configuration.models`, checked. A plugin with none offers every model.
 * Only the plugins named are read, so a malformed entry for a plugin the host does not load is the
 * plugin manager's to report, not a reason to stop the host.
 */
export function readAllowlists(
  document: Record<string, unknown>,
  path: string,
  plugins: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  const allowlists = new Map<string, readonly string[]>();
  const declared = document['plugins'];
  if (!isPlainObject(declared)) return allowlists;
  for (const plugin of plugins) {
    if (!Object.hasOwn(declared, plugin)) continue;
    const entry = declared[plugin];
    if (!isPlainObject(entry) || !isPlainObject(entry['configuration'])) continue;
    const models = entry['configuration']['models'];
    if (models === undefined) continue;
    allowlists.set(plugin, parseModels(models, path, `plugins.${plugin}.configuration.models`));
  }
  return allowlists;
}

/** The configuration document as an object, or why it cannot be read. */
export function parseDocument(text: string | undefined, path: string): Record<string, unknown> {
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderConfigurationError(path, 'the file', 'it is not valid JSON.');
  }
  if (!isPlainObject(parsed)) {
    throw new ProviderConfigurationError(path, 'the file', 'expected a JSON object.');
  }
  return parsed;
}

function matchesEntry(row: BackendDescriptor, entry: string): boolean {
  return row.model === entry || row.aliases.some((alias) => alias.alias === entry);
}

/** The rows of `provider` an allowlist may name: every one that is not retired. */
function liveRows(provider: { readonly rows: readonly BackendDescriptor[] }) {
  return provider.rows.filter((row) => row.lifecycle !== 'retired');
}

/** Why an allowlist entry is refused. The entry's value is not repeated: it may be a secret. */
export function allowlistMissMessage(owned: readonly { readonly name: string }[]): string {
  return `the entry matches no current ${owned.map((provider) => provider.name).join(' or ')} model. Its value is not repeated here, because it may be a secret.`;
}

/**
 * The indexes of the entries of one plugin's allowlist that name no model: no non-retired row of
 * the providers `owned` by the plugin, and no row the `catalog` edits add to them. The one rule
 * the catalog load, the plugin route and plugin composition all apply.
 */
export function unmatchedAllowlistEntries(
  owned: readonly {
    readonly name: string;
    readonly rows: readonly BackendDescriptor[];
  }[],
  allowlist: readonly string[],
  edits: readonly CatalogEdit[],
): readonly number[] {
  const misses: number[] = [];
  allowlist.forEach((model, index) => {
    // The allowlist may name a row the `catalog` list adds, which has no built-in match.
    const addedByEdit = edits.some(
      (edit) =>
        edit.model === model &&
        owned.some((provider) => provider.name === edit.provider) &&
        !owned.some((provider) => liveRows(provider).some((row) => matchesEntry(row, edit.model))),
    );
    const matches = owned.some((provider) =>
      liveRows(provider).some((row) => matchesEntry(row, model)),
    );
    if (!matches && !addedByEdit) misses.push(index);
  });
  return misses;
}

/**
 * The catalog rows for the contributed providers. A row is kept when its provider has a key
 * (`available`), it is not retired, and its plugin's allowlist, when it has one, names it. An
 * allowlist entry that names no non-retired row of the plugin fails, whether or not the provider
 * has a key, so a stale entry does not wait for the key to appear. The `catalog` edits apply last,
 * and a stale one fails the same way; an edit that names a provider no loaded plugin contributes
 * waits, ignored, for its plugin.
 */
export function selectCatalogRows(input: {
  readonly configuration: ProviderConfigurationFile;
  /** The allowlist of each plugin that has one, by plugin name. */
  readonly allowlists: ReadonlyMap<string, readonly string[]>;
  readonly path: string;
  /** The providers that have a key, by name. */
  readonly available: ReadonlySet<string>;
  readonly providers: readonly ContributedProvider[];
}): BackendDescriptor[] {
  const live = (provider: ContributedProvider): readonly BackendDescriptor[] =>
    provider.rows.filter((row) => row.lifecycle !== 'retired');
  const edits = (input.configuration.catalog ?? []).filter((edit) =>
    input.providers.some((provider) => provider.name === edit.provider),
  );
  const selected: BackendDescriptor[] = [];
  for (const plugin of new Set(input.providers.map((provider) => provider.plugin))) {
    const entry = input.allowlists.get(plugin);
    const owned = input.providers.filter((provider) => provider.plugin === plugin);
    const named = new Set<BackendDescriptor>();
    const misses = entry === undefined ? [] : unmatchedAllowlistEntries(owned, entry, edits);
    if (misses[0] !== undefined) {
      throw new ProviderConfigurationError(
        input.path,
        `plugins.${plugin}.configuration.models[${misses[0]}]`,
        allowlistMissMessage(owned),
      );
    }
    for (const model of entry ?? []) {
      for (const provider of owned) {
        for (const row of live(provider)) if (matchesEntry(row, model)) named.add(row);
      }
    }
    for (const provider of owned) {
      if (!input.available.has(provider.name)) continue;
      selected.push(
        ...(entry === undefined ? live(provider) : live(provider).filter((row) => named.has(row))),
      );
    }
  }
  if (edits.length === 0) return selected;
  const providerOf = (name: string): ContributedProvider | undefined =>
    input.providers.find((provider) => provider.name === name);
  return applyCatalogEdits({
    edits,
    path: input.path,
    selected,
    available: input.available,
    candidates: (name) => {
      const provider = providerOf(name);
      return provider === undefined ? [] : live(provider);
    },
    matches: matchesEntry,
    keepsAdded: (name, model) => {
      const provider = providerOf(name);
      const models = provider === undefined ? undefined : input.allowlists.get(provider.plugin);
      return models === undefined || models.includes(model);
    },
  });
}

/** What the host offers: the rows to install and the key each offered provider is called with. */
export type LoadedProviders = {
  /** Every provider the loaded plugins contribute, whether or not it has a key. */
  readonly providers: readonly ContributedProvider[];
  /** The allowlist of each plugin that has one, by plugin name. */
  readonly allowlists: ReadonlyMap<string, readonly string[]>;
  readonly rows: readonly BackendDescriptor[];
  readonly apiKeys: ReadonlyMap<string, string>;
};

/**
 * Read the configuration and each contributed provider's secret. A provider with no secret is
 * omitted; when its plugin has an allowlist, one warning names the provider and the secret it
 * expects, never a value. The warnings come after validation, so a start that fails reports the
 * failure and nothing else.
 */
export async function loadProviders(input: {
  /** Where the configuration lives, named in every message about it. */
  readonly configurationLocation: string;
  /** The configuration's text, or `undefined` when none exists: Bungalow's `readConfiguration`. */
  readonly readConfiguration: () => Promise<string | undefined>;
  readonly readSecret: (key: string) => string | undefined;
  readonly warn: (message: string) => void;
  /** The providers the loaded plugins contribute. */
  readonly providers: readonly ContributedProvider[];
}): Promise<LoadedProviders> {
  let text: string | undefined;
  try {
    text = await input.readConfiguration();
  } catch {
    throw new ProviderConfigurationError(
      input.configurationLocation,
      'the file',
      'it could not be read.',
    );
  }
  const document = parseDocument(text, input.configurationLocation);
  const configuration = parseProviderConfiguration(
    JSON.stringify(document),
    input.configurationLocation,
  );
  const allowlists = readAllowlists(
    document,
    input.configurationLocation,
    input.providers.map((provider) => provider.plugin),
  );
  const apiKeys = new Map<string, string>();
  const missing: ContributedProvider[] = [];
  for (const provider of input.providers) {
    const key =
      provider.secretKey === undefined ? undefined : input.readSecret(provider.secretKey)?.trim();
    if (key === undefined || key === '') missing.push(provider);
    else apiKeys.set(provider.name, key);
  }
  const rows = selectCatalogRows({
    configuration,
    allowlists,
    path: input.configurationLocation,
    available: new Set(apiKeys.keys()),
    providers: input.providers,
  });
  for (const provider of missing) {
    if (!allowlists.has(provider.plugin) || provider.secretKey === undefined) continue;
    input.warn(
      `The ${provider.name} provider has an allowlist in ${input.configurationLocation} but the secret "${provider.secretKey}" is not set, so it is not offered.`,
    );
  }
  return { providers: input.providers, allowlists, rows, apiKeys };
}

/** A catalog model, named by its provider and either its model or an alias. */
export type ModelSelection = {
  readonly provider: string;
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
    readonly apiKeys: ReadonlyMap<string, string>;
    readonly providers: readonly ContributedProvider[];
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
  if (row.availability === 'unavailable') {
    throw new Error(
      `The "${selection.model}" model of the ${selection.provider} provider is turned off in the model catalog.`,
    );
  }
  return dependencies.resolveProviderGenerate(
    dependencies.providers.map((provider) => provider.definition),
    { provider: selection.provider, model: row.model, apiKey },
    undefined,
    undefined,
  );
}
