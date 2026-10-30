/**
 * Where the host keeps the files a person may edit by hand. The browser cannot know the state
 * directory (`~/.interborough`, or `INTERBOROUGH_HOME`), and an agent and a workflow are each a file
 * in it, so the host says (`/host/paths`, `src/host/host.ts`). It also says where the model
 * providers are configured, which an installation with none needs to be told.
 */
import { z } from 'zod';

import type { Fetcher } from './bureau-client.ts';
import { SETTING_LOCK_REASONS } from './bureau-settings.ts';

/** The route the host answers with {@link HostPaths}. */
export const HOST_PATHS_ROUTE = '/host/paths';

const hostPathsSchema = z.object({
  /**
   * Whether the host keeps its state on this machine (`local`) or in a Postgres database and an S3
   * bucket (`remote`). The words that name a place to look change with it.
   */
  mode: z.enum(['local', 'remote']),
  /**
   * Where the host keeps its state: a SQLite file's `path`, or a Postgres server's `location`
   * (host, port, and database name). Never a user name or password.
   */
  database: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('sqlite'), path: z.string() }),
    z.object({ kind: z.literal('postgres'), location: z.string() }),
  ]),
  /** The agent files: a directory's path, or `s3://<bucket>/<prefix>` in remote mode. */
  agentDirectory: z.string(),
  /** The workflow files: a directory's path, or `s3://<bucket>/<prefix>` in remote mode. */
  workflowDirectory: z.string(),
  /** `configuration.json` in the state directory (an `s3://` location in remote mode), where the model providers are named. */
  configurationFile: z.string(),
  /**
   * The writes the host refuses, each with the reason `settings.get` gives a locked key. Empty when
   * the home is local. A remote home keeps the configuration and the API keys in its deployment, so
   * `configuration` and `providerKeys` are both `deployment`.
   */
  locked: z.object({
    configuration: z.enum(SETTING_LOCK_REASONS).optional(),
    providerKeys: z.enum(SETTING_LOCK_REASONS).optional(),
  }),
  /**
   * The provider names the configuration accepts, each with where its API key lives: a file's path,
   * or in remote mode the environment variable's name. Never the key itself.
   */
  providers: z.array(z.object({ name: z.string().min(1), secretFile: z.string().min(1) })),
});

/**
 * Where the host keeps the agent and workflow files, the provider configuration file, and the
 * secret file of each provider.
 */
export type HostPaths = z.infer<typeof hostPathsSchema>;

/** Asks the host where it keeps its files. */
export async function getHostPaths(options?: {
  readonly signal?: AbortSignal;
  readonly fetch?: Fetcher;
}): Promise<HostPaths> {
  const send = options?.fetch ?? fetch;
  const response = await send(
    HOST_PATHS_ROUTE,
    options?.signal === undefined ? undefined : { signal: options.signal },
  );
  if (!response.ok) throw new Error(`The host answered ${response.status}.`);
  return hostPathsSchema.parse(await response.json());
}

/** The path of one agent's file: its identifier under the agent directory, with `.md`. */
export function agentFilePath(agentDirectory: string, id: string): string {
  const directory = agentDirectory.endsWith('/') ? agentDirectory.slice(0, -1) : agentDirectory;
  return `${directory}/${id}.md`;
}

/** The path of one workflow's file: its identifier under the workflow directory, with `.json`. */
export function workflowFilePath(workflowDirectory: string, id: string): string {
  const directory = workflowDirectory.endsWith('/')
    ? workflowDirectory.slice(0, -1)
    : workflowDirectory;
  return `${directory}/${id}.json`;
}
