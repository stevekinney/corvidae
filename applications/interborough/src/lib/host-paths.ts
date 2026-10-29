/**
 * Where the host keeps the files a person may edit by hand. The browser cannot know the state
 * directory (`~/.interborough`, or `INTERBOROUGH_HOME`), and an agent and a workflow are each a file
 * in it, so the host says (`/host/paths`, `src/host/host.ts`). It also says where the model
 * providers are configured, which an installation with none needs to be told.
 */
import { z } from 'zod';

import type { Fetcher } from './bureau-client.ts';

/** The route the host answers with {@link HostPaths}. */
export const HOST_PATHS_ROUTE = '/host/paths';

const hostPathsSchema = z.object({
  agentDirectory: z.string(),
  workflowDirectory: z.string(),
  /** `configuration.json` in the state directory, where the model providers are named. */
  configurationFile: z.string(),
  /** The provider names the configuration accepts, each with the file that holds its API key. */
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
