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
 *   `running` as soon as the value is stored.
 * - **Generated secrets.** A declaration with `generated: true` is created on first enable, in
 *   local mode only. A remote home keeps secrets in the deployment's environment, which the host
 *   cannot write, so the plugin stays `needs-setup` until the deployment sets the variable.
 * - **Local only.** A remote home refuses every write with the lock reason `deployment`.
 * - **No secret leaves.** A secret is written and never read back out: no answer, error, or
 *   listing carries a value, only whether one is set and where it lives.
 *
 * @module plugin-manager
 */

import { randomUUID } from 'node:crypto';

import type { Bungalow } from '@lostgradient/bungalow';
import type {
  BureauPluginEntry,
  BureauPluginSecrets,
  BureauPluginSettings,
  PluginListing,
  SettingLockReason,
} from '@lostgradient/bureau';

import { createConfigurationQueue, type ConfigurationQueue } from './configuration-queue.ts';
import { hostWriteLocks } from './locations.ts';
import { parsePluginSettings, readPluginSettings } from './plugins.ts';
import { ProviderConfigurationError } from './provider-configuration-error.ts';
import { parseProviderConfiguration } from './providers.ts';

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
  /** Where it lives: a 0600 file's path locally, or the environment variable's name remotely. */
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

/** The plugins as the host holds them. */
export type PluginSnapshot = {
  /** Every plugin, in load order. */
  readonly plugins: readonly PluginStanding[];
  /** Present when writes are refused, with the reason. */
  readonly lockReason?: SettingLockReason;
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
  /** The reader Bureau gets for the secrets plugins declare. Reads on demand and tells watchers of every save. */
  readonly secrets: BureauPluginSecrets;
  /** Why writes are refused, or `undefined` when they are allowed. */
  lockReason(): SettingLockReason | undefined;
  /**
   * Store the secret `key` and tell its watchers, so a plugin that waits on the key is not left
   * waiting. A writer of Bungalow's secrets other than this manager calls it instead of
   * `Bungalow.writeSecret`. The watchers hear even when the write throws, because Bungalow renames
   * the file into place before it syncs the directory, so a failure may follow a stored value; the
   * error still reaches the caller.
   */
  writeSecret(key: string, value: string): void;
  /**
   * Read the persisted choices from the file again, for a writer of `plugins.<name>` other than
   * this manager (the provider manager writes a provider plugin's allowlist), so a report shows
   * what is stored.
   */
  reload(): Promise<void>;
  /** Create the secrets declared `generated` that an enabled plugin lacks. Local mode only; a remote home does nothing. */
  ensureGeneratedSecrets(): Promise<void>;
  /** Every plugin with the owner's choices and its secrets' standing. */
  snapshot(): Promise<PluginSnapshot>;
  /** Persist the choices for `name`. */
  update(name: string, request: PluginSettingsRequest): Promise<PluginSettingsChange>;
  /** Store the secret `key` of `name`. */
  saveSecret(name: string, key: string, value: unknown): Promise<PluginSecretChange>;
  /** Refuse every later change. The host calls it as it shuts down. */
  close(): void;
};

/** What {@link createPluginManager} reads. */
export type PluginManagerOptions = {
  /** The open home. Its mode decides whether a write is allowed. */
  readonly bungalow: Pick<
    Bungalow,
    | 'mode'
    | 'configurationLocation'
    | 'readConfiguration'
    | 'writeConfiguration'
    | 'readSecret'
    | 'writeSecret'
    | 'secretLocation'
  >;
  /** The plugins the host loads. Copied: a later change to the array does not reach the manager. */
  readonly plugins: readonly BureauPluginEntry[];
  /** The queue every writer of `configuration.json` shares. Defaults to a new one. */
  readonly configurationQueue?: ConfigurationQueue;
  /**
   * Whether the host applies this plugin's configuration while it runs, so a change to it needs no
   * restart (a provider plugin's allowlist). Defaults to none. Only `enabled` then counts for
   * `restartRequired`.
   */
  readonly appliesConfigurationLive?: (plugin: string) => boolean;
  /** Bureau's listing, once the Bureau exists; it is empty before. */
  readonly listing: () => Promise<readonly PluginListing[]>;
  /** Secret keys the host keeps for itself: a plugin may not declare one, since it would read or overwrite it. */
  readonly reservedSecretKeys: readonly string[];
  /** Prefixes of secret keys the host keeps for itself, such as the tool sources' credentials. */
  readonly reservedSecretPrefixes: readonly string[];
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

/** Create the manager. Reads the persisted choices once, now. */
export async function createPluginManager(options: PluginManagerOptions): Promise<PluginManager> {
  const { bungalow } = options;
  const location = bungalow.configurationLocation;
  const entries = [...options.plugins];
  const configurationQueue = options.configurationQueue ?? createConfigurationQueue();
  let closed = false;

  const reserved = (key: string): boolean =>
    options.reservedSecretKeys.includes(key) ||
    options.reservedSecretPrefixes.some((prefix) => key.startsWith(prefix));
  const entryNamed = (name: string): BureauPluginEntry | undefined =>
    entries.find((entry) => entry.descriptor.name === name);

  // A declaration the host cannot honor is a mistake in the plugin's code, so it stops the host
  // before anything opens instead of surfacing later as a request that cannot be answered.
  for (const entry of entries) {
    for (const declaration of entry.descriptor.secrets ?? []) {
      const key = declaredKey(declaration);
      if (reserved(key)) {
        throw new Error(
          `Plugin "${entry.descriptor.name}" declares the secret "${key}", which the host keeps for itself.`,
        );
      }
      // Bungalow refuses a key it cannot store, naming it.
      bungalow.secretLocation(key);
    }
  }

  async function readText(): Promise<string | undefined> {
    try {
      return await bungalow.readConfiguration();
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
  const writeSecret = (key: string, value: string): void => {
    try {
      bungalow.writeSecret(key, value);
    } finally {
      secretChanged(key);
    }
  };
  const secrets: BureauPluginSecrets = {
    get: async (key) => bungalow.readSecret(key),
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
   * Create the `generated` secrets of every enabled plugin that lacks them. The read and the write
   * of one key are adjacent and synchronous, so a save of the same key cannot fall between them.
   */
  function generate(): void {
    if (bungalow.mode === 'remote') return;
    for (const entry of entries) {
      if (!enabledIn(persisted, entry)) continue;
      for (const declaration of entry.descriptor.secrets ?? []) {
        if (!isGenerated(declaration)) continue;
        const key = declaredKey(declaration);
        if (isSet(bungalow.readSecret(key))) continue;
        writeSecret(key, `${randomUUID()}${randomUUID()}`);
      }
    }
  }

  const changeOf = (entry: BureauPluginEntry): PluginSettingsChange => ({
    plugin: entry.descriptor.name,
    enabled: enabledIn(persisted, entry),
    configuration: configurationIn(persisted, entry.descriptor.name),
    restartRequired: restartRequired(entry),
  });

  return {
    settings: () => loaded,
    secrets,
    lockReason,
    writeSecret,
    async reload() {
      persisted = readPluginSettings(await readText(), location);
    },
    ensureGeneratedSecrets: () => serialized(async () => generate()),
    close() {
      closed = true;
    },

    async snapshot() {
      const listing = await options.listing();
      const reason = lockReason();
      return {
        plugins: listing.flatMap((plugin): PluginStanding[] => {
          const entry = entryNamed(plugin.descriptor.name);
          if (entry === undefined) return [];
          return [
            {
              ...plugin,
              enabled: enabledIn(persisted, entry),
              configuration: configurationIn(persisted, entry.descriptor.name),
              secrets: (entry.descriptor.secrets ?? []).map((declaration) => {
                const key = declaredKey(declaration);
                return {
                  key,
                  generated: isGenerated(declaration),
                  set: isSet(bungalow.readSecret(key)),
                  location: bungalow.secretLocation(key),
                };
              }),
              restartRequired: restartRequired(entry),
            },
          ];
        }),
        ...(reason === undefined ? {} : { lockReason: reason }),
      };
    },

    // The request is read, checked, and copied before the first `await`: the caller owns it, and
    // may change it while this waits its turn.
    async update(name, request) {
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
      return serialized(async () => {
        assertWritable();
        const text = await readText();
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
        const nextDocument = { ...document, plugins: { ...declared, [name]: nextEntry } };
        // The same check the next start applies, before a byte is written.
        const applied = parsePluginSettings(nextDocument, location);
        try {
          bungalow.writeConfiguration(`${JSON.stringify(nextDocument, null, 2)}\n`);
        } catch (error) {
          // A write that throws may still have replaced the file, so the disk decides what is reported.
          try {
            persisted = readPluginSettings(await readText(), location);
          } catch {
            // The failure to report is the write's.
          }
          throw error;
        }
        persisted = applied;
        // A plugin turned on gets the secrets it asks the host to create, now, so the next start
        // finds them. They are created after the choice is stored: a failure here leaves the choice
        // made, and the same request again finishes the job.
        if (enabledIn(persisted, entry)) generate();
        return changeOf(entry);
      });
    },

    async saveSecret(name, key, value) {
      assertWritable();
      const entry = entryNamed(name);
      if (entry === undefined) throw new PluginNotFoundError(name);
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
      return serialized(async () => {
        assertWritable();
        writeSecret(key, trimmed);
        return { plugin: name, key, set: true };
      });
    },
  };
}
