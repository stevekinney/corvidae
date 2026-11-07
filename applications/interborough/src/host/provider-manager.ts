import { secretPublicationDigest } from './secret-publication-digest.ts';
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
 * - **Conditional publication.** Credentials are prepared as immutable versions. A configuration
 *   CAS activates the reference and its allowlist together; failed or uncertain writes never
 *   restore an old credential over another writer. Backend capabilities decide writability.
 * - **No secret leaves.** An error names the field, never the value, and nothing here returns,
 *   logs, or audits a key.
 * - **A catalog save names what it started from.** {@link ProviderManager.editCatalog} may be given
 *   the edits the caller read before it changed them. Under the configuration queue they are
 *   compared with the edits stored now, and a mismatch is a {@link ProviderConflictError} that
 *   writes nothing, so a save never overwrites an edit made elsewhere since.
 * - **In-flight runs keep what they started with.** Each provider call resolves the committed key before
 *   dispatch. A call already in flight finishes with that key; the next call resolves current state.
 *
 * @module provider-manager
 */

import { createHash } from 'node:crypto';
import {
  createLocalHostMutationContext,
  HostMutationError,
  type HostMutationContext,
} from './host-mutation-context.ts';

import type { Bungalow, ConfigurationSnapshot } from '@lostgradient/bungalow';
import {
  type ProviderChecker,
  type resolveProviderGenerate,
  type SettingLockReason,
} from '@lostgradient/bureau';
import {
  readBackendDescriptors,
  withBackendDescriptors,
  type BackendDescriptor,
  type GenerateFunction,
} from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { Conversation } from 'conversationalist';

import { parseCatalogEdits, type CatalogEdit } from './catalog-edits.ts';
import { createConfigurationQueue, type ConfigurationQueue } from './configuration-queue.ts';
import type { HostProviderDiagnostics } from './host-diagnostics.ts';
import { providerDiagnostics } from './host-diagnostics.ts';
import { hostWriteLocks } from './locations.ts';
import { ProviderConfigurationError } from './provider-configuration-error.ts';
import {
  allowlistMissMessage,
  createCatalogGenerate,
  loadProviders,
  parseDocument,
  parseProviderConfiguration,
  readAllowlists,
  selectCatalogRows,
  unmatchedAllowlistEntries,
  type ContributedProvider,
  type LoadedProviders,
  type ModelSelection,
} from './providers.ts';
import {
  createWorkspaceSecrets,
  SecretPublicationError,
  type WorkspaceSecrets,
} from './workspace-secrets.ts';

/** How long a key test waits for the provider before it reports that it could not finish. */
const KEY_TEST_TIMEOUT_MILLISECONDS = 20_000;

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
 * A catalog save whose base is not what is stored now: another save, or a hand edit read by a
 * reload, changed the edits after the caller read them. Nothing was written. `catalog` is what is
 * stored now, so the caller can show it.
 */
export class ProviderConflictError extends Error {
  /** The catalog edits stored now, for the providers the host loaded. */
  readonly catalog: readonly CatalogEdit[];

  constructor(catalog: readonly CatalogEdit[]) {
    super('The model catalog changed after it was read, so nothing was saved.');
    this.name = 'ProviderConflictError';
    this.catalog = catalog;
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

/** What a provider's answer to a candidate key means for the person who pasted it. */
export type ProviderKeyTest =
  | {
      /** The provider accepted the key. */
      readonly ok: true;
      /** How many models the catalog would offer for the provider once the key is saved. */
      readonly models: number;
    }
  | {
      /** The provider refused the key, or the test could not finish. */
      readonly ok: false;
      /**
       * The HTTP status the provider answered with, when it answered: 401 for a key it does not
       * accept. Absent when the test could not reach the provider or timed out. Never a message,
       * because a provider's message may repeat part of the key.
       */
      readonly status?: number;
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
  readonly decisions?: {
    readonly kinds: readonly string[];
    readonly only: boolean;
  };
  /** Whether the model takes images. */
  readonly images: boolean;
  /** The price per million tokens, when the catalog has one. */
  readonly pricing?: {
    readonly inputPerMillionTokens: number;
    readonly outputPerMillionTokens: number;
    readonly currency: string;
    readonly cacheWritePerMillionTokens?: number;
    readonly cacheReadPerMillionTokens?: number;
    readonly longContext?: {
      readonly inputTokensAbove: number;
      readonly inputPerMillionTokens: number;
      readonly outputPerMillionTokens: number;
      readonly cacheWritePerMillionTokens?: number;
      readonly cacheReadPerMillionTokens?: number;
    };
  };
  /** Whether a catalog edit turned the model off, which keeps it from agents and plans. */
  readonly off: boolean;
};

/** The provider configuration as the host holds it, without a key. */
export type ProviderSnapshot = {
  /** Current storage revision for the next conditional edit. */
  readonly configurationRevision: string | null;
  /** Committed configuration revision most recently applied by this host. */
  readonly appliedConfigurationRevision: string | null;
  /** Every provider the host can call, connected or not. */
  readonly providers: readonly ProviderStatus[];
  /** The catalog edits in `configuration.json`. */
  readonly catalog: readonly CatalogEdit[];
  /** Every model the host's catalog offers now, in catalog order. */
  readonly models: readonly ProviderModelRow[];
  /** Present when writes are refused, with the reason. */
  readonly lockReason?: SettingLockReason;
  /** Present when configuration may be writable but credential publication is unavailable. */
  readonly credentialLockReason?: SettingLockReason;
};

/** The providers a running host offers and how they change. See the module comment. */
export type ProviderManager = {
  /** What the host offers now. Read it at the moment of use, not once: a change replaces it. */
  current(): LoadedProviders;
  /** The generate for a catalog model, resolved with the key held now. Each call resolves current committed credentials; an admitted call keeps its credential. */
  generateFor(selection: ModelSelection): GenerateFunction;
  /** Why writes are refused, or `undefined` when they are allowed. */
  lockReason(): SettingLockReason | undefined;
  /** The configuration as it is on disk, without a key. */
  snapshot(): Promise<ProviderSnapshot>;
  /** Store a provider's key, list it in the configuration, and apply both. */
  connect(connection: ProviderConnection, mutation?: HostMutationContext): Promise<ProviderChange>;
  /**
   * Ask the provider whether it accepts `apiKey`, without storing it or changing what the host
   * serves: one request of one token, made with the candidate key. A refused key is an answer
   * ({@link ProviderKeyTest} with `ok: false`), not an error; only a request that cannot be used
   * is refused with a {@link ProviderInputError}. The key lives in this call and nowhere else.
   * `signal` stops the request, which the caller does when the person cancels.
   */
  testKey(
    request: { readonly provider: unknown; readonly apiKey: unknown },
    signal?: AbortSignal,
  ): Promise<ProviderKeyTest>;
  /**
   * Replace the catalog edits in the configuration and apply them. `base` is the list of edits the
   * caller started from, as {@link ProviderManager.snapshot} reported it. When it is given, the
   * edits stored now must equal it, or nothing is written and the change is a
   * {@link ProviderConflictError}. Left out, the edits are replaced whatever is stored.
   */
  editCatalog(
    edits: unknown,
    base?: unknown,
    mutation?: HostMutationContext,
  ): Promise<ProviderChange>;
  /**
   * Remove a provider's key and apply it, so its models leave the catalog and a run that begins
   * after it cannot call the provider. The provider's allowlist and the catalog edits stay in the
   * configuration for a later connect. Connecting again restores it.
   */
  disconnect(provider: unknown, mutation?: HostMutationContext): Promise<ProviderChange>;
  /** Read the configuration and the keys again and apply them. */
  reload(): Promise<ProviderChange>;
  /**
   * Check that `document` could be written as `configuration.json`: its allowlists match the
   * loaded plugins' models, counting the rows its catalog edits add. It throws what the next start
   * would throw and writes nothing. It does not queue, so a caller already inside the
   * configuration queue can use it on the document it read there.
   */
  checkDocument(document: Record<string, unknown>): void;
  /**
   * What is wrong with a plugin's stored allowlist, seen against the providers it contributes, as
   * Bureau's `models.checkProviders` asks it before the plugin is accepted. A plugin with a
   * mismatched allowlist is skipped, so the host starts and the owner fixes it through the plugin
   * routes. Reads the catalog edits from the stored configuration; writes nothing.
   */
  checkProviders: ProviderChecker;
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
  /** Shared activation/recovery service for this host. */
  readonly workspaceSecrets?: WorkspaceSecrets;
  /** The open home. Its mode decides whether a write is allowed. */
  readonly bungalow: Pick<
    Bungalow,
    | 'mode'
    | 'configurationLocation'
    | 'readConfiguration'
    | 'writeConfiguration'
    | 'workspaceId'
    | 'secretProvider'
    | 'configurationWriteCapability'
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
  /**
   * Appends an entry to the Bureau's audit trail once a provider's key is removed (COR-2009): the
   * provider's name and nothing of its key. Optional; best effort, so a failed write never undoes
   * the removal.
   */
  readonly audit?: (entry: ProviderAuditEntry) => Promise<void>;
};

/** What {@link ProviderManagerOptions.audit} is handed for a provider configuration change. */
export type ProviderAuditEntry = {
  /** `provider:<name>`, the resource the entry is filed under. */
  readonly runId: string;
  /** The committed configuration change. */
  readonly type: 'provider.connected' | 'provider.configured' | 'provider.disconnected';
  /** The server-resolved resource owner who authorized this change. */
  readonly principal: string;
  /** Metadata only: never a key, request, or configuration value. */
  readonly detail: {
    readonly provider: string;
    readonly actorId?: string;
    readonly workspaceId?: string;
    readonly membershipRevision?: string;
    readonly outcome?: 'committed';
    readonly changedKeys?: readonly string[];
    readonly hash?: string;
    readonly previousRevision?: string | null;
  };
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
    ...(row.decisions === undefined ? {} : { decisions: row.decisions }),
    images: row.modalities.image.input,
    ...(row.pricing === undefined
      ? {}
      : {
          pricing: {
            inputPerMillionTokens: row.pricing.inputPerMillionTokens,
            outputPerMillionTokens: row.pricing.outputPerMillionTokens,
            currency: row.pricing.currency,
            ...(row.pricing.cacheWritePerMillionTokens === undefined
              ? {}
              : { cacheWritePerMillionTokens: row.pricing.cacheWritePerMillionTokens }),
            ...(row.pricing.cacheReadPerMillionTokens === undefined
              ? {}
              : { cacheReadPerMillionTokens: row.pricing.cacheReadPerMillionTokens }),
            ...(row.pricing.longContext === undefined
              ? {}
              : {
                  longContext: {
                    inputTokensAbove: row.pricing.longContext.inputTokensAbove,
                    inputPerMillionTokens: row.pricing.longContext.inputPerMillionTokens,
                    outputPerMillionTokens: row.pricing.longContext.outputPerMillionTokens,
                    ...(row.pricing.longContext.cacheWritePerMillionTokens === undefined
                      ? {}
                      : {
                          cacheWritePerMillionTokens:
                            row.pricing.longContext.cacheWritePerMillionTokens,
                        }),
                    ...(row.pricing.longContext.cacheReadPerMillionTokens === undefined
                      ? {}
                      : {
                          cacheReadPerMillionTokens:
                            row.pricing.longContext.cacheReadPerMillionTokens,
                        }),
                  },
                }),
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

/** `value` as JSON whose object keys are in order, so two lists of edits that say the same thing compare equal. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    const members = Object.entries(value)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Whether two lists of catalog edits are the same edits in the same order. */
function sameEdits(left: readonly CatalogEdit[], right: readonly CatalogEdit[]): boolean {
  return canonicalJson(left) === canonicalJson(right);
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
  const workspaceSecrets = options.workspaceSecrets ?? createWorkspaceSecrets(bungalow);
  const location = bungalow.configurationLocation;
  const load = (providers: readonly ContributedProvider[]): Promise<LoadedProviders> =>
    loadProviders({
      configurationLocation: location,
      readConfiguration: () => bungalow.readConfiguration(),
      readSecret: (key, snapshot) => workspaceSecrets.read(key, snapshot),
      warn: options.warn,
      providers,
    });

  // Nothing is offered until the plugins have been set up and `adopt` hands over their providers.
  let loaded: LoadedProviders = {
    configurationRevision: null,
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
  async function readDocument(): Promise<{
    document: Record<string, unknown>;
    revision: string | null;
  }> {
    let snapshot: ConfigurationSnapshot;
    try {
      snapshot = await bungalow.readConfiguration();
    } catch {
      throw new ProviderConfigurationError(location, 'the file', 'it could not be read.');
    }
    const { text, revision } = snapshot;
    // Parsed first as the host reads it, so a file that is already invalid is refused, not overwritten.
    const document = parseDocument(text, location);
    if (text !== undefined) parseProviderConfiguration(text, location);
    return { document, revision };
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

  let lastApplication: { revision: string | null; change: ProviderChange } | undefined;
  const apply = async (observed = false): Promise<ProviderChange> => {
    // Read back from disk, so the host serves what a restart would.
    const next = await load(loaded.providers);
    loaded = next;
    if (observed && lastApplication?.revision === next.configurationRevision)
      return lastApplication.change;
    if (replaceRows === undefined) throw new Error('The provider manager is not attached.');
    const catalog = await replaceRows(next.rows);
    const change = { providers: providerDiagnostics(next), catalogRevision: catalog };
    lastApplication = { revision: next.configurationRevision, change };
    return change;
  };

  return {
    current: () => loaded,
    configurationQueue,
    lockReason,
    generateFor(selection) {
      const selected = { provider: selection.provider, model: selection.model };
      let cached = loaded;
      const initial = createCatalogGenerate(selected, {
        ...cached,
        resolveProviderGenerate: options.resolveProviderGenerate,
      });
      let cachedGenerate = initial;
      const generate: GenerateFunction = async (context) => {
        const admitted = await serialized(async () => {
          const prior = loaded;
          const next = await load(prior.providers);
          const sameKeys =
            next.apiKeys.size === cached.apiKeys.size &&
            [...next.apiKeys].every(([name, value]) => cached.apiKeys.get(name) === value);
          const reuse =
            prior === cached &&
            next.configurationRevision === cached.configurationRevision &&
            sameKeys;
          const changed = next.configurationRevision !== loaded.configurationRevision;
          // Catalog replacement rebuilds file agents synchronously against current().
          loaded = next;
          if (changed) {
            if (replaceRows === undefined) throw new Error('The provider manager is not attached.');
            await replaceRows(next.rows);
          }
          if (!reuse)
            cachedGenerate = createCatalogGenerate(selected, {
              ...next,
              resolveProviderGenerate: options.resolveProviderGenerate,
            });
          cached = next;
          return cachedGenerate;
        });
        return admitted(context);
      };
      return withBackendDescriptors(generate, readBackendDescriptors(initial));
    },
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
      const { document, revision } = await readDocument();
      const configuration = parseProviderConfiguration(JSON.stringify(document), location);
      const allowlists = readAllowlists(
        document,
        location,
        loaded.providers.map((provider) => provider.plugin),
      );
      const reason = lockReason();
      return {
        configurationRevision: revision,
        appliedConfigurationRevision: loaded.configurationRevision,
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
        ...(hostWriteLocks(bungalow).providerKeys === undefined
          ? {}
          : { credentialLockReason: 'deployment' as const }),
      };
    },
    // The request is read, checked, and copied before the first `await`: the caller owns it, and
    // may change it while this waits its turn.
    async connect(connection, mutation) {
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
        const authority = mutation ?? (await createLocalHostMutationContext(bungalow));
        if (authority.workspaceId !== bungalow.workspaceId)
          throw new HostMutationError('forbidden');
        let identity = await authority.revalidate();
        const { document } = await readDocument();
        const wasConnected = loaded.apiKeys.has(provider);
        const text = validated(
          withAllowlist(document, contributed.plugin, models),
          new Set([...loaded.apiKeys.keys(), provider]),
        );
        const result = await workspaceSecrets.publish({
          operationId: authority.operationIdFor('provider-connect', provider),
          requestDigest: secretPublicationDigest({
            operation: 'provider-connect',
            target: provider,
            expectedRevision: authority.expectedRevision,
            payload: { plugin: contributed.plugin, apiKey: key, models },
          }),
          authorize: async () => {
            identity = await authority.revalidate();
          },
          key: secretKey,
          value: key,
          document: parseDocument(text, location),
          expectedRevision: authority.expectedRevision,
        });
        if (result.outcome !== 'committed') {
          await apply();
          throw new SecretPublicationError(result.outcome);
        }
        if (result.publishedNow !== true) return apply(true);
        // The plugin manager reports what is stored, so it reads the file again; the write stands
        // either way.
        await options.afterConfigurationWrite?.().catch(() => undefined);
        await options
          .audit?.({
            runId: `provider:${provider}`,
            type: wasConnected ? 'provider.configured' : 'provider.connected',
            principal: authority.owner,
            detail: {
              provider,
              outcome: 'committed',
              ...(models === undefined ? {} : { changedKeys: ['models'] }),
              ...(result.configurationHash === undefined ? {} : { hash: result.configurationHash }),
              previousRevision: authority.expectedRevision,
              actorId: identity.actorId,
              workspaceId: identity.workspaceId,
              membershipRevision: identity.membershipRevision,
            },
          })
          .catch(() => undefined);
        return apply();
      });
    },
    async testKey(request, signal) {
      if (closed) throw new Error('The host is shutting down.');
      const contributed = checkedProvider(request.provider, loaded.providers);
      const key = checkedKey(request.apiKey);
      const { document } = await readDocument();
      const configuration = parseProviderConfiguration(JSON.stringify(document), location);
      // The rows the catalog would hold with the key saved, so the count is what Connect would add.
      const offered = selectCatalogRows({
        configuration,
        allowlists: readAllowlists(
          document,
          location,
          loaded.providers.map((provider) => provider.plugin),
        ),
        path: location,
        available: new Set([...loaded.apiKeys.keys(), contributed.name]),
        providers: loaded.providers,
      }).filter((row) => row.provider === contributed.name && row.availability !== 'unavailable');
      const probe =
        offered[0] ?? contributed.rows.find((row) => row.lifecycle !== 'retired') ?? undefined;
      if (probe === undefined) return { ok: false };
      const conversation = new Conversation();
      conversation.appendUserMessage('Reply with one word: ok.');
      const timeout = AbortSignal.timeout(KEY_TEST_TIMEOUT_MILLISECONDS);
      try {
        const generate = options.resolveProviderGenerate(
          loaded.providers.map((provider) => provider.definition),
          { provider: contributed.name, model: probe.model, apiKey: key },
          undefined,
          undefined,
        );
        await generate({
          conversation,
          step: 0,
          toolbox: createToolbox([]),
          maximumTokens: 1,
          signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
        });
        return { ok: true, models: offered.length };
      } catch (error) {
        // A person who cancelled is not told the key failed.
        if (signal?.aborted === true) throw error;
        const status: unknown =
          typeof error === 'object' && error !== null
            ? Reflect.get(error, 'statusCode')
            : undefined;
        return typeof status === 'number' ? { ok: false, status } : { ok: false };
      }
    },
    async editCatalog(edits, base, mutation) {
      assertWritable();
      const parsed = parseCatalogEdits(
        edits,
        location,
        loaded.providers.map((provider) => provider.name),
      );
      // The base is read before the first `await`, like the edits: the caller owns it.
      let expected: readonly CatalogEdit[] | undefined;
      if (base !== undefined) {
        try {
          expected = parseCatalogEdits(base, location);
        } catch (error) {
          if (!(error instanceof ProviderConfigurationError)) throw error;
          throw new ProviderInputError(
            'base',
            'expected the list of catalog edits it started from.',
          );
        }
      }
      return serialized(async () => {
        const authority = mutation ?? (await createLocalHostMutationContext(bungalow));
        if (authority.workspaceId !== bungalow.workspaceId)
          throw new HostMutationError('forbidden');
        let identity = await authority.revalidate();
        const { document } = await readDocument();
        const { catalog: stored, ...rest } = document;
        // An edit for a provider no loaded plugin contributes is not the caller's to replace: it
        // waits in the file for its plugin, after the edits that replace the others.
        const names = new Set(loaded.providers.map((provider) => provider.name));
        const storedEdits = parseCatalogEdits(stored ?? [], location);
        // The comparison and the write share one turn of the queue, so no save lands between them.
        // It sees what the snapshot shows: the edits of the providers that are loaded.
        const current = storedEdits.filter((edit) => names.has(edit.provider));
        if (expected !== undefined && !sameEdits(expected, current)) {
          throw new ProviderConflictError(current);
        }
        const dormant = storedEdits.filter((edit) => !names.has(edit.provider));
        const next = [...parsed, ...dormant];
        const text = validated(
          next.length === 0 ? rest : { ...rest, catalog: next },
          new Set(loaded.apiKeys.keys()),
        );
        identity = await authority.revalidate();
        const result = await bungalow.writeConfiguration(text, {
          expectedRevision: authority.expectedRevision,
        });
        if (result.outcome !== 'committed') {
          await apply().catch(() => undefined);
          throw new SecretPublicationError(result.outcome);
        }
        const changedProviders = [
          ...new Set([...current, ...parsed].map((edit) => edit.provider)),
        ].filter((provider) => names.has(provider));
        await Promise.all(
          changedProviders.map(
            async (provider) =>
              await options
                .audit?.({
                  runId: `provider:${provider}`,
                  type: 'provider.configured',
                  principal: authority.owner,
                  detail: {
                    provider,
                    outcome: 'committed',
                    changedKeys: ['catalog'],
                    hash: createHash('sha256').update(text).digest('hex'),
                    previousRevision: authority.expectedRevision,
                    actorId: identity.actorId,
                    workspaceId: identity.workspaceId,
                    membershipRevision: identity.membershipRevision,
                  },
                })
                .catch(() => undefined),
          ),
        );
        return apply();
      });
    },
    async disconnect(provider, mutation) {
      assertWritable();
      const contributed = checkedProvider(provider, loaded.providers);
      const secretKey = contributed.secretKey;
      if (secretKey === undefined) {
        throw new ProviderInputError('provider', 'its plugin declares no secret to hold a key.');
      }
      return serialized(async () => {
        const authority = mutation ?? (await createLocalHostMutationContext(bungalow));
        if (authority.workspaceId !== bungalow.workspaceId)
          throw new HostMutationError('forbidden');
        let identity = await authority.revalidate();
        const { document } = await readDocument();
        const publication = await workspaceSecrets.publish({
          operationId: authority.operationIdFor('provider-disconnect', contributed.name),
          requestDigest: secretPublicationDigest({
            operation: 'provider-disconnect',
            target: contributed.name,
            expectedRevision: authority.expectedRevision,
            payload: {},
          }),
          authorize: async () => {
            identity = await authority.revalidate();
          },
          key: secretKey,
          value: '',
          document,
          expectedRevision: authority.expectedRevision,
        });
        if (publication.outcome !== 'committed')
          throw new SecretPublicationError(publication.outcome);
        if (publication.publishedNow !== true) return apply(true);
        // The plugin manager reports whether the provider's plugin still has its secret.
        await options.afterConfigurationWrite?.().catch(() => undefined);
        const change = await apply();
        // COR-2009 — the audit log's "Removed the Anthropic key": the provider, never the key.
        await options
          .audit?.({
            runId: `provider:${contributed.name}`,
            type: 'provider.disconnected',
            principal: authority.owner,
            detail: {
              provider: contributed.name,
              actorId: identity.actorId,
              workspaceId: identity.workspaceId,
              membershipRevision: identity.membershipRevision,
            },
          })
          .catch(() => undefined);
        return change;
      });
    },
    reload: () => serialized(() => apply()),
    checkDocument(document) {
      validated(document, new Set(loaded.apiKeys.keys()));
    },
    async checkProviders({ configuration, providers: contributed }) {
      const models = isPlainObject(configuration) ? configuration['models'] : undefined;
      if (!Array.isArray(models) || !models.every((entry) => typeof entry === 'string')) return [];
      let text: string | undefined;
      try {
        const snapshot = await bungalow.readConfiguration();
        text = snapshot.text;
      } catch {
        throw new ProviderConfigurationError(location, 'the file', 'it could not be read.');
      }
      const edits =
        text === undefined ? [] : (parseProviderConfiguration(text, location).catalog ?? []);
      const owned = contributed.map(({ definition, rows }) => ({ name: definition.name, rows }));
      const misses = unmatchedAllowlistEntries(owned, models, edits);
      return misses.map((index) => ({
        field: `models[${index}]`,
        message: allowlistMissMessage(owned),
      }));
    },
  };
}
