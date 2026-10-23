<script lang="ts">
  /**
   * `/agents/:id`: one agent, with its name once, its description, what it is made of (its model
   * when the Bureau can tell, its tools and skills), a Memory action that carries how many memories it has, a New
   * chat action when it is published, and the chats the caller has had with it.
   *
   * An agent file shows the version of the file it runs, with a link to the history that lives in
   * its editor. An agent defined in code has no file, so it shows no version and no Edit action.
   * An agent whose listing carries no tools is not claimed to have none: see `agent-facts.svelte`.
   * The only badge an agent carries is "Not published".
   */
  import { untrack } from 'svelte';

  import { Button } from '@lostgradient/cinder';
  import { ChatConversationList } from '@lostgradient/chat';
  import { createInfiniteQuery, createQuery } from '@tanstack/svelte-query';

  import { AGENT_EDITOR_COPY, AGENTS_COPY, CHAT_COPY } from '../../app/copy.ts';
  import { agentEditPath, agentMemoryPath } from '../../lib/agent-paths.ts';
  import { getAgentDefinition } from '../../lib/agent-definitions.ts';
  import { listAgents, listContexts } from '../../lib/bureau-client.ts';
  import { combinePages } from '../../lib/combine-pages.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { listMemories, MEMORY_PAGE_SIZE } from '../../lib/memory-client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { agentsByName, sessionSummary } from '../chat/session-summary.ts';
  import AgentFacts from './agent-facts.svelte';
  import AgentNotPublished from './agent-not-published.svelte';
  import { canChat, memoryActionText, newChatPath, shortVersion } from './agent-presentation.ts';

  const PAGE_SIZE = 20;
  const id = untrack(() => router.current.params['id'] ?? '');

  const agents = createQuery(
    () => ({ queryKey: queryKeys.agents.list(), queryFn: ({ signal }) => listAgents({ signal }) }),
    undefined,
  );
  const agent = $derived(agents.data?.find((entry) => entry.name === id));

  const definition = createQuery(
    () => ({
      queryKey: queryKeys.agents.definition(id),
      queryFn: ({ signal }) => getAgentDefinition(id, { signal }),
      enabled: agent?.kind === 'file',
      retry: false,
    }),
    undefined,
  );
  const fileVersion = $derived(definition.data?.hash ?? undefined);

  const sessions = createInfiniteQuery(
    () => ({
      queryKey: queryKeys.contexts.list(id),
      queryFn: ({ pageParam, signal }) =>
        listContexts({ agentName: id, limit: PAGE_SIZE, offset: pageParam }, { signal }),
      initialPageParam: 0,
      getNextPageParam: (last) => last.nextOffset ?? undefined,
      retry: false,
    }),
    undefined,
  );

  // The memory page's own query, so a visit to either warms the other. A failure drops the count
  // and keeps the action: the memory page itself says why it cannot show memories.
  const memories = createInfiniteQuery(
    () => ({
      queryKey: queryKeys.memory.list(id),
      queryFn: ({ pageParam, signal }) =>
        listMemories(id, { limit: MEMORY_PAGE_SIZE, offset: pageParam }, { signal }),
      initialPageParam: 0,
      getNextPageParam: (last) => last.nextOffset ?? undefined,
      retry: false,
    }),
    undefined,
  );
  const memoryCount = $derived(
    memories.data === undefined
      ? undefined
      : combinePages(
          memories.data.pages,
          (page) => page.memories,
          (memory) => memory.id,
        ).length,
  );
  const memoryLabel = $derived(memoryActionText(memoryCount, memories.hasNextPage));

  const rows = $derived(
    combinePages(
      sessions.data?.pages,
      (page) => page.contexts,
      (context) => context.id,
    ).map((context) => sessionSummary(context, agentsByName(agents.data ?? []))),
  );

  const editPath = agentEditPath(id);
  const memoryPath = agentMemoryPath(id);

  function goTo(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }

  function openNewChat(event: MouseEvent): void {
    goTo(event, newChatPath(id));
  }
</script>

{#if agent}
  <article class="ib-agent" aria-labelledby="weft-agent-title">
    <header class="ib-agent__header">
      <div class="ib-agent__heading">
        <h1
          id="weft-agent-title"
          class="weft-chat-header__title"
          data-identifier={agent.displayName === agent.name ? '' : undefined}
        >
          {agent.displayName}
        </h1>
        {#if agent.displayName !== agent.name}
          <code class="ib-agent-id">{agent.name}</code>
        {/if}
        {#if !canChat(agent)}
          <AgentNotPublished />
        {/if}
      </div>
      <div class="ib-agent__actions">
        <!-- An agent defined in code has no file, so there is nothing to edit. -->
        {#if agent.kind === 'file'}
          <Button
            href={router.href(editPath)}
            variant="secondary"
            size="sm"
            onclick={(event) => goTo(event, editPath)}>{AGENT_EDITOR_COPY.editAction}</Button
          >
        {/if}
        <Button
          href={router.href(memoryPath)}
          variant="secondary"
          size="sm"
          onclick={(event) => goTo(event, memoryPath)}>{memoryLabel}</Button
        >
        {#if canChat(agent)}
          <Button
            href={router.href(newChatPath(id))}
            variant="primary"
            size="sm"
            onclick={openNewChat}>{CHAT_COPY.newChat}</Button
          >
        {/if}
      </div>
    </header>

    {#if agent.description}
      <p class="ib-agent__description">{agent.description}</p>
    {/if}

    <AgentFacts {agent} detailed />

    {#if agent.kind === 'file' && fileVersion !== undefined}
      <p class="ib-agent__version" data-testid="agent-file-version">
        {AGENTS_COPY.fileVersion}
        <code title={fileVersion}>{shortVersion(fileVersion)}</code>
        ·
        <a href={router.href(editPath)} onclick={(event) => goTo(event, editPath)}
          >{AGENTS_COPY.history}</a
        >
      </p>
    {/if}

    <section aria-labelledby="weft-agent-sessions">
      <h2 id="weft-agent-sessions" class="ib-agent__subheading">{CHAT_COPY.agentSessions}</h2>
      <ChatConversationList
        conversations={rows}
        ariaLabel={CHAT_COPY.agentSessions}
        emptyText={CHAT_COPY.noSessions}
        hasMore={sessions.hasNextPage}
        loading={sessions.isFetchingNextPage}
        buttonLabel={CHAT_COPY.loadMore}
        onLoadMore={() => void sessions.fetchNextPage()}
        onSelectConversation={(sessionId) => router.navigate(chatSessionPath(sessionId))}
      />
    </section>
  </article>
{/if}
