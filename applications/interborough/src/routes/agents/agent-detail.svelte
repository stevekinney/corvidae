<script lang="ts">
  /**
   * `/agents/:agent`: one agent, with its name once, its description, what it is made of (its model
   * when the Bureau can tell, its tools and skills), a Memory action that carries how many memories it has, a New
   * chat action, and four tabs: Chats (the chats had with it, filtered), Instructions (the body of
   * its file and the reference documents it reads), Access (its tools and when each asks first, its
   * skills, guardrails and budgets) and Settings (its model and step limit, Delete, and its saved
   * versions with Restore). The tab is in the address (`?tab=`), and Chats is
   * the address with none.
   *
   * An agent file shows the version of the file it runs, with a link to the history that lives in
   * the Settings tab. An agent defined in code has no file, so it shows no version and no Edit action.
   * An agent whose listing carries no tools is not claimed to have none: see `agent-facts.svelte`.
   */
  import { untrack } from 'svelte';

  import { Alert, Button, PageHeader, Tabs } from '@lostgradient/cinder';
  import {
    createInfiniteQuery,
    createMutation,
    createQuery,
    useQueryClient,
  } from '@tanstack/svelte-query';

  import { usePageLabel } from '../../app/breadcrumbs.svelte.ts';
  import { AGENT_EDITOR_COPY, AGENT_PAGE_COPY, AGENTS_COPY, CHAT_COPY } from '../../app/copy.ts';
  import {
    agentDuplicatePath,
    agentEditPath,
    agentMemoryPath,
    agentPath,
    pluginOfAgent,
  } from '../../lib/agent-paths.ts';
  import { agentFaultOf, duplicateAgent, getAgentDefinition } from '../../lib/agent-definitions.ts';
  import { listAgents } from '../../lib/bureau-client.ts';
  import { combinePages } from '../../lib/combine-pages.ts';
  import { listMemories, MEMORY_PAGE_SIZE } from '../../lib/memory-client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import AgentAccess from './agent-access.svelte';
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

  const plugin = pluginOfAgent(id);
  const queryClient = useQueryClient();
  let duplicateProblem = $state<string | null>(null);

  // A plugin's agent is read-only; Duplicate writes a copy into the owner's agents and opens it.
  const duplicate = createMutation(() => ({
    mutationFn: () => duplicateAgent(id),
    onMutate: () => {
      duplicateProblem = null;
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.definitions() });
      router.navigate(agentPath(result.id));
    },
    onError: (error) => {
      const fault = agentFaultOf(error);
      const words = AGENT_PAGE_COPY.plugin;
      if (fault.kind === 'identifier-taken')
        duplicateProblem = words.exists(id.slice(id.indexOf(':') + 1));
      else if (fault.kind === 'not-found') duplicateProblem = words.notLoaded;
      else if (fault.kind === 'forbidden') duplicateProblem = words.forbidden;
      else duplicateProblem = words.failed;
    },
  }));

  const editPath = agentEditPath(id);
  // Duplicate on an agent that is not a plugin's opens the form for a new agent filled from it.
  const duplicatePath = agentDuplicatePath(id);
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

  type TabValue = 'chats' | 'instructions' | 'access' | 'settings';
  const TABS: readonly TabValue[] = ['chats', 'instructions', 'access', 'settings'];

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
  <!-- An agent defined in code has no file, so there is nothing to edit; it can still be duplicated. -->
  {#if plugin !== null}
    <Button
      data-changes
      variant="secondary"
      size="sm"
      loading={duplicate.isPending}
      onclick={() => duplicate.mutate()}>{AGENT_PAGE_COPY.plugin.duplicate}</Button
    >
  {:else}
    {#if agent?.kind === 'file'}
      <Button
        href={router.href(editPath)}
        variant="secondary"
        size="sm"
        onclick={(event) => goTo(event, editPath)}>{AGENT_EDITOR_COPY.editAction}</Button
      >
    {/if}
    <!-- Nothing is written here: the copy is named and created in the form. -->
    <Button
      href={router.href(duplicatePath)}
      variant="secondary"
      size="sm"
      onclick={(event) => goTo(event, duplicatePath)}>{AGENT_PAGE_COPY.duplicate}</Button
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

    {#if duplicateProblem !== null}
      <Alert variant="danger" dismissible onDismiss={() => (duplicateProblem = null)}>
        <p>{duplicateProblem}</p>
      </Alert>
    {/if}

    {#if agent.description}
      <p class="ib-agent__description">{agent.description}</p>
    {/if}

    <AgentFacts {agent} detailed />

    {#if agent.kind === 'file' && plugin === null && fileVersion !== undefined}
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
        <Tabs.Trigger value="access">{AGENT_PAGE_COPY.tabs.access}</Tabs.Trigger>
        <Tabs.Trigger value="settings">{AGENT_PAGE_COPY.tabs.settings}</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Panel value="chats">
        <AgentChats {id} />
      </Tabs.Panel>
      <Tabs.Panel value="instructions">
        <AgentInstructions
          {editPath}
          {plugin}
          detail={definition.data}
          failed={definition.isError}
          onRetry={() => void definition.refetch()}
        />
      </Tabs.Panel>
      <Tabs.Panel value="access">
        <AgentAccess
          {id}
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
