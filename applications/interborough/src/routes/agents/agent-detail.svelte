<script lang="ts">
  /**
   * `/agents/:id`: one agent's details, a New chat action when it is published, and the chats the
   * caller has had with it. A file agent's model, tools and skills come from its definition. An
   * agent defined in code has no file and no route exposes its catalog entry, so it shows what
   * `bureau.agents.list` says of it (name, description, kind, revision, publish state) and has no
   * model, tools or skills section at all, not an empty one.
   */
  import { untrack } from 'svelte';

  import { Badge, Button } from '@lostgradient/cinder';
  import { ChatConversationList } from '@lostgradient/chat';
  import { createInfiniteQuery, createQuery } from '@tanstack/svelte-query';

  import { AGENT_EDITOR_COPY, CHAT_COPY } from '../../app/copy.ts';
  import { getAgentDefinition } from '../../lib/agent-definitions.ts';
  import { listAgents, listContexts } from '../../lib/bureau-client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { agentsByName, sessionSummary } from '../chat/session-summary.ts';
  import { canChat, newChatPath, publishLabel } from './agent-presentation.ts';

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

  const rows = $derived(
    (sessions.data?.pages ?? [])
      .flatMap((page) => page.contexts)
      .map((context) => sessionSummary(context, agentsByName(agents.data ?? []))),
  );

  const editPath = `/agents/${encodeURIComponent(id)}/edit`;

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
  <article class="weft-agent" aria-labelledby="weft-agent-title">
    <header class="weft-chat-sessions__header">
      <div>
        <h1 id="weft-agent-title" class="weft-chat-header__title">{agent.displayName}</h1>
        <p class="weft-chat-header__agent">{agent.name}</p>
      </div>
      <div class="weft-agent__actions">
        <!-- An agent defined in code has no file, so there is nothing to edit. -->
        {#if agent.kind === 'file'}
          <Button
            href={router.href(editPath)}
            variant="secondary"
            size="sm"
            onclick={(event) => goTo(event, editPath)}>{AGENT_EDITOR_COPY.editAction}</Button
          >
        {/if}
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

    <div class="weft-agents__badges">
      <Badge variant="neutral" size="sm">{CHAT_COPY.agentKind[agent.kind]}</Badge>
      <Badge variant={canChat(agent) ? 'success' : 'warning'} size="sm">{publishLabel(agent)}</Badge
      >
    </div>
    {#if agent.description}
      <p class="weft-agents__description">{agent.description}</p>
    {/if}

    <dl class="weft-agent__facts">
      <dt>{CHAT_COPY.agentRevision}</dt>
      <dd>{agent.definitionRevision}</dd>
      {#if definition.data?.definition}
        <dt>{CHAT_COPY.agentModel}</dt>
        <dd>{definition.data.definition.model}</dd>
        <dt>{CHAT_COPY.agentTools}</dt>
        <dd>
          {definition.data.definition.tools.length === 0
            ? CHAT_COPY.noneListed
            : definition.data.definition.tools.join(', ')}
        </dd>
        <dt>{CHAT_COPY.agentSkills}</dt>
        <dd>
          {definition.data.definition.skills.length === 0
            ? CHAT_COPY.noneListed
            : definition.data.definition.skills.map((skill) => skill.name).join(', ')}
        </dd>
      {/if}
    </dl>

    <section aria-labelledby="weft-agent-sessions">
      <h2 id="weft-agent-sessions" class="weft-agent__subheading">{CHAT_COPY.agentSessions}</h2>
      <ChatConversationList
        conversations={rows}
        ariaLabel={CHAT_COPY.agentSessions}
        emptyText={CHAT_COPY.noSessions}
        hasMore={sessions.hasNextPage}
        loading={sessions.isFetchingNextPage}
        buttonLabel={CHAT_COPY.loadMore}
        onLoadMore={() => void sessions.fetchNextPage()}
        onSelectConversation={(sessionId) =>
          router.navigate(`/chat/${encodeURIComponent(sessionId)}`)}
      />
    </section>
  </article>
{/if}

<style>
  .weft-agent__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
</style>
