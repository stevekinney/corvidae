/**
 * Reads what the audit log needs to word its records (`audit-events.ts`): the chats runs belong to,
 * the reviews tool calls wait in, the schedules that missed runs, the memories that were corrected,
 * and the catalogs that name agents and tools for a person. Each is its own query, keyed by what it
 * reads, so a page of records that arrives later asks only for what it adds, and a lookup that
 * fails leaves its sentence plainer instead of failing the log.
 */
import { createQueries, createQuery } from '@tanstack/svelte-query';

import { getAgentCatalog } from '../../lib/agent-definitions.ts';
import { agentLabel } from '../../lib/agent-label.ts';
import type { AuditRecord } from '../../lib/bureau-audit.ts';
import { getContext, listAgents } from '../../lib/bureau-client.ts';
import { getBureauReview, type BureauToolApproval } from '../../lib/bureau-reviews.ts';
import { listBureauSchedules } from '../../lib/bureau-schedules.ts';
import { getMemory } from '../../lib/memory-client.ts';
import { queryKeys } from '../../lib/query.ts';
import { lookupRequestsFor, type AuditLookups, type AuditTool } from './audit-events.ts';

/** The lookups for the records the page holds, which fill in as the reads arrive. */
export function useAuditLookups(records: () => readonly AuditRecord[]): {
  readonly current: AuditLookups;
} {
  const requests = $derived(lookupRequestsFor(records()));

  const catalog = createQuery(
    () => ({
      queryKey: queryKeys.agents.list(),
      queryFn: ({ signal }) => listAgents({ signal }),
      retry: false,
      staleTime: 60_000,
    }),
    undefined,
  );
  const tools = createQuery(
    () => ({
      queryKey: queryKeys.agents.catalog(),
      queryFn: ({ signal }) => getAgentCatalog({ signal }),
      retry: false,
      staleTime: 60_000,
    }),
    undefined,
  );
  const schedules = createQuery(
    () => ({
      queryKey: queryKeys.audit.schedules(),
      queryFn: ({ signal }) => listBureauSchedules({ signal }),
      enabled: requests.scheduleIds.length > 0,
      retry: false,
      staleTime: 60_000,
    }),
    undefined,
  );
  const reviews = createQueries(() => ({
    queries: requests.reviewIds.map((reviewId) => ({
      queryKey: queryKeys.bureauReviews.detail(reviewId),
      queryFn: ({ signal }: { signal: AbortSignal }) => getBureauReview(reviewId, { signal }),
      retry: false,
      staleTime: 60_000,
    })),
  }));
  // A tool's records name no chat, so the chat of one is the chat of the review it waits in.
  const reviewSessionIds = $derived(
    reviews.flatMap((result) =>
      result.isSuccess && result.data.kind === 'tool-approval' ? [result.data.sessionId] : [],
    ),
  );
  const sessionIds = $derived([...new Set([...requests.sessionIds, ...reviewSessionIds])]);
  const chats = createQueries(() => ({
    queries: sessionIds.map((sessionId) => ({
      queryKey: queryKeys.contexts.detail(sessionId),
      queryFn: ({ signal }: { signal: AbortSignal }) => getContext(sessionId, { signal }),
      retry: false,
      staleTime: 60_000,
    })),
  }));
  const memories = createQueries(() => ({
    queries: requests.memories.map(({ agent, id }) => ({
      queryKey: queryKeys.memory.detail(agent, id),
      queryFn: ({ signal }: { signal: AbortSignal }) => getMemory(agent, id, { signal }),
      retry: false,
      staleTime: 60_000,
    })),
  }));

  const current = $derived.by((): AuditLookups => {
    const chatTitles = new Map<string, string | null>();
    sessionIds.forEach((sessionId, index) => {
      const result = chats[index];
      if (result?.isSuccess === true) chatTitles.set(sessionId, result.data.title);
      // A chat that was deleted since has no title, which is different from one not read yet.
      else if (result?.isError === true) chatTitles.set(sessionId, null);
    });
    const reviewsById = new Map<string, BureauToolApproval | null>();
    requests.reviewIds.forEach((reviewId, index) => {
      const result = reviews[index];
      if (result?.isSuccess === true) {
        reviewsById.set(reviewId, result.data.kind === 'tool-approval' ? result.data : null);
      } else if (result?.isError === true) reviewsById.set(reviewId, null);
    });
    const memoryText = new Map<string, string>();
    requests.memories.forEach(({ id }, index) => {
      const result = memories[index];
      if (result?.isSuccess === true) memoryText.set(id, result.data.memory.content);
    });
    const scheduleNames = new Map<string, string>();
    for (const schedule of schedules.data ?? []) {
      if (schedule.description !== null) scheduleNames.set(schedule.id, schedule.description);
    }
    const toolsByName = new Map<string, AuditTool>();
    for (const tool of tools.data?.tools ?? []) {
      toolsByName.set(tool.name, { title: tool.title, tier: tool.tier });
    }
    const agents = catalog.data;
    return {
      chatTitles,
      scheduleNames,
      reviews: reviewsById,
      memories: memoryText,
      tools: toolsByName,
      agentName: (identifier) => agentLabel(identifier, agents),
    };
  });

  return {
    get current() {
      return current;
    },
  };
}
