/**
 * The host's model providers while it runs: what it offers now, and the three ways a person
 * changes it without a restart. {@link ProviderManager.connect} stores a provider's API key and its
 * allowlist (`plugins.<plugin>.configuration.models` in `configuration.json`),
 * {@link ProviderManager.editCatalog} replaces the
 * catalog edits there, and {@link ProviderManager.reload} reads both files again, for a person who
 * edited them by hand. Each ends the same way: the files are read back, the rows become the
 * Bureau's catalog (`bureau.models.replace`), and the next generate resolves with the new key.
 *
 * - **Validated before written.** A change is checked against the current keys before any byte is
 *   written, so a request cannot leave a configuration the next start refuses.
 * - **Local only.** A remote home keeps its configuration in a bucket and its secrets in the
 *   environment, which the host cannot write, so a write there is refused with the lock reason
 *   `deployment` ({@link ProviderWriteLockedError}).
 * - **No secret leaves.** An error names the field, never the value, and nothing here returns,
 *   logs, or audits a key.
 * - **In-flight runs keep what they started with.** A generate captures the key it was resolved
 *   with, so a run that began before a change finishes with the provider it began with, and a run
 *   that begins after it resolves the new one.
 *
 * @module provider-manager
 */

import type { Bungalow } from '@lostgradient/bungalow';
import type { resolveProviderGenerate, SettingLockReason } from '@lostgradient/bureau';
import type { BackendDescriptor, GenerateFunction } from '@lostgradient/operative';

import { parseCatalogEdits, type CatalogEdit } from './catalog-edits.ts';
import { createConfigurationQueue, type ConfigurationQueue } from './configuration-queue.ts';
import type { HostProviderDiagnostics } from './host-diagnostics.ts';
import { providerDiagnostics } from './host-diagnostics.ts';
import { hostWriteLocks } from './locations.ts';
import { ProviderConfigurationError } from './provider-configuration-error.ts';
import {
  createCatalogGenerate,
  loadProviders,
  parseDocument,
  parseProviderConfiguration,
  readAllowlists,
  selectCatalogRows,
  type ContributedProvider,
  type LoadedProviders,
  type ModelSelection,
} from './providers.ts';

/** The longest API key the host stores. Real keys are far shorter; the limit bounds a request. */
const MAXIMUM_KEY_LENGTH = 4096;

/** A write the home does not allow: the reason is the one `settings.get` reports for a locked key. */
export class ProviderWriteLockedError extends Error {
  /** Why the write is refused. A remote home is `deployment`: the deployment, not the host, holds the files. */
  readonly reason: SettingLockReason;

  constructor(reason: SettingLockReason) {
    super(
      'This host runs on remote storage, where the provider configuration and keys belong to the deployment. Change them there; the host cannot write them.',
    );
    this.name = 'ProviderWriteLockedError';
    this.reason = reason;
  }
}

/**
 * A change that stored a provider's new key but could not write the configuration, and could not
 * put the old key back. `inUse` is what the host actually loaded afterwards: a rotation of a
 * configured provider uses the new key, while a new provider whose configuration was not written
 * is not loaded, so its stored key is not used. The message says which and names no value.
 */
export class ProviderPartialChangeError extends Error {
  /** The provider whose key was stored. */
  readonly provider: string;
  /** Whether the host is calling the provider with the stored key, as the host loaded it. */
  readonly inUse: boolean;

  constructor(provider: string, inUse: boolean) {
    super(
      inUse
        ? `The ${provider} key was stored and is in use, but the configuration could not be written and the previous key could not be put back.`
        : `The ${provider} key was stored but is not in use, because the configuration could not be written, so the provider is not configured. The previous key could not be put back.`,
    );
    this.name = 'ProviderPartialChangeError';
    this.provider = provider;
    this.inUse = inUse;
  }
}

/** A request the host cannot act on. The message names the field and never repeats its value. */
export class ProviderInputError extends Error {
  /** The field of the request that cannot be used. */
  readonly field: string;

  constructor(field: string, problem: string) {
    super(`Invalid ${field}: ${problem}`);
    this.name = 'ProviderInputError';
    this.field = field;
  }
}

/** What a provider connection asks for. */
export type ProviderConnection = {
  /** The name of a provider a loaded plugin contributes, such as `anthropic`. */
  readonly provider: string;
  /**
   * The API key, a string. Stored in the provider's 0600 secret file, and never returned, logged,
   * or put in an error. Typed `unknown` because it arrives from a request body: the manager checks it.
   */
  readonly apiKey: unknown;
  /**
   * An allowlist of models, a list of names, stored as the plugin's `configuration.models`. Absent
   * keeps the current allowlist (none for a new provider), and `null` removes it so every model is
   * offered. Checked like a hand edit.
   */
  readonly models?: unknown;
};

/** What the host reports after a change: the providers it now offers and the catalog's revision. */
export type ProviderChange = {
  /** The providers the host holds a key for, each with its models. */
  readonly providers: readonly HostProviderDiagnostics[];
  /** The Bureau's model catalog revision after the change. */
  readonly catalogRevision: number;
};

/** One provider as the configuration describes it, for a page that lets a person manage it. */
export type ProviderStatus = {
  /** The provider's name. */
  readonly name: string;
  /** Whether the owner has set the provider up: it has a key, or its plugin has an allowlist. */
  readonly configured: boolean;
  /** Whether the provider has a key. The key itself is never reported. */
  readonly hasKey: boolean;
  /** The provider's allowlist, when it has one. */
  readonly models?: readonly string[];
};

/**
 * One model of the catalog as a page lists it: what a person needs to decide whether to keep it on.
 * Built from the rows the host serves now, so an edit that turned a model off shows as `off`.
 */
export type ProviderModelRow = {
  /** The row's provider. */
  readonly provider: string;
  /** The provider-native model name. */
  readonly model: string;
  /** The other names that reach the row, which a catalog edit may use instead of `model`. */
  readonly aliases: readonly string[];
  /** The context window, in tokens. */
  readonly contextWindowTokens: number;
  /** The largest answer, in tokens. */
  readonly maxOutputTokens: number;
  /** Whether the model streams its answer. */
  readonly streaming: boolean;
  /** Whether the model calls tools. */
  readonly tools: boolean;
  /** Whether the model can answer to a schema. */
  readonly structuredOutput: boolean;
  /** Whether the model takes images. */
  readonly images: boolean;
  /** The price per million tokens, when the catalog has one. */
  readonly pricing?: {
    readonly inputPerMillionTokens: number;
    readonly outputPerMillionTokens: number;
    readonly currency: string;
  };
  /** Whether a catalog edit turned the model off, which keeps it from agents and plans. */
  readonly off: boolean;
};

/** The provider configuration as the host holds it, without a key. */
export type ProviderSnapshot = {
  /** Every provider the host can call, connected or not. */
  readonly providers: readonly ProviderStatus[];
  /** The catalog edits in `configuration.json`. */
  readonly catalog: readonly CatalogEdit[];
  /** Every model the host's catalog offers now, in catalog order. */
  readonly models: readonly ProviderModelRow[];
  /** Present when writes are refused, with the reason. */
  readonly lockReason?: SettingLockReason;
};

/** The providers a running host offers and how they change. See the module comment. */
export type ProviderManager = {
  /** What the host offers now. Read it at the moment of use, not once: a change replaces it. */
  current(): LoadedProviders;
  /** The generate for a catalog model, resolved with the key held now. A run keeps the one it was given. */
  generateFor(selection: ModelSelection): GenerateFunction;
  /** Why writes are refused, or `undefined` when they are allowed. */
  lockReason(): SettingLockReason | undefined;
  /** The configuration as it is on disk, without a key. */
  snapshot(): Promise<ProviderSnapshot>;
  /** Store a provider's key, list it in the configuration, and apply both. */
  connect(connection: ProviderConnection): Promise<ProviderChange>;
  /** Replace the catalog edits in the configuration and apply them. */
  editCatalog(edits: unknown): Promise<ProviderChange>;
  /** Read the configuration and the keys again and apply them. */
  reload(): Promise<ProviderChange>;
  /**
   * Check that `configuration` could be stored as `plugin`'s choices (its allowlist matches the
   * plugin's models, counting the rows the catalog edits add), and throw what the next start would
   * throw. Writes nothing.
   */
  checkAllowlist(plugin: string, configuration: unknown): Promise<void>;
  /**
   * Hand the manager the providers the loaded plugins contribute and load them: the rows for the
   * Bureau's first catalog. The host calls it from Bureau's `models.catalog` factory, once.
   */
  adopt(providers: readonly ContributedProvider[]): Promise<readonly BackendDescriptor[]>;
  /** The queue this manager writes the configuration through, for other writers of the file to share. */
  readonly configurationQueue: ConfigurationQueue;
  /**
   * Hand the manager the function that installs rows in the Bureau and resolves, with the
   * catalog's new revision, once the agents built from them are rebuilt. Call it once, before any change.
   */
  attach(replaceRows: (rows: readonly BackendDescriptor[]) => Promise<number>): void;
  /** Refuse every later change. The host calls it as it shuts down. */
  close(): void;
};

/** What {@link createProviderManager} reads. */
export type ProviderManagerOptions = {
  /** The open home. Its mode decides whether a write is allowed. */
  readonly bungalow: Pick<
    Bungalow,
    | 'mode'
    | 'configurationLocation'
    | 'readConfiguration'
    | 'writeConfiguration'
    | 'readSecret'
    | 'writeSecret'
  >;
  /** The queue every writer of `configuration.json` shares. Defaults to a new one. */
  readonly configurationQueue?: ConfigurationQueue;
  /**
   * Called after the manager writes a plugin's configuration, so the plugin manager reads the file
   * again and reports what is stored. Optional.
   */
  readonly afterConfigurationWrite?: () => Promise<void>;
  /** Receives warnings, such as a provider with an allowlist and no key. They never hold a key. */
  readonly warn: (message: string) => void;
  /** Bureau's provider resolver, or a stand-in for a test. */
  readonly resolveProviderGenerate: typeof resolveProviderGenerate;
};

/** The page's view of a catalog row. */
function modelRowOf(row: BackendDescriptor): ProviderModelRow {
  return {
    provider: row.provider,
    model: row.model,
    aliases: row.aliases.map((entry) => entry.alias),
    contextWindowTokens: row.contextWindowTokens,
    maxOutputTokens: row.maxOutputTokens,
    streaming: row.streaming,
    tools: row.tools,
    structuredOutput: row.structuredOutput,
    images: row.modalities.image.input,
    ...(row.pricing === undefined
      ? {}
      : {
          pricing: {
            inputPerMillionTokens: row.pricing.inputPerMillionTokens,
            outputPerMillionTokens: row.pricing.outputPerMillionTokens,
            currency: row.pricing.currency,
          },
        }),
    off: row.availability === 'unavailable',
  };
}

function checkedProvider(
  value: unknown,
  providers: readonly ContributedProvider[],
): ContributedProvider {
  const found =
    typeof value === 'string' ? providers.find((provider) => provider.name === value) : undefined;
  if (found === undefined) {
    throw new ProviderInputError(
      'provider',
      `not a provider. Expected ${providers.map((provider) => provider.name).join(', ')}.`,
    );
  }
  return found;
}

function checkedKey(value: unknown): string {
  if (typeof value !== 'string') throw new ProviderInputError('apiKey', 'expected text.');
  const key = value.trim();
  if (key === '') throw new ProviderInputError('apiKey', 'expected a key, and it is empty.');
  if (key.length > MAXIMUM_KEY_LENGTH) {
    throw new ProviderInputError('apiKey', `longer than ${MAXIMUM_KEY_LENGTH} characters.`);
  }
  // eslint-disable-next-line no-control-regex -- a control character is what this refuses.
  if (/[\u0000-\u001f\u007f]/.test(key)) {
    throw new ProviderInputError('apiKey', 'contains a line break or another control character.');
  }
  return key;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `document` with the allowlist of `plugin` set to `models` (`plugins.<plugin>.configuration.models`),
 * keeping every other key of the plugin's entry and of its configuration. `undefined` changes
 * nothing, and `null` removes the allowlist. A removal that leaves nothing behind leaves no entry.
 */
function withAllowlist(
  document: Record<string, unknown>,
  plugin: string,
  models: unknown,
): Record<string, unknown> {
  if (models === undefined) return document;
  const plugins = isPlainObject(document['plugins']) ? document['plugins'] : {};
  const existing = Object.hasOwn(plugins, plugin) ? plugins[plugin] : undefined;
  const entry = isPlainObject(existing) ? { ...existing } : {};
  const configuration = isPlainObject(entry['configuration']) ? { ...entry['configuration'] } : {};
  if (models === null) delete configuration['models'];
  else configuration['models'] = models;
  if (Object.keys(configuration).length === 0) delete entry['configuration'];
  else entry['configuration'] = configuration;
  if (existing === undefined && Object.keys(entry).length === 0) return document;
  return { ...document, plugins: { ...plugins, [plugin]: entry } };
}

/** Create the manager. It holds nothing until {@link ProviderManager.adopt} hands it the providers. */
export function createProviderManager(options: ProviderManagerOptions): ProviderManager {
  const { bungalow } = options;
  const location = bungalow.configurationLocation;
  const load = (providers: readonly ContributedProvider[]): Promise<LoadedProviders> =>
    loadProviders({
      configurationLocation: location,
      readConfiguration: () => bungalow.readConfiguration(),
      readSecret: (key) => bungalow.readSecret(key),
      warn: options.warn,
      providers,
    });

  // Nothing is offered until the plugins have been set up and `adopt` hands over their providers.
  let loaded: LoadedProviders = {
    providers: [],
    allowlists: new Map(),
    rows: [],
    apiKeys: new Map(),
  };
  let replaceRows: ((rows: readonly BackendDescriptor[]) => Promise<number>) | undefined;
  let closed = false;
  // Every change reads the files, decides, writes, and reads again. Running them one at a time
  // keeps a second change from deciding on text the first is about to replace. The queue is shared
  // with any other writer of the file.
  const configurationQueue = options.configurationQueue ?? createConfigurationQueue();
  const serialized = <Result>(work: () => Promise<Result>): Promise<Result> =>
    configurationQueue.run(() => {
      if (closed) throw new Error('The host is shutting down.');
      return work();
    });

  const lockReason = (): SettingLockReason | undefined => hostWriteLocks(bungalow).configuration;
  const assertWritable = (): void => {
    const reason = lockReason();
    if (reason !== undefined) throw new ProviderWriteLockedError(reason);
  };

  /** The configuration as an object whose other keys a write keeps, or `{}` when none exists. */
  async function readDocument(): Promise<Record<string, unknown>> {
    let text: string | undefined;
    try {
      text = await bungalow.readConfiguration();
    } catch {
      throw new ProviderConfigurationError(location, 'the file', 'it could not be read.');
    }
    // Parsed first as the host reads it, so a file that is already invalid is refused, not overwritten.
    const document = parseDocument(text, location);
    if (text !== undefined) parseProviderConfiguration(text, location);
    return document;
  }

  /** Check a document against the keys the host would hold, then write it. Nothing is written when it fails. */
  function validated(document: Record<string, unknown>, keys: ReadonlySet<string>): string {
    const text = `${JSON.stringify(document, null, 2)}\n`;
    // The stored edits are read as `loadProviders` reads them: an edit for a provider no loaded
    // plugin contributes waits, ignored, for its plugin. A new edit was checked against the names
    // when it arrived.
    const configuration = parseProviderConfiguration(text, location);
    selectCatalogRows({
      configuration,
      allowlists: readAllowlists(
        document,
        location,
        loaded.providers.map((provider) => provider.plugin),
      ),
      path: location,
      available: keys,
      providers: loaded.providers,
    });
    return text;
  }

  const apply = async (): Promise<ProviderChange> => {
    // Read back from disk, so the host serves what a restart would.
    const next = await load(loaded.providers);
    loaded = next;
    if (replaceRows === undefined) throw new Error('The provider manager is not attached.');
    const catalog = await replaceRows(next.rows);
    return { providers: providerDiagnostics(next), catalogRevision: catalog };
  };

  return {
    current: () => loaded,
    configurationQueue,
    lockReason,
    generateFor: (selection) =>
      createCatalogGenerate(selection, {
        rows: loaded.rows,
        apiKeys: loaded.apiKeys,
        providers: loaded.providers,
        resolveProviderGenerate: options.resolveProviderGenerate,
      }),
    async adopt(providers) {
      loaded = await load([...providers]);
      return loaded.rows;
    },
    attach(replace) {
      replaceRows = replace;
    },
    close() {
      closed = true;
    },
    async snapshot() {
      const document = await readDocument();
      const configuration = parseProviderConfiguration(JSON.stringify(document), location);
      const allowlists = readAllowlists(
        document,
        location,
        loaded.providers.map((provider) => provider.plugin),
      );
      const reason = lockReason();
      return {
        providers: loaded.providers.map((provider) => {
          const models = allowlists.get(provider.plugin);
          const hasKey = loaded.apiKeys.has(provider.name);
          return {
            name: provider.name,
            configured: hasKey || models !== undefined,
            hasKey,
            ...(models === undefined ? {} : { models }),
          };
        }),
        catalog: (configuration.catalog ?? []).filter((edit) =>
          loaded.providers.some((provider) => provider.name === edit.provider),
        ),
        models: loaded.rows.map(modelRowOf),
        ...(reason === undefined ? {} : { lockReason: reason }),
      };
    },
    // The request is read, checked, and copied before the first `await`: the caller owns it, and
    // may change it while this waits its turn.
    async connect(connection) {
      assertWritable();
      const contributed = checkedProvider(connection.provider, loaded.providers);
      const provider = contributed.name;
      const secretKey = contributed.secretKey;
      if (secretKey === undefined) {
        throw new ProviderInputError('provider', 'its plugin declares no secret to hold a key.');
      }
      const key = checkedKey(connection.apiKey);
      const models: unknown = Array.isArray(connection.models)
        ? [...connection.models]
        : connection.models;
      return serialized(async () => {
        const document = await readDocument();
        const text = validated(
          withAllowlist(document, contributed.plugin, models),
          new Set([...loaded.apiKeys.keys(), provider]),
        );
        const previousKey = bungalow.readSecret(secretKey);
        // True once the new key is on the disk. A write that throws may still have replaced the
        // file (Bungalow renames it, then syncs the directory), so a throw is checked against the
        // disk and not taken to mean that nothing changed.
        let keyWritten = false;
        try {
          try {
            bungalow.writeSecret(secretKey, key);
            keyWritten = true;
          } catch (error) {
            let onDisk: string | undefined;
            let known = true;
            try {
              onDisk = bungalow.readSecret(secretKey);
            } catch {
              known = false;
            }
            if (onDisk === key) keyWritten = true;
            else {
              // The key is not there, or cannot be told. Read the disk back so the host serves
              // what it holds, and report the failure.
              if (!known) await apply().catch(() => undefined);
              throw error;
            }
          }
          bungalow.writeConfiguration(text);
        } catch (error) {
          if (!keyWritten) throw error;
          // The key went first. Put the old one back (an empty value reads as no key), so a change
          // that did not happen leaves the host on the key it had.
          let restored = true;
          try {
            bungalow.writeSecret(secretKey, previousKey ?? '');
          } catch {
            restored = false;
          }
          // Whatever is on the disk now is what the host should serve.
          await apply().catch(() => undefined);
          if (!restored) {
            throw new ProviderPartialChangeError(provider, loaded.apiKeys.get(provider) === key);
          }
          throw error;
        }
        // The plugin manager reports what is stored, so it reads the file again; the write stands
        // either way.
        await options.afterConfigurationWrite?.().catch(() => undefined);
        return apply();
      });
    },
    async editCatalog(edits) {
      assertWritable();
      const parsed = parseCatalogEdits(
        edits,
        location,
        loaded.providers.map((provider) => provider.name),
      );
      return serialized(async () => {
        const { catalog: stored, ...rest } = await readDocument();
        // An edit for a provider no loaded plugin contributes is not the caller's to replace: it
        // waits in the file for its plugin, after the edits that replace the others.
        const names = new Set(loaded.providers.map((provider) => provider.name));
        const dormant = parseCatalogEdits(stored ?? [], location).filter(
          (edit) => !names.has(edit.provider),
        );
        const next = [...parsed, ...dormant];
        const text = validated(
          next.length === 0 ? rest : { ...rest, catalog: next },
          new Set(loaded.apiKeys.keys()),
        );
        bungalow.writeConfiguration(text);
        return apply();
      });
    },
    reload: () => serialized(apply),
    async checkAllowlist(plugin, configuration) {
      // Copied before the first `await`: the caller owns the request.
      const given: unknown = structuredClone(configuration);
      return serialized(async () => {
        const document = await readDocument();
        const plugins = isPlainObject(document['plugins']) ? document['plugins'] : {};
        const existing = Object.hasOwn(plugins, plugin) ? plugins[plugin] : undefined;
        const entry = isPlainObject(existing)
          ? { ...existing, configuration: given }
          : { configuration: given };
        validated(
          { ...document, plugins: { ...plugins, [plugin]: entry } },
          new Set(loaded.apiKeys.keys()),
        );
      });
    },
  };
}
