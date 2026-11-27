import type { Bungalow, ContentLocation, DatabaseLocation } from '@lostgradient/bungalow';
import type { SettingLockReason } from '@lostgradient/bureau';
import type { SkillSource } from '@lostgradient/bureau/skills';
import { DEFAULT_SOURCE_PRECEDENCE } from '@lostgradient/bureau/skills';
import type {
  AgentSource,
  DirectorySourceOptions,
  GuardrailSource,
  ValidatorSource,
  WorkflowSource,
} from '@lostgradient/bureau/sources';
import {
  agentFileDirectory,
  agentObjectSource,
  guardrailFileDirectory,
  guardrailObjectSource,
  validatorFileDirectory,
  validatorObjectSource,
  workflowFileDirectory,
  workflowObjectSource,
} from '@lostgradient/bureau/sources';
import type { S3ObjectStoreOperations } from '@lostgradient/object-store';
import { storageConditionalBatch, type Storage } from '@lostgradient/storage';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { PostgresStorage } from '@lostgradient/storage-postgres';
import type { Tool } from 'armorer';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * How often a remote definition source lists its prefix, in milliseconds. A tick lists the prefix
 * twice (the poll's scan, then Bureau's `load()`), so Bureau's one-second default would send about
 * 172,800 `LIST` requests a day per source per host; 30 seconds sends about 5,760. A change made
 * from the application is applied at once, and a change made in the bucket by hand shows up within
 * one interval.
 */
export const REMOTE_POLL_INTERVAL_MILLISECONDS = 30_000;

/**
 * How a local directory source watches (COR-2291): the `watch` mode and the watcher factory
 * Bureau's directory sources take, and nothing else. Omitted, a directory is watched natively with
 * the safety rescan behind it; `'poll'` opens no native watcher and relies on the rescan alone.
 * A remote source polls its bucket on its own interval and ignores both.
 */
export type LocalDirectoryOptions = Pick<DirectorySourceOptions, 'watch' | 'watchFactory'>;

/** The options a directory source takes, from `directory`, leaving out what was not chosen. */
function directoryOptionsOf(directory: LocalDirectoryOptions): LocalDirectoryOptions {
  return {
    ...(directory.watch === undefined ? {} : { watch: directory.watch }),
    ...(directory.watchFactory === undefined ? {} : { watchFactory: directory.watchFactory }),
  };
}

/** One immutable binding for the raw Postgres database, independent of URL spelling or S3 prefix. */
export const WORKSPACE_BINDING_KEY = 'bungalow:workspace-binding';

const textEncoder = new TextEncoder();

/** Atomically bind a database to one workspace and resource prefix. */
export async function claimWorkspaceBinding(
  storage: Storage,
  prefix: string,
  workspaceId: string | undefined,
): Promise<void> {
  if (workspaceId === undefined) {
    const entries = storage.scan('', { limit: 1 })[Symbol.asyncIterator]();
    try {
      const first = await entries.next();
      if (!first.done) {
        throw new Error(
          'Existing database state has no persisted deployment identity. Restore it from a backup.',
        );
      }
    } finally {
      await entries.return?.();
    }
    return;
  }
  const value = textEncoder.encode(JSON.stringify({ prefix, workspaceId }));
  await storageConditionalBatch(
    storage,
    [{ key: WORKSPACE_BINDING_KEY, expectedValue: null }],
    [{ type: 'put', key: WORKSPACE_BINDING_KEY, value }],
  );
  const stored = await storage.get(WORKSPACE_BINDING_KEY);
  if (stored === null || new TextDecoder().decode(stored) !== new TextDecoder().decode(value)) {
    throw new Error('The Postgres database is already bound to another workspace.');
  }
}

/**
 * Where the host's database is, without anything that authenticates to it: a SQLite file's path, or
 * a Postgres server's host, port, and database name. The Postgres URL carries the password, so it
 * is never kept past the storage that connects with it.
 */
export type HostDatabase =
  | { readonly kind: 'sqlite'; readonly path: string }
  | { readonly kind: 'postgres'; readonly location: string };

/**
 * What the host does with one kind of database location: open its storage, report it without a
 * credential, and say where the state lives for the line a development or production start prints.
 * A new kind of database is one entry of {@link DatabaseKinds}.
 */
export type DatabaseKind = {
  /** The storage for the location. `now` is the clock each key's write time is read from. */
  readonly createStorage: (database: DatabaseLocation, now?: () => number) => Storage;
  /** The location as the host reports it, with nothing that authenticates to it. */
  readonly redact: (database: DatabaseLocation) => HostDatabase;
  /** Where the state lives, as a person reads it: no credential. */
  readonly describeState: (database: DatabaseLocation) => string;
  /** The directory on this machine that is the host's home, or `undefined` when the database is not in one. */
  readonly localHome: (database: DatabaseLocation) => string | undefined;
};

/** The database kinds a host knows, keyed by the `kind` of a {@link DatabaseLocation}. */
export type DatabaseKinds = Readonly<Record<string, DatabaseKind>>;

/** What the host does with one kind of content location (the agent files, the workflow files, the plugins). */
export type ContentKind = {
  /** The source of agent definitions at `content`. */
  readonly createAgentSource: (
    bungalow: Bungalow,
    content: ContentLocation,
    tools: Readonly<Record<string, Tool>>,
    directory: LocalDirectoryOptions,
  ) => AgentSource;
  /** The source of workflow definitions at `content`. */
  readonly createWorkflowSource: (
    bungalow: Bungalow,
    content: ContentLocation,
    directory: LocalDirectoryOptions,
  ) => WorkflowSource;
  /** The source of the owner's validator files at `content` (COR-2119). */
  readonly createValidatorSource: (
    bungalow: Bungalow,
    content: ContentLocation,
    directory: LocalDirectoryOptions,
  ) => ValidatorSource;
  /** The source of the owner's guardrail files at `content` (COR-2120). */
  readonly createGuardrailSource: (
    bungalow: Bungalow,
    content: ContentLocation,
    directory: LocalDirectoryOptions,
  ) => GuardrailSource;
  /** The location as a person reads it. */
  readonly describe: (content: ContentLocation) => string;
  /** The directory on this machine that holds the content, or `undefined` when it is not in one. */
  readonly localDirectory: (content: ContentLocation) => string | undefined;
};

/** The content kinds a host knows, keyed by the `kind` of a {@link ContentLocation}. */
export type ContentKinds = Readonly<Record<string, ContentKind>>;

/** The object store remote mode holds, or an error: a bucket location with no client is a bug. */
function hasConditionalRemove(
  client: ReturnType<Bungalow['objectStore']>,
): client is S3ObjectStoreOperations {
  return client !== undefined && typeof client.remove === 'function';
}

function requireClient(bungalow: Bungalow): S3ObjectStoreOperations {
  const client = bungalow.objectStore();
  if (!hasConditionalRemove(client)) {
    throw new Error('The home names a bucket but has no S3 client with conditional remove.');
  }
  return client;
}

/** The wrong kind of location reached a default entry: a table mistake, and the text holds no field of it. */
function wrongKind(entry: string): Error {
  return new Error(`The ${entry} entry was given a location of another kind.`);
}

/** The path of a directory location, for the `directory` entry. */
function directoryPath(content: ContentLocation): string {
  if (content.kind !== 'directory') throw wrongKind('directory');
  return content.path;
}

/** The bucket and prefix of an S3 location, for the `s3` entry. */
function bucketOf(content: ContentLocation): { bucket: string; prefix: string } {
  if (content.kind !== 's3') throw wrongKind('s3');
  return { bucket: content.bucket, prefix: content.prefix };
}

/** The path of a SQLite location, for the `sqlite` entry. */
function sqlitePath(database: DatabaseLocation): string {
  if (database.kind !== 'sqlite') throw wrongKind('sqlite');
  return database.path;
}

/** The URL of a Postgres location, for the `postgres` entry. It carries the password. */
function postgresUrl(database: DatabaseLocation): string {
  if (database.kind !== 'postgres') throw wrongKind('postgres');
  return database.url;
}

/** The Postgres server and database name of `database`, or an error that quotes no part of the URL. */
function postgresLocation(database: DatabaseLocation): string {
  const text = postgresUrl(database);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    // The parser's own message quotes the text it could not read, and that text holds the password.
    throw new Error('The Postgres database URL is not a valid URL.');
  }
  return `${url.host}${url.pathname}`;
}

/** The database kinds a host starts with: a SQLite file on this machine, and a Postgres server. */
export const DEFAULT_DATABASE_KINDS: DatabaseKinds = {
  sqlite: {
    createStorage: (database, now) =>
      new BunSQLiteStorage(sqlitePath(database), now === undefined ? {} : { now }),
    redact: (database) => ({ kind: 'sqlite', path: sqlitePath(database) }),
    describeState: (database) => dirname(sqlitePath(database)),
    localHome: (database) => dirname(sqlitePath(database)),
  },
  postgres: {
    // The Postgres pool connects when first used, and this is the only place the URL is read.
    createStorage: (database, now) =>
      new PostgresStorage({
        url: postgresUrl(database),
        ...(now === undefined ? {} : { now }),
      }),
    redact: (database) => ({ kind: 'postgres', location: postgresLocation(database) }),
    describeState: () => 'the configured Postgres database',
    localHome: () => undefined,
  },
};

/** The content kinds a host starts with: a directory on this machine, and an S3 bucket prefix. */
export const DEFAULT_CONTENT_KINDS: ContentKinds = {
  directory: {
    createAgentSource: (_bungalow, content, tools, directory) =>
      agentFileDirectory(directoryPath(content), { tools, ...directoryOptionsOf(directory) }),
    createWorkflowSource: (_bungalow, content, directory) =>
      workflowFileDirectory(directoryPath(content), directoryOptionsOf(directory)),
    createValidatorSource: (_bungalow, content, directory) =>
      validatorFileDirectory(directoryPath(content), directoryOptionsOf(directory)),
    createGuardrailSource: (_bungalow, content, directory) =>
      guardrailFileDirectory(directoryPath(content), directoryOptionsOf(directory)),
    describe: directoryPath,
    localDirectory: directoryPath,
  },
  s3: {
    createAgentSource: (bungalow, content, tools) =>
      agentObjectSource(bucketOf(content), {
        operations: requireClient(bungalow),
        tools,
        pollIntervalMilliseconds: REMOTE_POLL_INTERVAL_MILLISECONDS,
      }),
    createWorkflowSource: (bungalow, content) =>
      workflowObjectSource(bucketOf(content), {
        operations: requireClient(bungalow),
        pollIntervalMilliseconds: REMOTE_POLL_INTERVAL_MILLISECONDS,
      }),
    createValidatorSource: (bungalow, content) =>
      validatorObjectSource(bucketOf(content), {
        operations: requireClient(bungalow),
        pollIntervalMilliseconds: REMOTE_POLL_INTERVAL_MILLISECONDS,
      }),
    createGuardrailSource: (bungalow, content) =>
      guardrailObjectSource(bucketOf(content), {
        operations: requireClient(bungalow),
        pollIntervalMilliseconds: REMOTE_POLL_INTERVAL_MILLISECONDS,
      }),
    describe: (content) => {
      const { bucket, prefix } = bucketOf(content);
      return `s3://${bucket}/${prefix}`;
    },
    localDirectory: () => undefined,
  },
};

/** The entry for a database `kind`, or an error that names the kind and nothing of the location. */
function databaseKindOf(database: DatabaseLocation, kinds: DatabaseKinds): DatabaseKind {
  const kind: string = database.kind;
  if (!Object.hasOwn(kinds, kind)) {
    throw new Error(`The host has no handling for the database kind "${kind}".`);
  }
  return kinds[kind]!;
}

/** The entry for a content `kind`, or an error that names the kind and nothing of the location. */
function contentKindOf(content: ContentLocation, kinds: ContentKinds): ContentKind {
  const kind: string = content.kind;
  if (!Object.hasOwn(kinds, kind)) {
    throw new Error(`The host has no handling for the content kind "${kind}".`);
  }
  return kinds[kind]!;
}

/** The database as the host reports it: a SQLite path, or a Postgres location with no credential. */
export function redactDatabase(
  database: DatabaseLocation,
  kinds: DatabaseKinds = DEFAULT_DATABASE_KINDS,
): HostDatabase {
  return databaseKindOf(database, kinds).redact(database);
}

/** Where the database's state lives, as `kinds` says: a directory, or the configured Postgres database. */
export function describeDatabaseState(
  database: DatabaseLocation,
  kinds: DatabaseKinds = DEFAULT_DATABASE_KINDS,
): string {
  return databaseKindOf(database, kinds).describeState(database);
}

/** The directory on this machine that is the host's home, or `undefined` when the database is not in one. */
export function localDatabaseHome(
  database: DatabaseLocation,
  kinds: DatabaseKinds = DEFAULT_DATABASE_KINDS,
): string | undefined {
  return databaseKindOf(database, kinds).localHome(database);
}

/** The local directory that holds `content`, or `undefined` when it is not on this machine. */
export function localContentDirectory(
  content: ContentLocation,
  kinds: ContentKinds = DEFAULT_CONTENT_KINDS,
): string | undefined {
  return contentKindOf(content, kinds).localDirectory(content);
}

/**
 * The writes a home can refuse, by the name `/host/paths` reports them under: `configuration` is
 * `configuration.json`, and `providerKeys` are the API-key secrets. A local home writes both. A
 * remote home keeps the configuration in a bucket and the secrets in the environment, so it
 * refuses both for the reason `deployment`, the same codes `settings.get` gives a locked key.
 */
export type HostWriteLocks = Readonly<
  Partial<Record<'configuration' | 'providerKeys', SettingLockReason>>
>;

/** The writes `bungalow`'s home refuses and why. Empty for a local home. */
export function hostWriteLocks(
  bungalow: Pick<Bungalow, 'configurationWriteCapability' | 'secretProvider'>,
): HostWriteLocks {
  return {
    ...(bungalow.configurationWriteCapability === 'writable'
      ? {}
      : { configuration: 'deployment' as const }),
    ...(bungalow.secretProvider.capabilities.prepare &&
    bungalow.secretProvider.capabilities.transitions &&
    bungalow.configurationWriteCapability === 'writable'
      ? {}
      : { providerKeys: 'deployment' as const }),
  };
}

/** What `/host/paths` answers: where the host keeps its state, with no credential in any of it. */
export type HostPathsReport = {
  /** `local` for a state directory and a SQLite file, `remote` for Postgres and an S3 bucket. */
  readonly mode: 'local' | 'remote';
  /** The database as {@link redactDatabase} reports it: a SQLite path, or a Postgres server and database name. */
  readonly database: HostDatabase;
  /** The agent files, as {@link describeContent} reports them. */
  readonly agentDirectory: string;
  /** The workflow files, as {@link describeContent} reports them. */
  readonly workflowDirectory: string;
  /** `configuration.json`: a path, or an `s3://` location. */
  readonly configurationFile: string;
  /** The writes the host refuses, each with its reason: empty when the home is local. */
  readonly locked: HostWriteLocks;
  /** Each provider and where its API key lives (a file's path, or an environment variable's name), never the key. */
  readonly providers: readonly { readonly name: string; readonly secretFile: string }[];
  /**
   * The address of the A2A directory card, which lists the agents the host shares: under the
   * public origin when the operator set one (COR-1904), else the host's own. The browser cannot
   * know the public origin, so the host says.
   */
  readonly a2aDirectoryUrl: string;
  /**
   * COR-2171 — where a trigger that receives is sent its deliveries, before the workflow's
   * identifier: `<origin>/triggers/`, under the public origin when the operator set one (COR-2169),
   * else the host's own, as for {@link a2aDirectoryUrl}.
   */
  readonly triggersUrl: string;
};

/**
 * The report `/host/paths` serves, built from the open home. The database goes through
 * {@link redactDatabase}, so a Postgres URL's user name, password, and query string never reach it.
 */
export function hostPathsReport(
  bungalow: Pick<
    Bungalow,
    | 'mode'
    | 'database'
    | 'configurationLocation'
    | 'workspaceId'
    | 'configurationWriteCapability'
    | 'secretProvider'
  >,
  content: { readonly agents: ContentLocation; readonly workflows: ContentLocation },
  providers: readonly { readonly name: string; readonly secretKey: string }[],
  addresses: { readonly a2aDirectoryUrl: string; readonly triggersUrl: string },
  kinds: { readonly database?: DatabaseKinds; readonly content?: ContentKinds } = {},
): HostPathsReport {
  return {
    mode: bungalow.mode,
    database: redactDatabase(bungalow.database, kinds.database),
    agentDirectory: describeContent(content.agents, kinds.content),
    workflowDirectory: describeContent(content.workflows, kinds.content),
    configurationFile: bungalow.configurationLocation,
    locked: hostWriteLocks(bungalow),
    providers: providers.map(({ name, secretKey }) => ({
      name,
      secretFile: `workspace:${bungalow.workspaceId}/${secretKey}`,
    })),
    a2aDirectoryUrl: addresses.a2aDirectoryUrl,
    triggersUrl: addresses.triggersUrl,
  };
}

/**
 * The storage for the host's database: a SQLite file on this machine, or a Postgres server. The
 * Postgres pool connects when first used, and it is the only place the URL is read. `now` is the
 * clock each key's write time is read from, the host's own, so a host running on an injected
 * runtime records the times its records carry; it defaults to the system clock.
 */
export function createHostStorage(
  database: DatabaseLocation,
  now?: () => number,
  kinds: DatabaseKinds = DEFAULT_DATABASE_KINDS,
): Storage {
  return databaseKindOf(database, kinds).createStorage(database, now);
}

/** Release a storage the host opened, awaiting a pool's shutdown when the storage has one. */
export async function disposeHostStorage(
  storage: Storage & { [Symbol.asyncDispose]?: () => Promise<void> },
): Promise<void> {
  const asynchronous = storage[Symbol.asyncDispose];
  if (asynchronous === undefined) storage[Symbol.dispose]();
  else await asynchronous.call(storage);
}

/** The location as a person reads it: a directory's path, or `s3://<bucket>/<prefix>`. */
export function describeContent(
  content: ContentLocation,
  kinds: ContentKinds = DEFAULT_CONTENT_KINDS,
): string {
  return contentKindOf(content, kinds).describe(content);
}

/** The source of agent definitions at `content`: a directory, or a bucket prefix polled for changes. */
export function createAgentSource(
  bungalow: Bungalow,
  content: ContentLocation,
  tools: Readonly<Record<string, Tool>>,
  directory: LocalDirectoryOptions = {},
  kinds: ContentKinds = DEFAULT_CONTENT_KINDS,
): AgentSource {
  return contentKindOf(content, kinds).createAgentSource(bungalow, content, tools, directory);
}

/**
 * The read-only agent layer of the plugin `plugin` (COR-1897): the `agents` folder of its `content`
 * URL, listed as `plugin:name`. A `content` that is not a `file:` URL names nothing a directory can
 * hold, so it has no layer.
 */
export function createPluginAgentSource(
  plugin: string,
  content: URL,
  directory: LocalDirectoryOptions = {},
): AgentSource | undefined {
  if (content.protocol !== 'file:') return undefined;
  return agentFileDirectory(join(fileURLToPath(content), 'agents'), {
    plugin,
    ...directoryOptionsOf(directory),
  });
}

/**
 * The read-only workflow layer of the plugin `plugin` (COR-1977): the `workflows` folder of its
 * `content` URL, listed as `plugin:name`. A `content` that is not a `file:` URL has no layer.
 */
export function createPluginWorkflowSource(
  plugin: string,
  content: URL,
  directory: LocalDirectoryOptions = {},
): WorkflowSource | undefined {
  if (content.protocol !== 'file:') return undefined;
  return workflowFileDirectory(join(fileURLToPath(content), 'workflows'), {
    plugin,
    ...directoryOptionsOf(directory),
  });
}

/**
 * The skill source of the plugin `plugin` (COR-1977): the `skills` folder of its `content` URL, at
 * the plugin precedence. Its identifier, `plugin:<name>`, cannot be a configured source's: those
 * hold no colon. A `content` that is not a `file:` URL has no source.
 */
export function createPluginSkillSource(plugin: string, content: URL): SkillSource | undefined {
  if (content.protocol !== 'file:') return undefined;
  return {
    id: `plugin:${plugin}`,
    kind: 'plugin',
    location: join(fileURLToPath(content), 'skills'),
    precedence: DEFAULT_SOURCE_PRECEDENCE.plugin,
    plugin,
  };
}

/** The source of the owner's guardrail files at `content`: a directory, or a bucket prefix polled for changes. */
export function createGuardrailSource(
  bungalow: Bungalow,
  content: ContentLocation,
  directory: LocalDirectoryOptions = {},
  kinds: ContentKinds = DEFAULT_CONTENT_KINDS,
): GuardrailSource {
  return contentKindOf(content, kinds).createGuardrailSource(bungalow, content, directory);
}

/** The source of the owner's validator files at `content`: a directory, or a bucket prefix polled for changes. */
export function createValidatorSource(
  bungalow: Bungalow,
  content: ContentLocation,
  directory: LocalDirectoryOptions = {},
  kinds: ContentKinds = DEFAULT_CONTENT_KINDS,
): ValidatorSource {
  return contentKindOf(content, kinds).createValidatorSource(bungalow, content, directory);
}

/** The source of workflow definitions at `content`: a directory, or a bucket prefix polled for changes. */
export function createWorkflowSource(
  bungalow: Bungalow,
  content: ContentLocation,
  directory: LocalDirectoryOptions = {},
  kinds: ContentKinds = DEFAULT_CONTENT_KINDS,
): WorkflowSource {
  return contentKindOf(content, kinds).createWorkflowSource(bungalow, content, directory);
}
