<script lang="ts">
  /**
   * `/agents`: every agent the Bureau tells the caller of, as compact rows in one bordered list: an
   * avatar, its name (and its identifier beside it when they differ), its description, how many
   * chats it has had (a link to the agent's page) and when the last was, a Needs you marker when a
   * chat of its own waits on the person, and the actions that are open to it: Memory and New chat
   * as icon buttons, and Edit for a file. The toolbar under the heading has the count, a search
   * over the names, and New agent.
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
  import {
    Avatar,
    Badge,
    Button,
    CodeLocation,
    DataList,
    EmptyState,
    FilterBar,
    PageHeader,
    StackedListItem,
  } from '@lostgradient/cinder';
  import { Brain, MessageSquarePlus, Plus } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { AGENT_EDITOR_COPY, AGENTS_COPY, CHAT_COPY, MEMORY_COPY } from '../../app/copy.ts';
  import RecordsToolbar from '../../app/records/records-toolbar.svelte';
  import { listAgentDefinitions } from '../../lib/agent-definitions.ts';
  import { agentEditPath, agentMemoryPath, agentPath } from '../../lib/agent-paths.ts';
  import { listAgents, listAllContexts } from '../../lib/bureau-client.ts';
  import { agentFilePath, getHostPaths } from '../../lib/host-paths.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
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

  // The search narrows the names and descriptions on screen; the Bureau lists every agent at once.
  let search = $state('');
  const needle = $derived(search.trim().toLowerCase());
  const visible = $derived(
    (agents.data ?? []).filter(
      (agent) =>
        needle === '' ||
        agent.name.toLowerCase().includes(needle) ||
        agent.displayName.toLowerCase().includes(needle) ||
        (agent.description ?? '').toLowerCase().includes(needle),
    ),
  );
  const visibleInvalid = $derived(
    needle === '' ? invalid : invalid.filter((entry) => entry.id.toLowerCase().includes(needle)),
  );
  const count = $derived(visible.length + visibleInvalid.length);

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<section class="ib-agents ib-records" aria-label={CHAT_COPY.agentsTitle}>
  <PageHeader title={CHAT_COPY.agentsTitle} headingLevel={1} />

  {#snippet filterBar()}
    <FilterBar
      aria-label={AGENTS_COPY.filtersLabel}
      searchQuery={search}
      searchPlaceholder={AGENTS_COPY.searchPlaceholder}
      searchAriaLabel={AGENTS_COPY.searchLabel}
      onSearchChange={(query) => (search = query)}
      onClearAll={() => (search = '')}
    />
  {/snippet}
  {#snippet newAgent()}
    <Button
      href={router.href('/agents/new')}
      variant="primary"
      size="sm"
      onclick={(event) => go(event, '/agents/new')}
    >
      <Plus size={14} aria-hidden="true" />
      {AGENT_EDITOR_COPY.newAction}
    </Button>
  {/snippet}
  <RecordsToolbar count={AGENTS_COPY.count(count)} filters={filterBar} action={newAgent} />

  {#if count === 0 && needle !== '' && agents.isSuccess}
    <EmptyState
      kind="filtered"
      title={AGENTS_COPY.noMatch.title}
      description={AGENTS_COPY.noMatch.description}
      headingLevel={2}
      clearFiltersLabel={AGENTS_COPY.clearAction}
      onClearFilters={() => (search = '')}
    />
  {:else if count === 0 && agents.isSuccess}
    <EmptyState
      kind="first-use"
      title={AGENTS_COPY.empty.title}
      description={AGENTS_COPY.empty.description}
      headingLevel={2}
    >
      {#snippet action()}{@render newAgent()}{/snippet}
    </EmptyState>
  {:else}
    <DataList
      class="ib-agents__list"
      items={visible}
      key={(agent) => agent.name}
      density="condensed"
      aria-label={CHAT_COPY.agentsTitle}
    >
      {#snippet children(agent)}
        {@const used = usage.get(agent.name)}
        <StackedListItem data-agent={agent.name}>
          {#snippet leading()}
            <!-- The name beside it says whose it is, so the avatar adds only a picture. -->
            <span aria-hidden="true"><Avatar name={agent.displayName} size="sm" /></span>
          {/snippet}
          {#snippet title()}
            <span class="ib-agent-row__title">
              <a
                class="ib-agent-name"
                data-identifier={agent.displayName === agent.name ? '' : undefined}
                href={router.href(agentPath(agent.name))}
                onclick={(event) => go(event, agentPath(agent.name))}>{agent.displayName}</a
              >
              {#if agent.displayName !== agent.name}
                <code class="ib-agent-id">{agent.name}</code>
              {/if}
            </span>
          {/snippet}
          {#snippet description()}
            {#if agent.description}
              <span class="ib-agent-row__description">{agent.description}</span>
            {/if}
          {/snippet}
          {#snippet meta()}
            <!-- Said only once the Bureau has answered: a failed read is not "no chats yet". -->
            {#if chats.isSuccess}
              <span class="ib-agent-row__meta">
                {#if used === undefined}
                  <span data-testid="agent-chat-count">{chatCountText(used)}</span>
                {:else}
                  <a
                    data-testid="agent-chat-count"
                    href={router.href(agentPath(agent.name))}
                    onclick={(event) => go(event, agentPath(agent.name))}>{chatCountText(used)}</a
                  >
                {/if}
                {#if lastChatText(used) !== undefined}
                  <span data-testid="agent-last-chat">{lastChatText(used)}</span>
                {/if}
                {#if used !== undefined && used.waiting > 0}
                  <Badge variant="warning" size="sm" data-testid="agent-needs-you"
                    >{AGENTS_COPY.needsYou}</Badge
                  >
                {/if}
              </span>
            {/if}
          {/snippet}
          {#snippet trailing()}
            <span class="ib-agent-row__actions">
              {#if agent.kind === 'file'}
                <Button
                  href={router.href(agentEditPath(agent.name))}
                  variant="ghost"
                  size="sm"
                  onclick={(event) => go(event, agentEditPath(agent.name))}
                  >{AGENT_EDITOR_COPY.editAction}</Button
                >
              {/if}
              <Button
                href={router.href(agentMemoryPath(agent.name))}
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={MEMORY_COPY.link}
                title={MEMORY_COPY.link}
                onclick={(event) => go(event, agentMemoryPath(agent.name))}
              >
                <Brain size={16} aria-hidden="true" />
              </Button>
              <Button
                href={router.href(newChatPath(agent.name))}
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={CHAT_COPY.newChat}
                title={CHAT_COPY.newChat}
                onclick={(event) => go(event, newChatPath(agent.name))}
              >
                <MessageSquarePlus size={16} aria-hidden="true" />
              </Button>
            </span>
          {/snippet}
        </StackedListItem>
      {/snippet}
    </DataList>
    {#if visibleInvalid.length > 0}
      <DataList
        class="ib-agents__list"
        items={[...keyedByOccurrence(visibleInvalid, (entry) => entry.id)]}
        key={(entry) => entry.key}
        density="condensed"
        aria-label={AGENTS_COPY.invalidListLabel}
      >
        {#snippet children({ item: entry })}
          <StackedListItem data-agent={entry.id} data-state="invalid">
            {#snippet title()}
              <span class="ib-agent-row__title">
                <a
                  class="ib-agent-name"
                  data-identifier
                  href={router.href(agentEditPath(entry.id))}
                  onclick={(event) => go(event, agentEditPath(entry.id))}>{entry.id}</a
                >
                <Badge variant="danger" size="sm">{AGENT_EDITOR_COPY.invalidBadge}</Badge>
              </span>
            {/snippet}
            {#snippet description()}
              {#if entry.problem}
                <span class="ib-agent-row__description" data-testid="agent-problem">
                  <code>{entry.problem.code}</code>: {entry.problem.message}
                </span>
              {/if}
            {/snippet}
            {#snippet meta()}
              <CodeLocation
                class="weft-code-location"
                file={agentFilePath(directory, entry.id)}
                data-testid="agent-file-path"
              />
            {/snippet}
          </StackedListItem>
        {/snippet}
      </DataList>
    {/if}
  {/if}
</section>
