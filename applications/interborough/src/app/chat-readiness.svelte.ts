/**
 * Whether a chat can work now, read where a chat is started (COR-2438): the agents the Bureau lists
 * and the host's providers, under the query keys every other page reads them by, put through the
 * one rule (`chatReadiness` in `first-run.ts`) Home's checklist shares. `undefined` while either
 * read is still out; a read that failed says nothing about readiness, so the chat is offered and
 * says what went wrong itself.
 */
import { createQuery } from '@tanstack/svelte-query';

import { listAgents } from '../lib/bureau-client.ts';
import { getProviders } from '../lib/host-providers.ts';
import { queryKeys } from '../lib/query.ts';
import { chatReadiness, type ChatReadiness } from './first-run.ts';

/** Reads whether a chat can work now. Call it while a component initializes. */
export function useChatReadiness(): () => ChatReadiness | undefined {
  const agents = createQuery(
    () => ({
      queryKey: queryKeys.agents.list(),
      queryFn: ({ signal }) => listAgents({ signal }),
      retry: false,
    }),
    undefined,
  );
  const providers = createQuery(
    () => ({
      queryKey: queryKeys.hostProviders(),
      queryFn: ({ signal }) => getProviders({ signal }),
      retry: false,
    }),
    undefined,
  );
  const readiness = $derived.by((): ChatReadiness | undefined => {
    if (agents.isError || providers.isError) return 'ready';
    if (agents.data === undefined || providers.data === undefined) return undefined;
    return chatReadiness({ providers: providers.data.providers, agents: agents.data });
  });
  return () => readiness;
}
