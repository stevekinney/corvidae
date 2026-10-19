<script lang="ts">
  /**
   * One chat session at `/chat/:sessionId`. The view frame has already asked the Bureau whether the
   * session exists and may be seen (`app/view-probes.ts`), so this route reads it again only for
   * what the header and the run need: its title and its agent.
   */
  import { untrack } from 'svelte';

  import { Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { getContext } from '../../lib/bureau-client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import ChatConversation from './chat-conversation.svelte';

  // The outlet mounts a new route for each path, so the session is read once.
  const sessionId = untrack(() => router.current.params['sessionId'] ?? '');

  const context = createQuery(
    () => ({
      queryKey: queryKeys.contexts.detail(sessionId),
      queryFn: ({ signal }) => getContext(sessionId, { signal }),
      retry: false,
    }),
    undefined,
  );
</script>

{#if context.data}
  <ChatConversation {sessionId} title={context.data.title} agentName={context.data.agentName} />
{:else}
  <div class="weft-chat-route" role="status" aria-busy="true" aria-label="Loading the conversation">
    <Skeleton height="1.5rem" width="40%" />
    <Skeleton height="10rem" />
  </div>
{/if}
