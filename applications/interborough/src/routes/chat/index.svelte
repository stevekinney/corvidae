<script lang="ts">
  /**
   * One chat session at `/chat/:sessionId`, or a new chat at `/chat/new`. The view frame has
   * already asked the Bureau whether the session exists and may be seen, or whether the agent a new
   * chat names is published (`app/view-probes.ts`), so this route reads a session again only for
   * what the header and the run need: its title and its agent.
   */
  import { untrack } from 'svelte';

  import { Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { getContext } from '../../lib/bureau-client.ts';
  import { DEFAULT_AGENT } from '../../lib/default-agent.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import ChatConversation from './chat-conversation.svelte';

  // The outlet mounts a new route for each path, so the session is read once. A new chat has none:
  // the client names the thread, and the agent is `?agent=` or the default.
  const isNew = untrack(() => router.current.route?.pattern === '/chat/new');
  const sessionId = untrack(() =>
    isNew ? crypto.randomUUID() : (router.current.params['sessionId'] ?? ''),
  );
  const initialAgent = untrack(() => router.current.search.get('agent') ?? DEFAULT_AGENT);

  const context = createQuery(
    () => ({
      queryKey: queryKeys.contexts.detail(sessionId),
      queryFn: ({ signal }) => getContext(sessionId, { signal }),
      enabled: !isNew,
      retry: false,
    }),
    undefined,
  );
</script>

{#if isNew}
  <ChatConversation {sessionId} title={null} agentName={initialAgent} isNew />
{:else if context.data}
  <ChatConversation {sessionId} title={context.data.title} agentName={context.data.agentName} />
{:else}
  <div class="weft-chat-route" role="status" aria-busy="true" aria-label="Loading the conversation">
    <Skeleton height="1.5rem" width="40%" />
    <Skeleton height="10rem" />
  </div>
{/if}
