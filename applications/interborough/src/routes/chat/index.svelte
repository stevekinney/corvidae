<script lang="ts">
  /**
   * The open chat of `chats.svelte`'s list: one chat session, or a new chat. The view frame has
   * already asked the Bureau whether the session exists and may be seen, or whether the agent a new
   * chat names is one the Bureau lists (`app/view-probes.ts`), so this pane reads a session again only for
   * what the header and the run need: its title and its agent. That second read can fail too, such
   * as for a session deleted since the first, and then the pane says so instead of waiting.
   */
  import { untrack } from 'svelte';

  import { ErrorState, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { RETRY_LABEL, VIEW_COPY } from '../../app/copy.ts';
  import { getContext } from '../../lib/bureau-client.ts';
  import { DEFAULT_AGENT } from '../../lib/default-agent.ts';
  import { classifyFault } from '../../lib/faults.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import ChatConversation from './chat-conversation.svelte';

  interface ChatPaneProps {
    /** The session shown; for a new chat, the identifier the client named its thread. */
    sessionId: string;
    /** Whether this is a new chat, which has no session until its first run starts. */
    isNew: boolean;
  }

  let { sessionId, isNew }: ChatPaneProps = $props();

  // The outlet mounts a new route for each path, so the pane is mounted once per chat. A new chat
  // has no session: the client names the thread, and the agent is `?agent=` or the default.
  const chosenAgent = untrack(() => router.current.search.has('agent'));
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
  <ChatConversation
    {sessionId}
    title={null}
    agentName={initialAgent}
    agentChosen={chosenAgent}
    isNew
  />
{:else if context.data}
  <ChatConversation {sessionId} title={context.data.title} agentName={context.data.agentName} />
{:else if context.isError}
  {#if classifyFault(context.error)?.kind === 'not-found' && VIEW_COPY.chat.notFound}
    <ErrorState
      variant="flat"
      title={VIEW_COPY.chat.notFound.title}
      description={VIEW_COPY.chat.notFound.description}
      headingLevel={1}
    />
  {:else}
    <ErrorState
      variant="flat"
      title={VIEW_COPY.chat.error.title}
      description={VIEW_COPY.chat.error.description}
      headingLevel={1}
      retryLabel={RETRY_LABEL}
      onRetry={() => void context.refetch()}
    />
  {/if}
{:else}
  <div class="weft-chat-route" role="status" aria-busy="true" aria-label="Loading the conversation">
    <Skeleton height="1.5rem" width="40%" />
    <Skeleton height="10rem" />
  </div>
{/if}
