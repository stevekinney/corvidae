/**
 * The reads Home's cards share. Each card reads on its own, so one that fails says so in its own
 * place and the rest stay live; these are the reads more than one card needs, so they are asked
 * once and every card holds the same answer.
 */
import { createQuery, type CreateQueryResult } from '@tanstack/svelte-query';

import { ATTENTION_POLL_MILLISECONDS } from '../../app/shell/attention-count.svelte.ts';
import { listAttentionItems, type AttentionItem } from '../../lib/bureau-attention.ts';
import { listAgents, type AgentSummary } from '../../lib/bureau-client.ts';
import { queryKeys } from '../../lib/query.ts';

/**
 * The system problems that need attention (`bureau.health.attention`). Nothing in the event feeds
 * announces an alert starting to fire or a schedule missing a run, so it is asked again on a timer,
 * as the sidebar's Health dot is. A caller without `bureau.diagnostics:read` is refused, which is a
 * failed read: a card must not say all is well about what it could not read. Call it while a
 * component initializes.
 */
export function useAttentionItems(): CreateQueryResult<readonly AttentionItem[]> {
  return createQuery(() => ({
    queryKey: queryKeys.bureauAttention.items(),
    queryFn: ({ signal }: { signal: AbortSignal }) => listAttentionItems({ signal }),
    // poll-reason: fallback
    refetchInterval: ATTENTION_POLL_MILLISECONDS,
    retry: false,
  }));
}

/**
 * The agents, for the name each row says an agent by. The catalog is shared with every page that
 * shows one; a row falls back to the identifier until it arrives. Call it while a component
 * initializes.
 */
export function useAgentList(): CreateQueryResult<readonly AgentSummary[]> {
  return createQuery(() => ({
    queryKey: queryKeys.agents.list(),
    queryFn: ({ signal }: { signal: AbortSignal }) => listAgents({ signal }),
    retry: false,
  }));
}
