import type { Bungalow, ContentLocation, DatabaseLocation } from '@lostgradient/bungalow';
import type { SettingLockReason } from '@lostgradient/bureau';
import type { AgentSource, WorkflowSource } from '@lostgradient/bureau/sources';
import {
  agentFileDirectory,
  agentObjectSource,
  workflowFileDirectory,
  workflowObjectSource,
} from '@lostgradient/bureau/sources';
import type { Storage } from '@lostgradient/storage';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { PostgresStorage } from '@lostgradient/storage-postgres';
import type { Tool } from 'armorer';
import { join } from 'node:path';
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
 * Where the host's database is, without anything that authenticates to it: a SQLite file's path, or
 * a Postgres server's host, port, and database name. The Postgres URL carries the password, so it
 * is never kept past the storage that connects with it.
 */
export type HostDatabase =
  | { readonly kind: 'sqlite'; readonly path: string }
  | { readonly kind: 'postgres'; readonly location: string };

/** The database as the host reports it: a SQLite path, or a Postgres location with no credential. */
export function redactDatabase(database: DatabaseLocation): HostDatabase {
  if (database.kind === 'sqlite') return { kind: 'sqlite', path: database.path };
  let url: URL;
  try {
    url = new URL(database.url);
  } catch {
    // The parser's own message quotes the text it could not read, and that text holds the password.
    throw new Error('The Postgres database URL is not a valid URL.');
  }
  return { kind: 'postgres', location: `${url.host}${url.pathname}` };
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
export function hostWriteLocks(bungalow: Pick<Bungalow, 'mode'>): HostWriteLocks {
  return bungalow.mode === 'remote'
    ? { configuration: 'deployment', providerKeys: 'deployment' }
    : {};
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
};

/**
 * The report `/host/paths` serves, built from the open home. The database goes through
 * {@link redactDatabase}, so a Postgres URL's user name, password, and query string never reach it.
 */
export function hostPathsReport(
  bungalow: Pick<Bungalow, 'mode' | 'database' | 'configurationLocation' | 'secretLocation'>,
  content: { readonly agents: ContentLocation; readonly workflows: ContentLocation },
  providers: readonly { readonly name: string; readonly secretKey: string }[],
): HostPathsReport {
  return {
    mode: bungalow.mode,
    database: redactDatabase(bungalow.database),
    agentDirectory: describeContent(content.agents),
    workflowDirectory: describeContent(content.workflows),
    configurationFile: bungalow.configurationLocation,
    locked: hostWriteLocks(bungalow),
    providers: providers.map(({ name, secretKey }) => ({
      name,
      secretFile: bungalow.secretLocation(secretKey),
    })),
  };
}

/**
 * The storage for the host's database: a SQLite file on this machine, or a Postgres server. The
 * Postgres pool connects when first used, and it is the only place the URL is read.
 */
export function createHostStorage(database: DatabaseLocation): Storage {
  return database.kind === 'sqlite'
    ? new BunSQLiteStorage(database.path)
    : new PostgresStorage({ url: database.url });
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
export function describeContent(content: ContentLocation): string {
  return content.kind === 'directory' ? content.path : `s3://${content.bucket}/${content.prefix}`;
}

/** The `Bun.S3Client` remote mode holds, or an error: a bucket location with no client is a bug. */
function requireClient(bungalow: Bungalow): Bun.S3Client {
  const client = bungalow.s3Client();
  if (client === undefined) throw new Error('The home names a bucket but has no S3 client.');
  return client;
}

/** The source of agent definitions at `content`: a directory, or a bucket prefix polled for changes. */
export function createAgentSource(
  bungalow: Bungalow,
  content: ContentLocation,
  tools: Readonly<Record<string, Tool>>,
): AgentSource {
  if (content.kind === 'directory') return agentFileDirectory(content.path, { tools });
  return agentObjectSource(
    { bucket: content.bucket, prefix: content.prefix },
    {
      client: requireClient(bungalow),
      tools,
      pollIntervalMilliseconds: REMOTE_POLL_INTERVAL_MILLISECONDS,
    },
  );
}

/**
 * The read-only agent layer of the plugin `plugin` (COR-1897): the `agents` folder of its `content`
 * URL, listed as `plugin:name`. A `content` that is not a `file:` URL names nothing a directory can
 * hold, so it has no layer.
 */
export function createPluginAgentSource(plugin: string, content: URL): AgentSource | undefined {
  if (content.protocol !== 'file:') return undefined;
  return agentFileDirectory(join(fileURLToPath(content), 'agents'), { plugin });
}

/** The source of workflow definitions at `content`: a directory, or a bucket prefix polled for changes. */
export function createWorkflowSource(bungalow: Bungalow, content: ContentLocation): WorkflowSource {
  if (content.kind === 'directory') return workflowFileDirectory(content.path);
  return workflowObjectSource(
    { bucket: content.bucket, prefix: content.prefix },
    {
      client: requireClient(bungalow),
      pollIntervalMilliseconds: REMOTE_POLL_INTERVAL_MILLISECONDS,
    },
  );
}
