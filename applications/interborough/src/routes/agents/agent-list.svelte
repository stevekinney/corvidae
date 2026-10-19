<script lang="ts">
  /**
   * `/agents`: every agent the Bureau tells the caller of, each with where it is defined, whether it
   * is published, and a New chat action when it is. An agent that is not published carries the
   * words for that and no chat action.
   */
  import { Badge, Button } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { CHAT_COPY } from '../../app/copy.ts';
  import { listAgents } from '../../lib/bureau-client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { canChat, newChatPath, publishLabel } from './agent-presentation.ts';

  const agents = createQuery(
    () => ({ queryKey: queryKeys.agents.list(), queryFn: ({ signal }) => listAgents({ signal }) }),
    undefined,
  );

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<section class="weft-agents" aria-labelledby="weft-agents-title">
  <h1 id="weft-agents-title" class="weft-chat-header__title">{CHAT_COPY.agentsTitle}</h1>
  <ul class="weft-agents__list">
    {#each agents.data ?? [] as agent (agent.name)}
      <li class="weft-agents__row" data-agent={agent.name}>
        <div class="weft-agents__identity">
          <a
            class="weft-agents__name"
            href={router.href(`/agents/${encodeURIComponent(agent.name)}`)}
            onclick={(event) => go(event, `/agents/${encodeURIComponent(agent.name)}`)}
            >{agent.displayName}</a
          >
          {#if agent.description}
            <p class="weft-agents__description">{agent.description}</p>
          {/if}
        </div>
        <div class="weft-agents__badges">
          <Badge variant="neutral" size="sm">{CHAT_COPY.agentKind[agent.kind]}</Badge>
          <Badge variant={canChat(agent) ? 'success' : 'warning'} size="sm"
            >{publishLabel(agent)}</Badge
          >
        </div>
        {#if canChat(agent)}
          <Button
            href={router.href(newChatPath(agent.name))}
            variant="secondary"
            size="sm"
            onclick={(event) => go(event, newChatPath(agent.name))}>{CHAT_COPY.newChat}</Button
          >
        {/if}
      </li>
    {/each}
  </ul>
</section>
