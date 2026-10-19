<script lang="ts">
  /**
   * `/agents`: every agent the Bureau tells the caller of, each with where it is defined, whether it
   * is published, and a New chat action when it is. An agent that is not published carries the
   * words for that and no chat action.
   *
   * An agent file the Bureau cannot use is not an agent that can run, so `bureau.agents.list`
   * leaves it out. The list also reads `bureau.agents.definitions.list` and shows each invalid file
   * with its error and its path, and a link to its editor, so a broken file is never silently
   * missing. A New agent action opens the agent editor.
   */
  import { Badge, Button, CodeLocation } from '@lostgradient/cinder';
  import { Plus } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { AGENT_EDITOR_COPY, CHAT_COPY } from '../../app/copy.ts';
  import { listAgentDefinitions } from '../../lib/agent-definitions.ts';
  import { listAgents } from '../../lib/bureau-client.ts';
  import { agentFilePath, getHostPaths } from '../../lib/host-paths.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { canChat, newChatPath, publishLabel } from './agent-presentation.ts';

  const agents = createQuery(
    () => ({ queryKey: queryKeys.agents.list(), queryFn: ({ signal }) => listAgents({ signal }) }),
    undefined,
  );

  const definitions = createQuery(
    () => ({
      queryKey: queryKeys.agents.definitions(),
      queryFn: ({ signal }) => listAgentDefinitions({ signal }),
    }),
    undefined,
  );
  const invalid = $derived((definitions.data ?? []).filter((entry) => entry.state === 'invalid'));

  // Where the files are. A host that does not say shows the path relative to the state directory.
  const hostPaths = createQuery(
    () => ({ queryKey: queryKeys.hostPaths(), queryFn: ({ signal }) => getHostPaths({ signal }) }),
    undefined,
  );
  const directory = $derived(hostPaths.data?.agentDirectory ?? AGENT_EDITOR_COPY.fallbackDirectory);

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<section class="weft-agents" aria-labelledby="weft-agents-title">
  <header class="weft-agents__header">
    <h1 id="weft-agents-title" class="weft-chat-header__title">{CHAT_COPY.agentsTitle}</h1>
    <Button
      href={router.href('/agents/new')}
      variant="primary"
      size="sm"
      onclick={(event) => go(event, '/agents/new')}
    >
      <Plus size={14} aria-hidden="true" />
      {AGENT_EDITOR_COPY.newAction}
    </Button>
  </header>
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
    {#each keyedByOccurrence(invalid, (entry) => entry.id) as { key, item: entry } (key)}
      <li class="weft-agents__row" data-agent={entry.id} data-state="invalid">
        <div class="weft-agents__identity">
          <a
            class="weft-agents__name"
            href={router.href(`/agents/${encodeURIComponent(entry.id)}/edit`)}
            onclick={(event) => go(event, `/agents/${encodeURIComponent(entry.id)}/edit`)}
            >{entry.id}</a
          >
          {#if entry.problem}
            <p class="weft-agents__description" data-testid="agent-problem">
              <code>{entry.problem.code}</code>: {entry.problem.message}
            </p>
          {/if}
          <CodeLocation file={agentFilePath(directory, entry.id)} data-testid="agent-file-path" />
        </div>
        <div class="weft-agents__badges">
          <Badge variant="danger" size="sm">{AGENT_EDITOR_COPY.invalidBadge}</Badge>
        </div>
      </li>
    {/each}
  </ul>
</section>

<style>
  .weft-agents__header {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  }
</style>
