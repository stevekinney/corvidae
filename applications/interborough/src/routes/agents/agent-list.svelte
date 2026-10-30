<script lang="ts">
  /**
   * `/agents`: every agent the Bureau tells the caller of, one flat row each: its name (and its
   * identifier beside it when they differ), its description, its model when the Bureau can tell, its tools,
   * how many chats it has had and when the last was, and the actions that are open to it. New chat
   * is the main one and is offered for every agent.
   *
   * An agent file the Bureau cannot use is not an agent that can run, so `bureau.agents.list`
   * leaves it out. The list also reads `bureau.agents.definitions.list` and shows each invalid file
   * with its error and its path, and a link to its editor, so a broken file is never silently
   * missing. A New agent action opens the agent editor.
   *
   * The chat count and last-chat time are the Bureau's own sessions grouped by agent
   * (`bureau.contexts.list`, every page of it). They are read again each time the page opens, so a
   * chat had since shows.
   */
  import { Badge, Button, CodeLocation } from '@lostgradient/cinder';
  import { Plus } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { AGENT_EDITOR_COPY, CHAT_COPY, MEMORY_COPY } from '../../app/copy.ts';
  import { listAgentDefinitions } from '../../lib/agent-definitions.ts';
  import { agentEditPath, agentMemoryPath, agentPath } from '../../lib/agent-paths.ts';
  import { listAgents, listAllContexts } from '../../lib/bureau-client.ts';
  import { agentFilePath, getHostPaths } from '../../lib/host-paths.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import AgentFacts from './agent-facts.svelte';
  import {
    chatCountText,
    chatUsageByAgent,
    lastChatText,
    newChatPath,
  } from './agent-presentation.ts';

  const agents = createQuery(
    () => ({ queryKey: queryKeys.agents.list(), queryFn: ({ signal }) => listAgents({ signal }) }),
    undefined,
  );

  const chats = createQuery(
    () => ({
      queryKey: queryKeys.contexts.usage(),
      queryFn: ({ signal }) => listAllContexts({ signal, origin: 'chat' }),
      retry: false,
    }),
    undefined,
  );
  const usage = $derived(chatUsageByAgent(chats.data ?? []));

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

<section class="ib-agents" aria-labelledby="weft-agents-title">
  <header class="ib-agents__header">
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
  <ul class="ib-agents__list">
    {#each agents.data ?? [] as agent (agent.name)}
      {@const used = usage.get(agent.name)}
      <li class="ib-agent-row" data-agent={agent.name}>
        <div class="ib-agent-row__body">
          <div class="ib-agent-row__title">
            <a
              class="ib-agent-name"
              data-identifier={agent.displayName === agent.name ? '' : undefined}
              href={router.href(agentPath(agent.name))}
              onclick={(event) => go(event, agentPath(agent.name))}>{agent.displayName}</a
            >
            {#if agent.displayName !== agent.name}
              <code class="ib-agent-id">{agent.name}</code>
            {/if}
          </div>
          {#if agent.description}
            <p class="ib-agent-row__description">{agent.description}</p>
          {/if}
          <div class="ib-agent-row__meta">
            <AgentFacts {agent} />
            <!-- Said only once the Bureau has answered: a failed read is not "no chats yet". -->
            {#if chats.isSuccess}
              <span data-testid="agent-chat-count">{chatCountText(used)}</span>
              {#if lastChatText(used) !== undefined}
                <span data-testid="agent-last-chat">{lastChatText(used)}</span>
              {/if}
            {/if}
          </div>
        </div>
        <div class="ib-agent-row__actions">
          {#if agent.kind === 'file'}
            <Button
              href={router.href(agentEditPath(agent.name))}
              variant="secondary"
              size="sm"
              onclick={(event) => go(event, agentEditPath(agent.name))}
              >{AGENT_EDITOR_COPY.editAction}</Button
            >
          {/if}
          <Button
            href={router.href(agentMemoryPath(agent.name))}
            variant="secondary"
            size="sm"
            onclick={(event) => go(event, agentMemoryPath(agent.name))}>{MEMORY_COPY.link}</Button
          >
          <Button
            href={router.href(newChatPath(agent.name))}
            variant="primary"
            size="sm"
            onclick={(event) => go(event, newChatPath(agent.name))}>{CHAT_COPY.newChat}</Button
          >
        </div>
      </li>
    {/each}
    {#each keyedByOccurrence(invalid, (entry) => entry.id) as { key, item: entry } (key)}
      <li class="ib-agent-row" data-agent={entry.id} data-state="invalid">
        <div class="ib-agent-row__body">
          <div class="ib-agent-row__title">
            <a
              class="ib-agent-name"
              data-identifier
              href={router.href(agentEditPath(entry.id))}
              onclick={(event) => go(event, agentEditPath(entry.id))}>{entry.id}</a
            >
            <Badge variant="danger" size="sm">{AGENT_EDITOR_COPY.invalidBadge}</Badge>
          </div>
          {#if entry.problem}
            <p class="ib-agent-row__description" data-testid="agent-problem">
              <code>{entry.problem.code}</code>: {entry.problem.message}
            </p>
          {/if}
          <CodeLocation file={agentFilePath(directory, entry.id)} data-testid="agent-file-path" />
        </div>
      </li>
    {/each}
  </ul>
</section>
