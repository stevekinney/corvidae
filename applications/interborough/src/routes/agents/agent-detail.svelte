<script lang="ts">
  /**
   * `/agents/:agent`: one agent, with its name once, its description, what it is made of (its model
   * when the Bureau can tell, its tools and skills), a Memory action that carries how many memories it has, a New
   * chat action, and three tabs: Chats (the chats had with it, filtered), Instructions (the body of
   * its file and the reference documents it reads) and Settings (its model, limits and guardrails,
   * Delete, and its saved versions with Restore). The tab is in the address (`?tab=`), and Chats is
   * the address with none.
   *
   * An agent file shows the version of the file it runs, with a link to the history that lives in
   * the Settings tab. An agent defined in code has no file, so it shows no version and no Edit action.
   * An agent whose listing carries no tools is not claimed to have none: see `agent-facts.svelte`.
   */
  import { untrack } from 'svelte';

  import { Button, PageHeader, Tabs } from '@lostgradient/cinder';
  import { createInfiniteQuery, createQuery } from '@tanstack/svelte-query';

  import { usePageLabel } from '../../app/breadcrumbs.svelte.ts';
  import { AGENT_EDITOR_COPY, AGENT_PAGE_COPY, AGENTS_COPY, CHAT_COPY } from '../../app/copy.ts';
  import { agentEditPath, agentMemoryPath, agentPath } from '../../lib/agent-paths.ts';
  import { getAgentDefinition } from '../../lib/agent-definitions.ts';
  import { listAgents } from '../../lib/bureau-client.ts';
  import { combinePages } from '../../lib/combine-pages.ts';
  import { listMemories, MEMORY_PAGE_SIZE } from '../../lib/memory-client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import AgentChats from './agent-chats.svelte';
  import AgentFacts from './agent-facts.svelte';
  import AgentInstructions from './agent-instructions.svelte';
  import AgentSettings from './agent-settings.svelte';
  import { memoryActionText, newChatPath, shortVersion } from './agent-presentation.ts';

  const id = untrack(() => router.current.params['agent'] ?? '');

  let activeTab = $state(untrack(() => router.search.get('tab') ?? 'chats'));

  const agents = createQuery(
    () => ({ queryKey: queryKeys.agents.list(), queryFn: ({ signal }) => listAgents({ signal }) }),
    undefined,
  );
  const agent = $derived(agents.data?.find((entry) => entry.name === id));
  // The top bar's trail names the agent as a person reads it, once the listing has answered.
  usePageLabel(() => ({ path: agentPath(id), label: agent?.displayName }));

  const definition = createQuery(
    () => ({
      queryKey: queryKeys.agents.definition(id),
      queryFn: ({ signal }) => getAgentDefinition(id, { signal }),
      // A file's version is in the header; the other tabs read the agent's own statement of itself too.
      enabled: agent !== undefined && (agent.kind === 'file' || activeTab !== 'chats'),
      retry: false,
    }),
    undefined,
  );
  const fileVersion = $derived(definition.data?.hash ?? undefined);

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

  const editPath = agentEditPath(id);
  const settingsPath = `${agentPath(id)}?tab=settings`;
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

  type TabValue = 'chats' | 'instructions' | 'settings';
  const TABS: readonly TabValue[] = ['chats', 'instructions', 'settings'];

  // The URL owns the tab, so a tab can be linked and the back button returns to it: `activeTab`
  // follows `?tab=`, and a tab the person picks writes the address from Tabs' `onValueChange`, so
  // a jump through history to an older `?tab=` entry is only read, never written back over. Chats
  // is the address with no `tab`.

  function writeTab(next: string): void {
    const search = new URLSearchParams(router.search);
    if ((search.get('tab') ?? 'chats') === next) return;
    if (next === 'chats') search.delete('tab');
    else search.set('tab', next);
    const query = search.size === 0 ? '' : `?${search.toString()}`;
    router.navigate(`${agentPath(id)}${query}`);
  }

  $effect(() => {
    const fromUrl = router.search.get('tab') ?? 'chats';
    if (fromUrl !== activeTab) activeTab = fromUrl;
  });

  // An address that names a tab this page does not have is Chats: say so in the address, in place.
  $effect(() => {
    const named = router.search.get('tab');
    if (named === null || TABS.some((tab) => tab === named)) return;
    const search = new URLSearchParams(router.search);
    search.delete('tab');
    const query = search.size === 0 ? '' : `?${search.toString()}`;
    router.navigate(`${agentPath(id)}${query}`, { replace: true });
  });
</script>

{#snippet title()}
  <span class="ib-agent-title" data-identifier={agent?.displayName === agent?.name ? '' : undefined}
    >{agent?.displayName}</span
  >
{/snippet}

{#snippet headerActions()}
  <!-- An agent defined in code has no file, so there is nothing to edit. -->
  {#if agent?.kind === 'file'}
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
  <Button href={router.href(newChatPath(id))} variant="primary" size="sm" onclick={openNewChat}
    >{CHAT_COPY.newChat}</Button
  >
{/snippet}

{#if agent}
  <article class="ib-agent" data-page="agent-detail">
    <PageHeader data-testid="agent-header" headingLevel={1} {title} actions={headerActions} />
    {#if agent.displayName !== agent.name}
      <code class="ib-agent-id">{agent.name}</code>
    {/if}

    {#if agent.description}
      <p class="ib-agent__description">{agent.description}</p>
    {/if}

    <AgentFacts {agent} detailed />

    {#if agent.kind === 'file' && fileVersion !== undefined}
      <p class="ib-agent__version" data-testid="agent-file-version">
        {AGENTS_COPY.fileVersion}
        <code title={fileVersion}>{shortVersion(fileVersion)}</code>
        ·
        <a href={router.href(settingsPath)} onclick={(event) => goTo(event, settingsPath)}
          >{AGENTS_COPY.history}</a
        >
      </p>
    {/if}

    <Tabs bind:value={activeTab} onValueChange={writeTab}>
      <Tabs.List label={AGENT_PAGE_COPY.tabsLabel}>
        <Tabs.Trigger value="chats">{AGENT_PAGE_COPY.tabs.chats}</Tabs.Trigger>
        <Tabs.Trigger value="instructions">{AGENT_PAGE_COPY.tabs.instructions}</Tabs.Trigger>
        <Tabs.Trigger value="settings">{AGENT_PAGE_COPY.tabs.settings}</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Panel value="chats">
        <AgentChats {id} />
      </Tabs.Panel>
      <Tabs.Panel value="instructions">
        <AgentInstructions
          {editPath}
          detail={definition.data}
          failed={definition.isError}
          onRetry={() => void definition.refetch()}
        />
      </Tabs.Panel>
      <Tabs.Panel value="settings">
        <AgentSettings
          {id}
          detail={definition.data}
          failed={definition.isError}
          onRetry={() => void definition.refetch()}
        />
      </Tabs.Panel>
    </Tabs>
  </article>
{/if}
