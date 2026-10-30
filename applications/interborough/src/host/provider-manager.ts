/**
 * The host's model providers while it runs: what it offers now, and the three ways a person
 * changes it without a restart. {@link ProviderManager.connect} stores a provider's API key and
 * lists the provider in `configuration.json`, {@link ProviderManager.editCatalog} replaces the
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
  parseProviderConfiguration,
  PROVIDER_NAMES,
  PROVIDER_SECRET_KEYS,
  selectCatalogRows,
  type InterboroughProviderName,
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
  readonly provider: InterboroughProviderName;
  /** Whether the host is calling the provider with the stored key, as the host loaded it. */
  readonly inUse: boolean;

  constructor(provider: InterboroughProviderName, inUse: boolean) {
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
  /** The provider's name: `anthropic`, `openai`, or `gemini`. */
  readonly provider: string;
  /**
   * The API key, a string. Stored in the provider's 0600 secret file, and never returned, logged,
   * or put in an error. Typed `unknown` because it arrives from a request body: the manager checks it.
   */
  readonly apiKey: unknown;
  /**
   * An allowlist of models, a list of names. Absent keeps the provider's current allowlist (none
   * for a new provider), and `null` removes it so every model is offered. Checked like a hand edit.
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
  readonly name: InterboroughProviderName;
  /** Whether `configuration.json` lists the provider. */
  readonly configured: boolean;
  /** Whether the provider has a key. The key itself is never reported. */
  readonly hasKey: boolean;
  /** The provider's allowlist, when it has one. */
  readonly models?: readonly string[];
};

/** The provider configuration as the host holds it, without a key. */
export type ProviderSnapshot = {
  /** Every provider the host can call, connected or not. */
  readonly providers: readonly ProviderStatus[];
  /** The catalog edits in `configuration.json`. */
  readonly catalog: readonly CatalogEdit[];
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
  /** Receives warnings, such as a configured provider with no key. They never hold a key. */
  readonly warn: (message: string) => void;
  /** Bureau's provider resolver, or a stand-in for a test. */
  readonly resolveProviderGenerate: typeof resolveProviderGenerate;
};

function isProviderName(value: string): value is InterboroughProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

function checkedProvider(value: unknown): InterboroughProviderName {
  if (typeof value !== 'string' || !isProviderName(value)) {
    throw new ProviderInputError(
      'provider',
      `not a provider. Expected ${PROVIDER_NAMES.join(', ')}.`,
    );
  }
  return value;
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

/** Create the manager. It holds nothing until {@link ProviderManager.attach} and an initial load. */
export async function createProviderManager(
  options: ProviderManagerOptions,
): Promise<ProviderManager> {
  const { bungalow } = options;
  const location = bungalow.configurationLocation;
  const load = (): Promise<LoadedProviders> =>
    loadProviders({
      configurationLocation: location,
      readConfiguration: () => bungalow.readConfiguration(),
      readSecret: (key) => bungalow.readSecret(key),
      warn: options.warn,
    });

  let loaded = await load();
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
    if (text === undefined) return {};
    // Parsed first as the host reads it, so a file that is already invalid is refused, not overwritten.
    parseProviderConfiguration(text, location);
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : {};
  }

  /** Check a document against the keys the host would hold, then write it. Nothing is written when it fails. */
  function validated(
    document: Record<string, unknown>,
    keys: ReadonlySet<InterboroughProviderName>,
  ): string {
    const text = `${JSON.stringify(document, null, 2)}\n`;
    const configuration = parseProviderConfiguration(text, location);
    selectCatalogRows({ configuration, path: location, available: keys });
    return text;
  }

  const apply = async (): Promise<ProviderChange> => {
    // Read back from disk, so the host serves what a restart would.
    const next = await load();
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
        resolveProviderGenerate: options.resolveProviderGenerate,
      }),
    attach(replace) {
      replaceRows = replace;
    },
    close() {
      closed = true;
    },
    async snapshot() {
      const document = await readDocument();
      const configuration = parseProviderConfiguration(JSON.stringify(document), location);
      const reason = lockReason();
      return {
        providers: PROVIDER_NAMES.map((name) => {
          const entry = configuration.providers[name];
          return {
            name,
            configured: entry !== undefined,
            hasKey: loaded.apiKeys.has(name),
            ...(entry?.models === undefined ? {} : { models: entry.models }),
          };
        }),
        catalog: configuration.catalog ?? [],
        ...(reason === undefined ? {} : { lockReason: reason }),
      };
    },
    // The request is read, checked, and copied before the first `await`: the caller owns it, and
    // may change it while this waits its turn.
    async connect(connection) {
      assertWritable();
      const provider = checkedProvider(connection.provider);
      const key = checkedKey(connection.apiKey);
      const models: unknown = Array.isArray(connection.models)
        ? [...connection.models]
        : connection.models;
      return serialized(async () => {
        const document = await readDocument();
        const providers = isPlainObject(document['providers']) ? document['providers'] : {};
        const existing = providers[provider];
        const entry = isPlainObject(existing) ? { ...existing } : {};
        if (models === null) delete entry['models'];
        else if (models !== undefined) entry['models'] = models;
        const text = validated(
          { ...document, providers: { ...providers, [provider]: entry } },
          new Set([...loaded.apiKeys.keys(), provider]),
        );
        const secretKey = PROVIDER_SECRET_KEYS[provider];
        const previousKey = bungalow.readSecret(secretKey);
        // Set only once the new key is on the disk, so a failure of that very write is not
        // mistaken for one that needs undoing.
        let keyWritten = false;
        try {
          bungalow.writeSecret(secretKey, key);
          keyWritten = true;
          bungalow.writeConfiguration(text);
        } catch (error) {
          // Nothing was written: the disk and the host are as they were.
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
        return apply();
      });
    },
    async editCatalog(edits) {
      assertWritable();
      const parsed = parseCatalogEdits(edits, location, PROVIDER_NAMES);
      return serialized(async () => {
        const { catalog: _replaced, ...rest } = await readDocument();
        const text = validated(
          parsed.length === 0 ? rest : { ...rest, catalog: parsed },
          new Set(loaded.apiKeys.keys()),
        );
        bungalow.writeConfiguration(text);
        return apply();
      });
    },
    reload: () => serialized(apply),
  };
}
