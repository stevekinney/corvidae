/** The shared Bureau agent-list query used by the route probe and agent pages. */
import { listAgents } from './bureau-client.ts';
import { queryKeys } from './query.ts';

/** How long the route probe's answer remains fresh for the page that follows it. */
export const AGENTS_LIST_STALE_TIME_MS = 5_000;

/** The options all agent-list readers share, including TanStack's abort signal. */
export function agentsListQuery() {
  return {
    queryKey: queryKeys.agents.list(),
    queryFn: ({ signal }: { readonly signal: AbortSignal }) => listAgents({ signal }),
    staleTime: AGENTS_LIST_STALE_TIME_MS,
    retry: false,
  };
}
