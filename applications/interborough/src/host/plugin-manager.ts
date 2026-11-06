import {
  createLocalHostMutationContext,
  HostMutationError,
  type HostMutationContext,
} from './host-mutation-context.ts';
import { secretPublicationDigest } from './secret-publication-digest.ts';
/**
 * The host's plugins while it runs (COR-1880): what the owner chose for each, the secrets each
 * declares, and the two ways the owner changes them without editing a file.
 *
 * - **Choices persist in `configuration.json`.** {@link PluginManager.update} writes
 *   `plugins.<name>` (`{ enabled, configuration }`) through the shared queue, after the
 *   configuration has been checked against the plugin's own schema, so a request cannot leave a
 *   file the next start refuses. Bureau composes plugins once, so a change applies on the next
 *   start; the answer says so with `restartRequired`.
 * - **A secret needs no restart.** {@link PluginManager.saveSecret} writes a secret the plugin
 *   declared and tells the watchers Bureau registered, so a plugin that was `needs-setup` becomes
 *   `running` as soon as the value is stored, and a provider plugin's models join the catalog.
 * - **Generated secrets.** A declaration with `generated: true` is created on first enable, in
 *   when the provider and configuration backend permit publication. Read-only environment
 *   providers leave the plugin in `needs-setup` until the deployment supplies its value.
 * - **A plugin the host cannot honor is skipped.** One that declares a secret the host keeps for
 *   itself, or one Bungalow cannot store, is not given to Bureau; it is listed `skipped` with
 *   `secret-refused`, and the host starts. {@link PluginManager.loadable} is what Bureau gets.
 * - **Capabilities.** Backend write capabilities determine whether publication is available.
 * - **No secret leaves.** A secret is written and never read back out: no answer, error, or
 *   listing carries a value, only whether one is set and where it lives.
 *
 * @module plugin-manager
 */

import { createHash, randomUUID } from 'node:crypto';

import { SecretProviderError, type Bungalow } from '@lostgradient/bungalow';
import {
  pluginLoadOrder,
  type BureauPluginEntry,
  type BureauPluginSecrets,
  type BureauPluginSettings,
  type PluginListing,
  type PluginLoadSource,
  type PluginProblem,
  type SettingLockReason,
} from '@lostgradient/bureau';

import { createConfigurationQueue, type ConfigurationQueue } from './configuration-queue.ts';
import { hostWriteLocks } from './locations.ts';
import { parsePluginSettings, readPluginSettings } from './plugins.ts';
import { ProviderConfigurationError } from './provider-configuration-error.ts';
import { parseDocument, parseProviderConfiguration } from './providers.ts';
import {
  createWorkspaceSecrets,
  SecretPublicationError,
  type WorkspaceSecrets,
} from './workspace-secrets.ts';

/** The longest secret value the host stores. Real keys are far shorter; the limit bounds a request. */
const MAXIMUM_SECRET_LENGTH = 4096;

/** A write the home does not allow: the reason is the one `settings.get` reports for a locked key. */
export class PluginWriteLockedError extends Error {
  /** Why the write is refused. A remote home is `deployment`: the deployment, not the host, holds the files. */
  readonly reason: SettingLockReason;

  constructor(reason: SettingLockReason) {
    super(
      'This host runs on remote storage, where plugin settings and secrets belong to the deployment. Change them there; the host cannot write them.',
    );
    this.name = 'PluginWriteLockedError';
    this.reason = reason;
  }
}

/** A request for a plugin the host does not load. */
export class PluginNotFoundError extends Error {
  /** The name the request gave. */
  readonly plugin: string;

  constructor(plugin: string) {
    super(`No plugin is named "${plugin}".`);
    this.name = 'PluginNotFoundError';
    this.plugin = plugin;
  }
}

/** A request the host cannot act on. The message names the field and never repeats a secret's value. */
export class PluginInputError extends Error {
  /** The field of the request that cannot be used, such as `configuration.limit`. */
  readonly field: string;

  constructor(field: string, problem: string) {
    super(`Invalid ${field}: ${problem}`);
    this.name = 'PluginInputError';
    this.field = field;
  }
}

/** What a change to a plugin's settings asks for. Each field that is absent keeps what is stored. */
export type PluginSettingsRequest = {
  /** Whether the plugin runs. A `required` plugin cannot be turned off. */
  readonly enabled?: unknown;
  /** The plugin's configuration, checked against its schema. `null` removes the stored value. */
  readonly configuration?: unknown;
};

/** One secret a plugin declares, with whether it is set and where it lives. Never its value. */
export type PluginSecretStanding = {
  /** The Bungalow secret key. */
  readonly key: string;
  /** Whether the host creates the value on first enable. */
  readonly generated: boolean;
  /** Whether a non-empty value is stored. */
  readonly set: boolean;
  /** Workspace and logical-key identity, without provider internals. */
  readonly location: string;
};

/** One plugin as the host reports it: Bureau's listing, with the owner's choices and its secrets. */
export type PluginStanding = PluginListing & {
  /** Whether the plugin is enabled in the persisted choices: its `enabledByDefault` until the owner chooses. */
  readonly enabled: boolean;
  /** The stored configuration, or `{}` when none is. */
  readonly configuration: unknown;
  /** The declared secrets. */
  readonly secrets: readonly PluginSecretStanding[];
  /** Whether the persisted choices differ from the ones this process loaded, so a restart applies them. */
  readonly restartRequired: boolean;
};

/** A plugin folder whose code could not be loaded, so it has no descriptor and no name. */
export type PluginUnloaded = {
  /** Where it was loaded from. */
  readonly source: PluginLoadSource;
  /** The folder. */
  readonly location: string;
  /** Always `skipped`. */
  readonly status: 'skipped';
  /** Why: `load-failed`, and `development-source` for a folder named with `--plugin`. */
  readonly problems: readonly PluginProblem[];
};

/** The plugins as the host holds them. */
export type PluginSnapshot = {
  /** Current committed storage revision for conditional edits. */
  readonly configurationRevision: string | null;
  /**
   * Every plugin Bureau loaded, in load order, then those the host skipped before Bureau
   * (`secret-refused`).
   */
  readonly plugins: readonly PluginStanding[];
  /** The folders that could not be loaded at all. */
  readonly unloaded: readonly PluginUnloaded[];
  /** Present when writes are refused, with the reason. */
  readonly lockReason?: SettingLockReason;
  /** Present when configuration may be writable but credential publication is unavailable. */
  readonly credentialLockReason?: SettingLockReason;
};

/** What a settings change reports. */
export type PluginSettingsChange = {
  /** The plugin. */
  readonly plugin: string;
  /** Whether it is enabled in the persisted choices. */
  readonly enabled: boolean;
  /** The stored configuration, or `{}`. */
  readonly configuration: unknown;
  /** Whether the choices differ from the ones this process loaded. */
  readonly restartRequired: boolean;
};

/** What a saved secret reports: that it is set, never its value. */
export type PluginSecretChange = {
  /** The plugin. */
  readonly plugin: string;
  /** The secret key. */
  readonly key: string;
  /** Always `true`: the value is stored. */
  readonly set: true;
};

/** The plugins a running host loads and how the owner changes them. See the module comment. */
export type PluginManager = {
  /** The persisted choices as they were when the manager was created: what `createBureau` composes with. */
  settings(): Readonly<Record<string, BureauPluginSettings>>;
  /**
   * Every plugin the host did not skip for a secret it cannot honor, the built-in `bureau` plugin
   * (COR-1890) included. The built-in one is listed here for its standing and is not given to
   * `createBureau`, which supplies it itself.
   */
  loadable(): readonly BureauPluginEntry[];
  /** The reader Bureau gets for the secrets plugins declare. Reads on demand and tells watchers of every save. */
  readonly secrets: BureauPluginSecrets;
  /** Why writes are refused, or `undefined` when they are allowed. */
  lockReason(): SettingLockReason | undefined;
  /** Publish a version and notify watchers after settlement; no value is returned. */
  writeSecret(key: string, value: string): Promise<void>;
  /**
   * Read the persisted choices from the file again, for a writer of `plugins.<name>` other than
   * this manager (the provider manager writes a provider plugin's allowlist), so a report shows
   * what is stored.
   */
  reload(): Promise<void>;
  /** Publish generated secrets an enabled plugin lacks, when both backends allow writes. */
  ensureGeneratedSecrets(): Promise<void>;
  /** Every plugin with the owner's choices and its secrets' standing. */
  snapshot(): Promise<PluginSnapshot>;
  /** Persist the choices for `name`. */
  update(
    name: string,
    request: PluginSettingsRequest,
    mutation?: HostMutationContext,
  ): Promise<PluginSettingsChange>;
  /** Store the secret `key` of `name`. */
  saveSecret(
    name: string,
    key: string,
    value: unknown,
    mutation?: HostMutationContext,
  ): Promise<PluginSecretChange>;
  /** Refuse every later change. The host calls it as it shuts down. */
  close(): void;
};

/** What {@link createPluginManager} reads. */
export type PluginManagerOptions = {
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
    | 'deploymentSecrets'
  >;
  /** The plugins the host loads. Copied: a later change to the array does not reach the manager. */
  readonly plugins: readonly BureauPluginEntry[];
  /** Folders that could not be loaded. Reported in the snapshot, nothing more. Copied. */
  readonly unloaded?: readonly PluginUnloaded[];
  /** The queue every writer of `configuration.json` shares. Defaults to a new one. */
  readonly configurationQueue?: ConfigurationQueue;
  /**
   * Whether the host applies this plugin's configuration while it runs, so a change to it needs no
   * restart (a provider plugin's allowlist). Defaults to none. Only `enabled` then counts for
   * `restartRequired`.
   */
  readonly appliesConfigurationLive?: (plugin: string) => boolean;
  /**
   * For a plugin the host applies live: checks the whole document the host is about to write, and
   * throws what the next start would throw, before a byte is written. It runs inside the
   * configuration queue, on the document read there, so another writer cannot change what it was
   * checked against before the write (a catalog edit that removes a row the allowlist names).
   */
  readonly checkDocument?: (document: Record<string, unknown>) => void;
  /**
   * For a plugin the host applies live: called once a change to its choices is stored, outside the
   * configuration queue, to apply them (the host reloads the model catalog).
   */
  readonly applyConfiguration?: (plugin: string) => Promise<void>;
  /**
   * Called once a secret of `plugin` is stored, outside the configuration queue, for a reader of
   * the secret that does not watch it: the host reloads the model catalog for a provider plugin's
   * key, so its models are offered at once, as they are when Models › Connect stores the same key
   * (COR-2009). Bureau's watchers have already heard by then.
   */
  readonly applySecret?: (plugin: string) => Promise<void>;
  /** Records committed plugin configuration metadata without exposing request values. */
  readonly audit?: (entry: PluginAuditEntry) => Promise<void>;
  /** Bureau's listing, once the Bureau exists; it is empty before. */
  readonly listing: () => Promise<readonly PluginListing[]>;
  /** Secret keys the host keeps for itself: a plugin that declares one is skipped, since it would read or overwrite it. */
  readonly reservedSecretKeys: readonly string[];
  /** Prefixes of secret keys the host keeps for itself, such as the tool sources' credentials. */
  readonly reservedSecretPrefixes: readonly string[];
};

/** Metadata emitted after a plugin configuration write commits. */
export type PluginAuditEntry = {
  /** Stable configuration resource key in the audit trail. */
  readonly runId: string;
  /** Committed plugin configuration event discriminator. */
  readonly type: 'plugin.configured';
  /** Verified owner responsible for the committed edit. */
  readonly principal: string;
  /** Metadata describing the commit, excluding configuration values and secrets. */
  readonly detail: {
    readonly outcome: 'committed';
    readonly changedKeys: readonly string[];
    readonly hash?: string;
    readonly previousRevision: string | null;
  };
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The key a secret declaration names. */
function declaredKey(declaration: string | { readonly key: string }): string {
  return typeof declaration === 'string' ? declaration : declaration.key;
}

/** Whether a declaration asks the host to create the value. */
function isGenerated(declaration: string | { readonly generated?: boolean }): boolean {
  return typeof declaration !== 'string' && declaration.generated === true;
}

/** Whether a non-empty value is stored: an empty one is how a secret is removed. */
function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== '';
}

/** The first problem `entry`'s configuration schema finds in `given`, as a field of the request body. */
function configurationProblem(
  entry: BureauPluginEntry,
  given: unknown,
): { readonly field: string; readonly message: string } | undefined {
  const schema = entry.descriptor.configuration;
  if (schema === undefined) {
    return isPlainObject(given) && Object.keys(given).length === 0
      ? undefined
      : { field: 'configuration', message: 'this plugin takes no configuration.' };
  }
  const parsed = schema.safeParse(given);
  if (parsed.success) return undefined;
  const issue = parsed.error.issues[0];
  const path = issue?.path.map(String) ?? [];
  return {
    field: ['configuration', ...path].join('.'),
    message: issue?.message ?? 'the configuration is not valid.',
  };
}

/** The detail a problem adds to its code in the startup log: the message of the ones that carry one. */
function problemText(problem: PluginProblem): string {
  return 'message' in problem ? `${problem.code} (${problem.message})` : problem.code;
}

/**
 * The startup log: one line per plugin with its status and the codes of its problems, the plugins
 * Bureau loaded first, then those the host skipped, then the folders that did not load. A line
 * names a problem's message only for the codes that carry one, and never holds a secret's value.
 */
export function pluginStartupLines(snapshot: PluginSnapshot): string[] {
  const describe = (label: string, status: string, problems: readonly PluginProblem[]): string =>
    `Plugin ${label}: ${status}${problems.length === 0 ? '' : `; ${problems.map(problemText).join(', ')}`}`;
  return [
    ...snapshot.plugins.map((plugin) =>
      describe(
        `${plugin.descriptor.name}@${plugin.descriptor.version} (${plugin.source}: ${plugin.location})`,
        plugin.status,
        plugin.problems,
      ),
    ),
    ...snapshot.unloaded.map((plugin) =>
      describe(`(${plugin.source}: ${plugin.location})`, plugin.status, plugin.problems),
    ),
  ];
}

/** Create the manager. Reads the persisted choices once, now. */
export async function createPluginManager(options: PluginManagerOptions): Promise<PluginManager> {
  const { bungalow } = options;
  const workspaceSecrets = options.workspaceSecrets ?? createWorkspaceSecrets(bungalow);
  const location = bungalow.configurationLocation;
  // Bureau composes plugins in this order and the first holder of a name runs, so the manager
  // orders them the same way: its lookups by name then find the plugin that is running (COR-1881).
  const entries = pluginLoadOrder(options.plugins);
  const configurationQueue = options.configurationQueue ?? createConfigurationQueue();
  let closed = false;

  const reserved = (key: string): boolean =>
    options.reservedSecretKeys.includes(key) ||
    options.reservedSecretPrefixes.some((prefix) => key.startsWith(prefix));
  // A refused plugin never reaches Bureau, so a loadable plugin of the same name is the one that
  // runs and the one a name addresses.
  const entryNamed = (name: string): BureauPluginEntry | undefined =>
    entries.find((entry) => entry.descriptor.name === name && !refusals.has(entry)) ??
    entries.find((entry) => entry.descriptor.name === name);

  // A declaration the host cannot honor is a mistake in the plugin's code. It skips that plugin,
  // as a plugin whose setup throws is skipped, and never stops the host (COR-1881).
  const refusals = new Map<BureauPluginEntry, PluginProblem>();
  for (const entry of entries) {
    for (const declaration of entry.descriptor.secrets ?? []) {
      const key = declaredKey(declaration);
      let message: string | undefined;
      if (reserved(key)) {
        message = `Plugin "${entry.descriptor.name}" declares the secret "${key}", which the host keeps for itself.`;
      } else {
        try {
          // Bungalow refuses a key it cannot store, naming it.
          bungalow.deploymentSecrets.location(key);
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
      }
      if (message !== undefined) {
        refusals.set(entry, { code: 'secret-refused', key, message });
        break;
      }
    }
  }
  const loadable = entries.filter((entry) => !refusals.has(entry));
  const unloaded = [...(options.unloaded ?? [])];

  async function readText(): Promise<string | undefined> {
    try {
      const snapshot = await bungalow.readConfiguration();
      return snapshot.text;
    } catch {
      throw new ProviderConfigurationError(location, 'the file', 'it could not be read.');
    }
  }

  let persisted = readPluginSettings(await readText(), location);
  const loaded = persisted;

  const lockReason = (): SettingLockReason | undefined => hostWriteLocks(bungalow).configuration;
  const assertWritable = (): void => {
    const reason = lockReason();
    if (reason !== undefined) throw new PluginWriteLockedError(reason);
  };
  const serialized = <Result>(work: () => Promise<Result>): Promise<Result> =>
    configurationQueue.run(() => {
      if (closed) throw new Error('The host is shutting down.');
      return work();
    });

  const settingsOf = (
    settings: Readonly<Record<string, BureauPluginSettings>>,
    name: string,
  ): BureauPluginSettings => (Object.hasOwn(settings, name) ? (settings[name] ?? {}) : {});
  const enabledIn = (
    settings: Readonly<Record<string, BureauPluginSettings>>,
    entry: BureauPluginEntry,
  ): boolean =>
    entry.descriptor.required === true ||
    (settingsOf(settings, entry.descriptor.name).enabled ??
      entry.descriptor.enabledByDefault ??
      true);
  const configurationIn = (
    settings: Readonly<Record<string, BureauPluginSettings>>,
    name: string,
  ): unknown => settingsOf(settings, name).configuration ?? {};
  const restartRequired = (entry: BureauPluginEntry): boolean =>
    enabledIn(persisted, entry) !== enabledIn(loaded, entry) ||
    (options.appliesConfigurationLive?.(entry.descriptor.name) !== true &&
      JSON.stringify(configurationIn(persisted, entry.descriptor.name)) !==
        JSON.stringify(configurationIn(loaded, entry.descriptor.name)));

  // Watchers by key. A listener that throws must not stop the others, so each call is isolated.
  const watchers = new Map<string, Set<() => void>>();
  const secretChanged = (key: string): void => {
    for (const listener of Array.from(watchers.get(key) ?? [])) {
      try {
        listener();
      } catch {
        // The watcher is Bureau's; its failure is not the writer's.
      }
    }
  };
  const writeSecret = async (key: string, value: string): Promise<void> => {
    try {
      await workspaceSecrets.write(key, value);
    } finally {
      secretChanged(key);
    }
  };
  const secrets: BureauPluginSecrets = {
    get: (key) => workspaceSecrets.read(key),
    watch(key, listener) {
      const set = watchers.get(key) ?? new Set<() => void>();
      watchers.set(key, set);
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
  };

  /**
   * Generate only against the configuration revision that proved the key absent. Another host
   * can win that revision; its committed value is retained without retrying this publication.
   */
  async function generate(): Promise<void> {
    if (!workspaceSecrets.writable) return;
    for (const entry of loadable) {
      if (!enabledIn(persisted, entry)) continue;
      for (const declaration of entry.descriptor.secrets ?? []) {
        if (!isGenerated(declaration)) continue;
        const key = declaredKey(declaration);
        const snapshot = await bungalow.readConfiguration();
        if (isSet(await workspaceSecrets.read(key, snapshot))) continue;
        const result = await workspaceSecrets.publish({
          operationId: randomUUID(),
          key,
          value: `${randomUUID()}${randomUUID()}`,
          expectedRevision: snapshot.revision,
          document: parseDocument(snapshot.text, location),
        });
        if (result.outcome !== 'committed') {
          if (result.outcome === 'conflict' && isSet(await workspaceSecrets.read(key))) continue;
          throw new SecretProviderError('unavailable', 'The generated secret was not published.');
        }
        secretChanged(key);
      }
    }
  }

  const changeOf = (entry: BureauPluginEntry): PluginSettingsChange => ({
    plugin: entry.descriptor.name,
    enabled: enabledIn(persisted, entry),
    configuration: configurationIn(persisted, entry.descriptor.name),
    restartRequired: restartRequired(entry),
  });

  // A skipped plugin has no listing from Bureau, which never received it, so the host states its
  // standing. Its secrets are not reported: a refused key may be one the host keeps for itself.
  const refusedStanding = (entry: BureauPluginEntry, problem: PluginProblem): PluginStanding => ({
    descriptor: {
      name: entry.descriptor.name,
      title: entry.descriptor.title ?? entry.descriptor.name,
      version: entry.descriptor.version,
      description: entry.descriptor.description,
      required: entry.descriptor.required === true,
      enabledByDefault: entry.descriptor.enabledByDefault ?? true,
      secrets: [],
    },
    source: entry.source,
    location: entry.location,
    status: 'skipped',
    problems: [
      problem,
      ...(entry.developmentPath === undefined
        ? []
        : [{ code: 'development-source', path: entry.developmentPath } as const]),
    ],
    contributions: [],
    enabled: enabledIn(persisted, entry),
    configuration: configurationIn(persisted, entry.descriptor.name),
    secrets: [],
    restartRequired: restartRequired(entry),
  });

  return {
    settings: () => loaded,
    loadable: () => loadable,
    secrets,
    lockReason,
    writeSecret,
    async reload() {
      persisted = readPluginSettings(await readText(), location);
      for (const key of watchers.keys()) secretChanged(key);
    },
    ensureGeneratedSecrets: () => serialized(async () => generate()),
    close() {
      closed = true;
    },

    async snapshot() {
      const configuration = await bungalow.readConfiguration();
      const listing = await options.listing();
      const reason = lockReason();
      const standingOf = async (
        plugin: PluginListing,
        entry: BureauPluginEntry,
      ): Promise<PluginStanding> => ({
        ...plugin,
        enabled: enabledIn(persisted, entry),
        configuration: configurationIn(persisted, entry.descriptor.name),
        secrets: await Promise.all(
          (entry.descriptor.secrets ?? []).map(async (declaration) => {
            const key = declaredKey(declaration);
            return {
              key,
              generated: isGenerated(declaration),
              set: isSet(await workspaceSecrets.read(key)),
              location: `workspace:${bungalow.workspaceId}/${key}`,
            };
          }),
        ),
        restartRequired: restartRequired(entry),
      });
      const standing = await Promise.all(
        listing.map(async (plugin): Promise<PluginStanding | undefined> => {
          const entry = loadable.find(
            (candidate) =>
              candidate.source === plugin.source && candidate.location === plugin.location,
          );
          return entry === undefined ? undefined : standingOf(plugin, entry);
        }),
      );
      return {
        configurationRevision: configuration.revision,
        plugins: [
          ...standing.filter((entry): entry is PluginStanding => entry !== undefined),
          ...[...refusals].map(([entry, problem]) => refusedStanding(entry, problem)),
        ],
        unloaded,
        ...(reason === undefined ? {} : { lockReason: reason }),
        ...(hostWriteLocks(bungalow).providerKeys === undefined
          ? {}
          : { credentialLockReason: 'deployment' as const }),
      };
    },

    // The request is read, checked, and copied before the first `await`: the caller owns it, and
    // may change it while this waits its turn.
    async update(name, request, mutation) {
      assertWritable();
      const entry = entryNamed(name);
      if (entry === undefined) throw new PluginNotFoundError(name);
      const enabled = request.enabled;
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        throw new PluginInputError('enabled', 'expected true or false.');
      }
      if (enabled === false && entry.descriptor.required === true) {
        throw new PluginInputError('enabled', 'this plugin is required and cannot be turned off.');
      }
      const clearsConfiguration = request.configuration === null;
      const configuration: unknown =
        request.configuration === undefined || clearsConfiguration
          ? undefined
          : structuredClone(request.configuration);
      if (configuration !== undefined) {
        const problem = configurationProblem(entry, configuration);
        if (problem !== undefined) throw new PluginInputError(problem.field, problem.message);
      }
      const live = options.appliesConfigurationLive?.(name) === true;
      let changedKeys: string[] = [];
      let committedText = '';
      let previousRevision: string | null = null;
      let mutationOwner = '';
      const change = await serialized(async () => {
        assertWritable();
        const authority = mutation ?? (await createLocalHostMutationContext(bungalow));
        if (authority.workspaceId !== bungalow.workspaceId)
          throw new HostMutationError('forbidden');
        const identity = await authority.revalidate();
        if (enabled !== undefined && !identity.capabilities.includes('deployment:operate'))
          throw new HostMutationError('forbidden');
        mutationOwner = authority.owner;
        const snapshot = await bungalow.readConfiguration();
        const text = snapshot.text;
        // Parsed first as the host reads it, so a file that is already invalid is refused, not overwritten.
        if (text !== undefined) parseProviderConfiguration(text, location);
        const current = readPluginSettings(text, location);
        const parsed: unknown = text === undefined ? {} : JSON.parse(text);
        const document = isPlainObject(parsed) ? parsed : {};
        const declared = isPlainObject(document['plugins']) ? document['plugins'] : {};
        const existing = settingsOf(current, name);
        const nextEnabled = enabled ?? existing.enabled;
        const nextConfiguration = clearsConfiguration
          ? undefined
          : (configuration ?? existing.configuration);
        const nextEntry = {
          ...(nextEnabled === undefined ? {} : { enabled: nextEnabled }),
          ...(nextConfiguration === undefined ? {} : { configuration: nextConfiguration }),
        };
        changedKeys = [
          ...(enabled !== undefined && enabled !== existing.enabled ? ['enabled'] : []),
          ...(configuration !== undefined || clearsConfiguration ? ['configuration'] : []),
        ];
        const nextDocument = { ...document, plugins: { ...declared, [name]: nextEntry } };
        // The same check the next start applies, before a byte is written.
        const applied = parsePluginSettings(nextDocument, location);
        if (live && configuration !== undefined) options.checkDocument?.(nextDocument);
        try {
          const currentIdentity = await authority.revalidate();
          if (enabled !== undefined && !currentIdentity.capabilities.includes('deployment:operate'))
            throw new HostMutationError('forbidden');
          const result = await bungalow.writeConfiguration(
            `${JSON.stringify(nextDocument, null, 2)}\n`,
            { expectedRevision: authority.expectedRevision },
          );
          if (result.outcome !== 'committed') throw new SecretPublicationError(result.outcome);
          committedText = `${JSON.stringify(nextDocument, null, 2)}\n`;
          previousRevision = authority.expectedRevision;
        } catch (error) {
          // A write that throws may still have replaced the file, so the disk decides what is reported.
          try {
            persisted = readPluginSettings(await readText(), location);
            for (const key of watchers.keys()) secretChanged(key);
          } catch {
            // The failure to report is the write's.
          }
          throw error;
        }
        persisted = applied;
        // A plugin turned on gets the secrets it asks the host to create, now, so the next start
        // finds them. They are created after the choice is stored: a failure here leaves the choice
        // made, and the same request again finishes the job.
        if (enabledIn(persisted, entry)) await generate();
        return changeOf(entry);
      });
      await options
        .audit?.({
          runId: `plugin:${name}`,
          type: 'plugin.configured',
          principal: mutationOwner,
          detail: {
            outcome: 'committed',
            changedKeys,
            hash: createHash('sha256').update(committedText).digest('hex'),
            previousRevision,
          },
        })
        .catch(() => undefined);
      // Applied outside the queue, which the work shares. A change to `enabled` alone waits for a restart.
      if (live && (configuration !== undefined || clearsConfiguration)) {
        await options.applyConfiguration?.(name);
      }
      return change;
    },

    async saveSecret(name, key, value, mutation) {
      assertWritable();
      const entry = entryNamed(name);
      if (entry === undefined) throw new PluginNotFoundError(name);
      // A skipped plugin's declarations are not honored, and one of them may be the host's own key.
      if (refusals.has(entry)) {
        throw new PluginInputError(
          'plugin',
          `the plugin "${name}" is skipped and takes no secrets.`,
        );
      }
      const declares = (entry.descriptor.secrets ?? []).some(
        (declaration) => declaredKey(declaration) === key,
      );
      if (!declares) {
        throw new PluginInputError('key', `the plugin "${name}" does not declare this secret.`);
      }
      if (typeof value !== 'string') throw new PluginInputError('value', 'expected text.');
      const trimmed = value.trim();
      if (trimmed === '') throw new PluginInputError('value', 'expected a value, and it is empty.');
      if (trimmed.length > MAXIMUM_SECRET_LENGTH) {
        throw new PluginInputError('value', `longer than ${MAXIMUM_SECRET_LENGTH} characters.`);
      }
      // eslint-disable-next-line no-control-regex -- a control character is what this refuses.
      if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
        throw new PluginInputError('value', 'contains a line break or another control character.');
      }
      let publishedNow = false;
      const change = await serialized(async () => {
        assertWritable();
        const authority = mutation ?? (await createLocalHostMutationContext(bungalow));
        if (authority.workspaceId !== bungalow.workspaceId)
          throw new HostMutationError('forbidden');
        await authority.revalidate();
        const snapshot = await bungalow.readConfiguration();
        try {
          const result = await workspaceSecrets.publish({
            operationId: authority.operationIdFor('plugin-secret', JSON.stringify([name, key])),
            requestDigest: secretPublicationDigest({
              operation: 'plugin-secret',
              target: JSON.stringify([name, key]),
              expectedRevision: authority.expectedRevision,
              payload: { value: trimmed },
            }),
            key,
            value: trimmed,
            document: parseDocument(snapshot.text, location),
            expectedRevision: authority.expectedRevision,
            authorize: async () => {
              await authority.revalidate();
            },
          });
          if (result.outcome !== 'committed') throw new SecretPublicationError(result.outcome);
          publishedNow = result.publishedNow === true;
        } finally {
          if (publishedNow) secretChanged(key);
        }
        if (publishedNow)
          await options
            .audit?.({
              runId: `plugin:${name}`,
              type: 'plugin.configured',
              principal: authority.owner,
              detail: {
                outcome: 'committed',
                changedKeys: ['secret'],
                previousRevision: authority.expectedRevision,
              },
            })
            .catch(() => undefined);
        return { plugin: name, key, set: true } as const;
      });
      // Applied outside the queue, which the work shares.
      if (publishedNow) await options.applySecret?.(name);
      return change;
    },
  };
}
