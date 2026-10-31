/**
 * The agent a new chat talks to unless `?agent=` names another, and the one a new workflow step
 * starts with: the first agent the Bureau lists that can run. The host defines no agent of its
 * own, so a fresh host has none until a plugin that contributes agents is turned on (the `demo`
 * plugin is off by default), and an agent of a plugin that needs setup is listed but refuses to
 * run. Neither is a default: an agent whose plugin is not running is skipped, and with none left
 * the pages say so instead of naming an agent that is not there.
 */
import { listAgents, type AgentSummary, type Fetcher } from './bureau-client.ts';
import { getPlugins, type PluginsSnapshot } from './host-plugins.ts';
import { queryKeys } from './query.ts';

/** An agent as the Bureau lists it, with whether a run of it can start now. */
export type AgentWithReadiness = AgentSummary & {
  /** `false` while the plugin that contributes the agent is not running, such as one that needs setup. */
  readonly ready: boolean;
};

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/** The names of the agents whose plugin is not running: they are listed, and a run of one is refused. */
function unreadyAgentNames(snapshot: PluginsSnapshot): ReadonlySet<string> {
  const names = new Set<string>();
  for (const plugin of snapshot.plugins) {
    if (plugin.status === 'running') continue;
    for (const contribution of plugin.contributions) {
      if (contribution.kind === 'code-agent') names.add(contribution.id);
    }
  }
  return names;
}

/**
 * The agents the Bureau lists, each with whether it can run. A host that does not report its
 * plugins leaves every agent ready, since the run is then the thing that refuses.
 */
export async function listAgentsWithReadiness(
  options: Options = {},
): Promise<readonly AgentWithReadiness[]> {
  const [agents, snapshot] = await Promise.all([
    listAgents(options),
    getPlugins(options).catch(() => undefined),
  ]);
  const unready = snapshot === undefined ? new Set<string>() : unreadyAgentNames(snapshot);
  return agents.map((agent) => ({ ...agent, ready: !unready.has(agent.name) }));
}

/** The first listed agent that can run, or `null` when there is none. */
export async function findDefaultAgent(options: Options = {}): Promise<string | null> {
  const agents = await listAgentsWithReadiness(options);
  return agents.find((agent) => agent.ready)?.name ?? null;
}

/** How long a default agent is trusted before it is asked for again. */
const DEFAULT_AGENT_STALE_TIME_MS = 5_000;

/** The query that reads the default agent, shared by the view probe and the pages that start from it. */
export function defaultAgentQuery() {
  return {
    queryKey: queryKeys.agents.default(),
    queryFn: ({ signal }: { readonly signal?: AbortSignal }) =>
      findDefaultAgent(signal === undefined ? {} : { signal }),
    staleTime: DEFAULT_AGENT_STALE_TIME_MS,
    retry: false,
  };
}
