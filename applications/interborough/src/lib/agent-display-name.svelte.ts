/**
 * The name an agent goes by on screen. The catalog answers with a display name beside the
 * identifier, so a page that shows an agent asks for the catalog (shared with every other page that
 * does) and falls back to the identifier until it arrives or when the agent is not in it.
 */
import { createQuery } from '@tanstack/svelte-query';

import { listAgents } from './bureau-client.ts';
import { queryKeys } from './query.ts';

/** Returns a function from an agent's identifier to the name to show for it. */
export function useAgentDisplayName(): (agentName: string) => string {
  const catalog = createQuery(
    () => ({
      queryKey: queryKeys.agents.list(),
      queryFn: ({ signal }) => listAgents({ signal }),
      retry: false,
    }),
    undefined,
  );
  return (agentName) =>
    catalog.data?.find((agent) => agent.name === agentName)?.displayName ?? agentName;
}
