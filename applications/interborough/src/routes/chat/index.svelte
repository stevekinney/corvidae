<script lang="ts">
  /**
   * The open chat of `chats.svelte`'s list: one chat session, or a new chat. The view frame has
   * already asked the Bureau whether the session exists and may be seen, or whether the agent a new
   * chat names is one the Bureau lists (`app/view-probes.ts`), so this pane reads a session again only for
   * what the header and the run need: its title and its agent. That second read can fail too, such
   * as for a session deleted since the first, and then the pane says so instead of waiting.
   */
  import { untrack } from 'svelte';

  import { Button, ErrorState } from '@lostgradient/cinder';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { usePageLabel } from '../../app/breadcrumbs.svelte.ts';
  import { getConnection } from '../../app/connection.svelte.ts';
  import { CHAT_COPY } from '../../app/copy/chat.ts';
  import { VIEW_COPY } from '../../app/copy/view-pages.ts';
  import ForbiddenState from '../../app/forbidden-state.svelte';
  import NotFoundState from '../../app/not-found-state.svelte';
  import { getContext } from '../../lib/bureau-client.ts';
  import { defaultAgentQuery, workflowAuthorQuery } from '../../lib/default-agent.ts';
  import { classifyFault, isNetworkFailure } from '../../lib/faults.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { startedFromWorkflows } from '../../lib/new-chat-address.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import ChatConversation from './chat-conversation.svelte';
  import ChatLoading from './chat-loading.svelte';
  import NewChatLoading from './new-chat-loading.svelte';

  interface ChatPaneProps {
    /** The session shown; for a new chat, the identifier the client named its thread. */
    sessionId: string;
    /** Whether this is a new chat, which has no session until its first run starts. */
    isNew: boolean;
    /** The agent the list says the chat is with, as a person reads it, for the placeholders while the chat is read. */
    agent?: string | undefined;
  }

  let { sessionId, isNew, agent }: ChatPaneProps = $props();
  const queryClient = useQueryClient();
  const connection = getConnection();

  // The outlet mounts a new route for each path, so the pane is mounted once per chat. A new chat
  // has no session: the client names the thread, and the agent is `?agent=` or the default.
  // Whether this pane began as a new chat is read once too: the address becomes the chat's own when
  // its run starts, and the conversation, with its live run, stays mounted through that.
  const startsNew = untrack(() => isNew);
  const namedAgent = untrack(() => router.current.search.get('agent'));
  // Without `?agent=` a new chat starts with the first agent that can run. The view frame has
  // already asked, so this is the cached answer; `null` means no agent can run. A chat started from
  // Workflows ("Ask an agent to write one") begins with an agent that has the Create workflow tool
  // instead; with none it has no agent yet, and its composer says so.
  const fromWorkflows = untrack(() => startsNew && startedFromWorkflows(router.current.search));
  const defaultAgent = createQuery(() => {
    const query = fromWorkflows ? workflowAuthorQuery() : defaultAgentQuery();
    return {
      ...query,
      queryKey: query.queryKey as readonly string[],
      enabled: startsNew && namedAgent === null,
    };
  }, undefined);

  const context = createQuery(
    () => ({
      queryKey: queryKeys.contexts.detail(sessionId),
      queryFn: ({ signal }) => getContext(sessionId, { signal }),
      enabled: !startsNew,
      retry: false,
    }),
    undefined,
  );

  /** Whether the chat could not be read and there is nothing of it to show: the error state is the page. */
  const failedToLoad = $derived(
    !startsNew &&
      context.data === undefined &&
      context.isError &&
      classifyFault(context.error)?.kind !== 'not-found' &&
      classifyFault(context.error)?.kind !== 'unauthorized',
  );
  // The breadcrumb names a chat that is not read yet, or cannot be read, as "This chat", not by its
  // identifier. Once the chat loads, the conversation names it by its title.
  usePageLabel(() => ({
    path: chatSessionPath(sessionId),
    label:
      failedToLoad || (!startsNew && context.data === undefined && context.isPending)
        ? CHAT_COPY.load.crumb
        : undefined,
  }));
  // A read that got no answer with nothing to show is the full error state, and the shell's banner
  // stays out: a banner says the data on screen is old, and none of this chat is.
  $effect(() => {
    if (!failedToLoad || !isNetworkFailure(context.error)) return undefined;
    connection.setShownInPlace(true);
    return () => connection.setShownInPlace(false);
  });

  /** Stops asking for a chat that is slow to load, and goes back to the list. */
  function cancelLoading(): void {
    void queryClient.cancelQueries({ queryKey: queryKeys.contexts.detail(sessionId) });
    router.navigate('/chats');
  }
</script>

{#if startsNew}
  {#if namedAgent !== null || defaultAgent.data !== undefined}
    <ChatConversation
      {sessionId}
      title={null}
      agentName={namedAgent ?? defaultAgent.data ?? ''}
      isNew
      {fromWorkflows}
    />
  {:else}
    <NewChatLoading onCancel={() => router.navigate('/chats')} />
  {/if}
{:else if context.data}
  <ChatConversation {sessionId} title={context.data.title} agentName={context.data.agentName} />
{:else if context.isError}
  {#if classifyFault(context.error)?.kind === 'not-found' && VIEW_COPY.chat.notFound}
    <NotFoundState
      title={VIEW_COPY.chat.notFound.title}
      description={VIEW_COPY.chat.notFound.description}
      view="chat"
      create={VIEW_COPY.chat.notFound.create}
      back={VIEW_COPY.chat.notFound.back}
    />
  {:else if classifyFault(context.error)?.kind === 'unauthorized'}
    <ForbiddenState
      title={VIEW_COPY.chat.forbidden.title}
      requirement={VIEW_COPY.chat.forbidden.requirement}
    />
  {:else}
    <!-- Nothing old to show, so the error state is the whole conversation area: no banner above it,
         no composer under it (there is nothing to send to), and the list beside it stays live. -->
    <ErrorState
      title={CHAT_COPY.load.errorTitle}
      description={CHAT_COPY.load.errorDescription}
      headingLevel={1}
      retryLabel={CHAT_COPY.load.tryAgain}
      onRetry={() => void context.refetch()}
    >
      {#snippet secondaryAction()}
        <Button variant="ghost" onclick={() => router.navigate('/chats')}>
          {CHAT_COPY.load.backToChats}
        </Button>
      {/snippet}
    </ErrorState>
  {/if}
{:else}
  <ChatLoading {agent} onCancel={cancelLoading} />
{/if}
