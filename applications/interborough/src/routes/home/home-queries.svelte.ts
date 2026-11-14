/**
 * The reads Home's cards share. Each card reads on its own, so one that fails says so in its own
 * place and the rest stay live; these are the reads more than one card needs, so they are asked
 * once and every card holds the same answer.
 */
import { createQuery, type CreateQueryResult } from '@tanstack/svelte-query';

import { useBureauEventsLive } from '../../app/live-polling.svelte.ts';
import { ATTENTION_POLL_MILLISECONDS } from '../../app/shell/attention-count.svelte.ts';
import { listAttentionItems, type AttentionItem } from '../../lib/bureau-attention.ts';
import {
  listAgents,
  listContexts,
  type AgentSummary,
  type ContextPage,
} from '../../lib/bureau-client.ts';
import { listRunningTasks, type TaskView } from '../../lib/bureau-tasks.ts';
import { getProviders, type ProvidersSnapshot } from '../../lib/host-providers.ts';
import { queryKeys } from '../../lib/query.ts';
import { RECENT_CHAT_LIMIT } from './home-rows.ts';

/** How often the running runs are read again while the Bureau's event feed is not live. */
const RUNNING_POLL_MILLISECONDS = 5_000;

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
    // Three components read this answer, and each mounting beside a failed read would ask again:
    // the page asks again on the timer above, and the card's Try again asks at once.
    retryOnMount: false,
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

/**
 * The runs running now (`listRunningTasks`), which the Running now count and the Running now card
 * both read, so the number and the rows are one answer. A run parked on a review is not among them.
 * While the Bureau's event feed is not live the read is asked again on a timer. Call it while a
 * component initializes.
 */
export function useRunningTasks(): CreateQueryResult<readonly TaskView[]> {
  const bureauLive = useBureauEventsLive();
  return createQuery(() => ({
    queryKey: queryKeys.bureauTasks.running(),
    queryFn: ({ signal }: { signal: AbortSignal }) => listRunningTasks({ signal }),
    // poll-reason: fallback
    refetchInterval: bureauLive() ? false : RUNNING_POLL_MILLISECONDS,
    retry: false,
  }));
}

/**
 * The chats you were last in, newest first (`bureau.contexts.list`), for the Recent chats card and
 * for whether the person has had a chat at all, which ends the first-run checklist. Call it while a
 * component initializes.
 */
export function useRecentChats(): CreateQueryResult<ContextPage> {
  return createQuery(() => ({
    queryKey: queryKeys.contexts.recent(RECENT_CHAT_LIMIT),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      // An archived chat is put away, so Recent chats leaves it out (COR-2285 V5).
      listContexts({ origin: 'chat', archived: 'exclude', limit: RECENT_CHAT_LIMIT }, { signal }),
    retry: false,
  }));
}

/**
 * The host's model providers (`/host/providers`), for whether any holds a key: the first-run
 * checklist's first step and the Start a chat box's blocked row. Call it while a component
 * initializes.
 */
export function useHostProviders(): CreateQueryResult<ProvidersSnapshot> {
  return createQuery(() => ({
    queryKey: queryKeys.hostProviders(),
    queryFn: ({ signal }: { signal: AbortSignal }) => getProviders({ signal }),
    retry: false,
  }));
}
