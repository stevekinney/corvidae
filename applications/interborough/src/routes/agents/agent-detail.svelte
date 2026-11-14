<script lang="ts">
  /**
   * An agent's page: one frame with one header over six tabs, each at its own address
   * (`lib/agent-paths.ts`): Chats (`/agents/:agent`, the chats had with it, filtered), Instructions
   * (`/instructions`, the body of its file and the reference documents it reads), Access
   * (`/access`, its tools and when each asks first, its skills, guardrails and budgets), Hooks
   * (`/hooks`, the hooks limited to it), Memory (`/memory`, what it remembers, with the open memory
   * in `?selected=`) and Settings (`/settings`, its model and step limit, Delete, and its saved
   * versions with Restore). A reload and the breadcrumb keep the tab. An address from before the
   * tabs had paths of their own (`?tab=access`) is replaced with the tab's path, and one that names
   * no tab is Chats.
   *
   * The header is the same on every tab (board PageAgent, rows 38a to 38c): the agent's name with
   * its identifier small and monospaced beside it, its description, a status line (what its chats
   * are doing and how many there are), and, for an agent that needs a model while no provider is
   * connected, the reason it cannot answer with a link to connect one. Its actions are Edit for an
   * agent file the owner keeps, Duplicate for one that cannot be edited here, and New chat, the one
   * primary action, except that it is secondary while the Chats tab shows its own empty state,
   * whose New chat is then the page's only primary (row 39p). The tab bar carries each tab's count
   * once it is known. Choosing a tab writes its address and keeps the page mounted, so the header
   * and the tab bar never reload; a tab only opens on a click or Enter, because each one is a
   * history entry.
   *
   * Each tab's body words its own loading, failure and old data (`agent-tab-state.svelte`), so the
   * header and the tabs stay live while it does. While a tab shows data its last read failed to
   * refresh, Edit is held back (`agent-tab-stale.ts`).
   *
   * An agent a disabled plugin ships is not in the agent list, which lists what can run, so the
   * page reads it from its definition: its status is Unavailable, New chat is held with the reason,
   * Duplicate stays, and a banner over every tab says why, with Enable and restart
   * (`agent-unavailable-banner.svelte`).
   */
  import { untrack } from 'svelte';

  import {
    Alert,
    Button,
    PageHeader,
    StaleRegion,
    StatusDot,
    Tabs,
    Tooltip,
  } from '@lostgradient/cinder';
  import { Pencil, Plus } from '@lucide/svelte';
  import {
    createInfiniteQuery,
    createMutation,
    createQuery,
    useQueryClient,
  } from '@tanstack/svelte-query';

  import { usePageLabel } from '../../app/breadcrumbs.svelte.ts';
  import { AGENT_EDITOR_COPY, AGENT_PAGE_COPY } from '../../app/copy/agents.ts';
  import { CHAT_COPY } from '../../app/copy/chat.ts';
  import {
    agentDuplicatePath,
    agentEditPath,
    agentPath,
    agentTabPath,
    isAgentTab,
    pluginOfAgent,
    type AgentTab,
  } from '../../lib/agent-paths.ts';
  import { agentFaultOf, duplicateAgent, getAgentDefinition } from '../../lib/agent-definitions.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { agentsListQuery } from '../../lib/agent-queries.ts';
  import { listAllContexts } from '../../lib/bureau-client.ts';
  import { listHooks } from '../../lib/bureau-hooks.ts';
  import { combinePages } from '../../lib/combine-pages.ts';
  import { getPlugins } from '../../lib/host-plugins.ts';
  import { getProviders } from '../../lib/host-providers.ts';
  import { listMemories, MEMORY_PAGE_SIZE } from '../../lib/memory-client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import AgentAccess from './agent-access.svelte';
  import type { ChatCounts } from './agent-chat-filters.ts';
  import AgentChats from './agent-chats.svelte';
  import AgentDuplicateDialog from './agent-duplicate-dialog.svelte';
  import AgentFacts from './agent-facts.svelte';
  import AgentHooks from './agent-hooks.svelte';
  import AgentInstructions from './agent-instructions.svelte';
  import AgentMemory from './agent-memory.svelte';
  import AgentSettings from './agent-settings.svelte';
  import AgentTabState from './agent-tab-state.svelte';
  import AgentUnavailableBanner from './agent-unavailable-banner.svelte';
  import {
    agentStatusLine,
    allowedToolCount,
    chatUsageByAgent,
    copiedFromNotice,
    newChatPath,
    tabCountText,
  } from './agent-presentation.ts';
  import { provideAgentTabStale } from './agent-tab-stale.ts';

  const id = untrack(() => router.current.params['agent'] ?? '');
  const plugin = pluginOfAgent(id);
  const copy = AGENT_PAGE_COPY;

  /** The tab the address names: the last segment of its route, and Chats for the agent's own path. */
  function tabOfRoute(): AgentTab {
    const last = router.current.route?.pattern.split('/').at(-1) ?? '';
    return isAgentTab(last) ? last : 'chats';
  }

  let activeTab = $state<string>(untrack(tabOfRoute));

  const agents = createQuery(agentsListQuery);
  const listed = $derived(agents.data?.find((entry) => entry.name === id));

  // The agent's own statement of itself: the tabs other than Chats read it, the header counts an
  // agent file's tools from it, and it is what says that an agent the list leaves out is held back
  // by a disabled plugin. On Chats an agent defined in code needs none of that: its listing names
  // its tools.
  const definition = createQuery(
    () => ({
      queryKey: queryKeys.agents.definition(id),
      queryFn: ({ signal }) => getAgentDefinition(id, { signal }),
      enabled:
        agents.data !== undefined &&
        (listed === undefined || listed.kind === 'file' || activeTab !== 'chats'),
      retry: false,
    }),
    undefined,
  );
  const unavailable = $derived(listed === undefined && definition.data?.state === 'unavailable');
  /** The agent's name as a person reads it, and its description: the listing's, or its definition's. */
  const name = $derived(
    listed?.displayName ??
      (unavailable ? agentLabel(definition.data?.name ?? id, undefined) : undefined),
  );
  const description = $derived(
    listed !== undefined ? listed.description : (definition.data?.description ?? null),
  );
  // A copy whose source has changed since it was made (COR-2234): the Bureau answers the version the
  // source is at now beside the one the copy recorded, and the page compares the two and nothing else.
  const copiedFrom = $derived(copiedFromNotice(definition.data, agents.data, name));
  // The top bar's trail names the agent as a person reads it, once the Bureau has answered.
  usePageLabel(() => ({ path: agentPath(id), label: name }));

  // The chats a person started, as the agent list counts them, so the list and the page agree.
  const chats = createQuery(
    () => ({
      queryKey: queryKeys.contexts.usage(),
      queryFn: ({ signal }) => listAllContexts({ signal, origin: 'chat' }),
      retry: false,
    }),
    undefined,
  );
  const usage = $derived(
    chats.data === undefined ? undefined : chatUsageByAgent(chats.data).get(id),
  );
  const status = $derived(agentStatusLine(usage, { known: chats.data !== undefined, unavailable }));
  /** The counts the Chats tab's segments carry: the same chats the header counts, by state. */
  const chatCounts = $derived<ChatCounts | undefined>(
    chats.data === undefined
      ? undefined
      : {
          all: usage?.count ?? 0,
          'needs-you': usage?.waiting ?? 0,
          running: usage?.running ?? 0,
        },
  );
  /** Whether the Chats tab is its empty state, where its own New chat is the page's one primary (row 39p). */
  let chatsEmpty = $state(false);
  const newChatVariant = $derived(activeTab === 'chats' && chatsEmpty ? 'secondary' : 'primary');

  // Whether any provider holds a key, the rule the first-run checklist states. An agent that runs
  // on a model cannot answer without one; one that names no model, such as a script, can.
  const providers = createQuery(
    () => ({
      queryKey: queryKeys.hostProviders(),
      queryFn: ({ signal }) => getProviders({ signal }),
      retry: false,
    }),
    undefined,
  );
  const needsProvider = $derived(
    !unavailable &&
      listed !== undefined &&
      listed.media !== null &&
      providers.data !== undefined &&
      !providers.data.providers.some((provider) => provider.hasKey),
  );

  // The plugin's title, as Settings › Plugins shows it, for the words about a disabled one.
  const plugins = createQuery(
    () => ({
      queryKey: queryKeys.hostPlugins(),
      queryFn: ({ signal }) => getPlugins({ signal }),
      enabled: unavailable,
      retry: false,
    }),
    undefined,
  );
  const pluginTitle = $derived(
    plugins.data?.plugins.find((entry) => entry.descriptor.name === plugin)?.descriptor.title ??
      /^Plugin (.+) is disabled$/.exec(definition.data?.unavailable?.message ?? '')?.[1] ??
      plugin ??
      '',
  );

  // The memory tab's own query, so the count and the tab warm each other. A failure drops the count
  // and keeps the tab: the tab itself says why it cannot show memories.
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

  // The Hooks tab's own query, for its count.
  const hooks = createQuery(
    () => ({
      queryKey: queryKeys.hooks.ofAgent(id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        listHooks({ scope: { kind: 'agent', id } }, { signal }),
      retry: false,
    }),
    undefined,
  );

  const counts = $derived({
    chats: tabCountText(chats.data === undefined ? undefined : (usage?.count ?? 0)),
    access: tabCountText(
      definition.data === undefined && listed?.tools === undefined
        ? undefined
        : allowedToolCount(definition.data, listed?.tools),
    ),
    hooks: tabCountText(hooks.data?.length),
    memory: tabCountText(memoryCount, memories.hasNextPage),
  });

  // How many tab bodies show data a read failed to refresh: while any does, Edit is held back.
  let staleTabs = $state(0);
  provideAgentTabStale(() => {
    staleTabs += 1;
    return () => {
      staleTabs -= 1;
    };
  });

  const queryClient = useQueryClient();
  let duplicateProblem = $state<string | null>(null);
  /** The confirmation before a copy that leaves something out, and what it lists. */
  let confirmOpen = $state(false);
  let confirmError = $state<string | null>(null);
  let droppedItems = $state<readonly string[]>([]);
  let duplicateButton = $state<HTMLElement | null>(null);

  /** What a failed read or write of a copy says, in the words of the fault. */
  function duplicateFaultWords(error: unknown): string {
    const fault = agentFaultOf(error);
    const words = copy.plugin;
    if (fault.kind === 'identifier-taken') return words.exists(id.slice(id.indexOf(':') + 1));
    if (fault.kind === 'not-found') return words.notLoaded;
    if (fault.kind === 'forbidden') return words.forbidden;
    return words.failed;
  }

  // A plugin's agent cannot be edited here; Duplicate writes a copy into the owner's agents and opens it.
  const duplicate = createMutation(() => ({
    mutationFn: () => duplicateAgent(id),
    onMutate: () => {
      duplicateProblem = null;
      confirmError = null;
    },
    onSuccess: (result) => {
      confirmOpen = false;
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.definitions() });
      router.navigate(agentPath(result.id));
    },
    onError: (error) => {
      // While the question is open the failure shows in it, with Duplicate armed as the retry.
      if (confirmOpen) confirmError = duplicateFaultWords(error);
      else duplicateProblem = duplicateFaultWords(error);
    },
  }));

  // Pressing Duplicate reads the source's definition now, because the Bureau states what a copy
  // would lose there, before any write. A list with something in it asks first; an empty one (a
  // plugin's file agent loses nothing) writes at once; a read that fails writes nothing.
  let reading = $state(false);
  async function startDuplicate(): Promise<void> {
    reading = true;
    duplicateProblem = null;
    try {
      const source = await queryClient.fetchQuery({
        queryKey: queryKeys.agents.definition(id),
        queryFn: ({ signal }) => getAgentDefinition(id, { signal }),
        staleTime: 0,
      });
      if (source.dropped.length === 0) {
        duplicate.mutate();
        return;
      }
      droppedItems = [...source.dropped];
      confirmError = null;
      confirmOpen = true;
    } catch (error) {
      duplicateProblem = duplicateFaultWords(error);
    } finally {
      reading = false;
    }
  }

  const editPath = agentEditPath(id);
  // Duplicate on an agent defined in code opens the form for a new agent filled from it.
  const duplicatePath = agentDuplicatePath(id);
  const connectPath = '/settings/models';

  function goTo(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }

  // The address owns the tab, so a tab can be linked and the back button returns to it:
  // `activeTab` follows the route, and a tab the person picks writes the address before Tabs
  // commits it (`onValueChangeRequest`), so a jump through history to an older tab is only read,
  // never written back over. Choosing a tab keeps the page mounted: the address names the same
  // agent. A tab holding changes that are not saved may refuse the move and ask first (row 39b);
  // the tab the address still names is then the one Tabs keeps, so the asking tab stays mounted.
  function requestTab(next: string): string {
    if (!isAgentTab(next) || tabOfRoute() === next) return next;
    router.navigate(agentTabPath(id, next), { keep: true });
    return tabOfRoute();
  }

  $effect(() => {
    const fromUrl = tabOfRoute();
    if (fromUrl !== activeTab) activeTab = fromUrl;
  });

  // An address from before each tab had a path (`?tab=access`) goes to the tab's path, in place;
  // one that names no tab is Chats. Any other part of the query stays.
  $effect(() => {
    const named = router.search.get('tab');
    if (named === null) return;
    const search = new URLSearchParams(router.search);
    search.delete('tab');
    const query = search.size === 0 ? '' : `?${search.toString()}`;
    const tab: AgentTab = isAgentTab(named) ? named : 'chats';
    untrack(() =>
      router.navigate(`${agentTabPath(id, tab)}${query}`, { replace: true, keep: true }),
    );
  });
</script>

{#snippet identifier()}
  {#if name !== undefined && name !== id}
    <code class="ib-agent-id" data-testid="agent-identifier">{id}</code>
  {/if}
{/snippet}

{#snippet headerActions()}
  {#if plugin !== null}
    <!-- A plugin's agent, running or held back, is changed through a copy the owner keeps. -->
    <Button
      data-changes
      variant="secondary"
      size="sm"
      loading={reading || (duplicate.isPending && !confirmOpen)}
      onclick={(event) => {
        duplicateButton = event.currentTarget;
        void startDuplicate();
      }}>{copy.plugin.duplicate}</Button
    >
  {:else if listed?.kind === 'file'}
    <Button
      href={router.href(editPath)}
      variant="secondary"
      size="sm"
      mutating
      onclick={(event) => goTo(event, editPath)}
    >
      {#snippet leadingIcon()}<Pencil aria-hidden="true" size={14} />{/snippet}
      {AGENT_EDITOR_COPY.editAction}
    </Button>
  {:else}
    <!-- An agent defined in code has no file to edit. Nothing is written here: the copy is named
         and created in the form. -->
    <Button
      href={router.href(duplicatePath)}
      variant="secondary"
      size="sm"
      onclick={(event) => goTo(event, duplicatePath)}>{copy.duplicate}</Button
    >
  {/if}
  {#if unavailable}
    <!-- Held, not removed: it keeps its place and its focus, and says why it is off. -->
    <Tooltip text={copy.unavailable.newChatReason(pluginTitle)}>
      <Button variant={newChatVariant} size="sm" aria-disabled="true">
        {#snippet leadingIcon()}<Plus aria-hidden="true" size={14} />{/snippet}
        {CHAT_COPY.newChat}
      </Button>
    </Tooltip>
  {:else}
    <Button
      href={router.href(newChatPath(id))}
      variant={newChatVariant}
      size="sm"
      onclick={(event) => goTo(event, newChatPath(id))}
    >
      {#snippet leadingIcon()}<Plus aria-hidden="true" size={14} />{/snippet}
      {CHAT_COPY.newChat}
    </Button>
  {/if}
{/snippet}

<!-- The name and a count, as a tab carries them: "Access 3". -->
{#snippet counted(label: string, count: string | undefined)}
  {label}
  {#if count !== undefined}
    <span class="ib-agent-tabs__count">{count}</span>
  {/if}
{/snippet}

{#snippet unavailableBanner()}
  {#if unavailable && plugin !== null}
    <AgentUnavailableBanner {id} name={name ?? id} {plugin} {pluginTitle} />
  {/if}
{/snippet}

{#if name !== undefined}
  <StaleRegion stale={staleTabs > 0} reason={copy.tabState.staleTitle}>
    <article class="ib-agent" data-page="agent-detail">
      <PageHeader
        data-testid="agent-header"
        headingLevel={1}
        title={name}
        status={identifier}
        statusPlacement="inline"
        actions={headerActions}
      />

      {#if duplicateProblem !== null}
        <Alert variant="danger" dismissible onDismiss={() => (duplicateProblem = null)}>
          <p>{duplicateProblem}</p>
        </Alert>
      {/if}

      {#if plugin !== null}
        <AgentDuplicateDialog
          bind:open={confirmOpen}
          {name}
          dropped={droppedItems}
          busy={duplicate.isPending}
          error={confirmError}
          triggerRef={duplicateButton}
          onConfirm={() => duplicate.mutate()}
          onCancel={() => undefined}
        />
      {/if}

      <div class="ib-agent__summary">
        {#if description}
          <p class="ib-agent__description">{description}</p>
        {/if}
        {#if status !== undefined}
          <p class="ib-agent__status" data-testid="agent-status">
            {#if status.tone === null}
              {status.text}
            {:else}
              <StatusDot size="sm" status={status.tone} label={status.text} />
            {/if}
          </p>
        {/if}
        {#if copiedFrom !== undefined}
          <!-- Where a copy came from, once the source has changed: one plain line on every tab,
               not a banner, because it asks for nothing. -->
          <p class="ib-agent__reason" data-testid="agent-copied-from">
            {copy.header.copiedFrom.lead}
            <a
              href={router.href(agentPath(copiedFrom.agent))}
              onclick={(event) => goTo(event, agentPath(copiedFrom.agent))}>{copiedFrom.name}</a
            >{copiedFrom.versions === null
              ? copy.header.copiedFrom.changed
              : copy.header.copiedFrom.changedFrom(
                  copiedFrom.versions.copied,
                  copiedFrom.versions.now,
                )}
          </p>
        {/if}
        {#if needsProvider}
          <p class="ib-agent__reason" data-testid="agent-provider-reason">
            {copy.header.needsProvider}
            <a href={router.href(connectPath)} onclick={(event) => goTo(event, connectPath)}
              >{copy.header.connectProvider}</a
            >
          </p>
        {/if}
      </div>

      {#if listed !== undefined}
        <AgentFacts agent={listed} detailed />
      {/if}

      <Tabs bind:value={activeTab} onValueChangeRequest={requestTab} activateOnFocus={false}>
        <Tabs.List label={copy.tabsLabel}>
          <Tabs.Trigger value="chats" label={copy.tabs.chats}
            >{@render counted(copy.tabs.chats, counts.chats)}</Tabs.Trigger
          >
          <Tabs.Trigger value="instructions" label={copy.tabs.instructions}
            >{copy.tabs.instructions}</Tabs.Trigger
          >
          <Tabs.Trigger value="access" label={copy.tabs.access}
            >{@render counted(copy.tabs.access, counts.access)}</Tabs.Trigger
          >
          <Tabs.Trigger value="hooks" label={copy.tabs.hooks}
            >{@render counted(copy.tabs.hooks, counts.hooks)}</Tabs.Trigger
          >
          <Tabs.Trigger value="memory" label={copy.tabs.memory}
            >{@render counted(copy.tabs.memory, counts.memory)}</Tabs.Trigger
          >
          <Tabs.Trigger value="settings" label={copy.tabs.settings}
            >{copy.tabs.settings}</Tabs.Trigger
          >
        </Tabs.List>
        <Tabs.Panel value="chats">
          {@render unavailableBanner()}
          <AgentChats
            {id}
            name={name ?? id}
            counts={chatCounts}
            bind:empty={chatsEmpty}
            {unavailable}
            {pluginTitle}
          />
        </Tabs.Panel>
        <Tabs.Panel value="instructions">
          {@render unavailableBanner()}
          <AgentTabState
            tab={copy.tabs.instructions}
            shape="form"
            pending={definition.isPending}
            error={definition.error}
            updatedAt={definition.dataUpdatedAt}
            onRetry={() => void definition.refetch()}
          >
            <AgentInstructions {id} {editPath} {plugin} detail={definition.data} />
          </AgentTabState>
        </Tabs.Panel>
        <Tabs.Panel value="access">
          {@render unavailableBanner()}
          <AgentTabState
            tab={copy.tabs.access}
            shape="form"
            pending={definition.isPending}
            error={definition.error}
            updatedAt={definition.dataUpdatedAt}
            onRetry={() => void definition.refetch()}
          >
            <AgentAccess {id} detail={definition.data} />
          </AgentTabState>
        </Tabs.Panel>
        <Tabs.Panel value="hooks">
          {@render unavailableBanner()}
          <AgentHooks {id} name={name ?? id} />
        </Tabs.Panel>
        <Tabs.Panel value="memory">
          {@render unavailableBanner()}
          <AgentMemory />
        </Tabs.Panel>
        <Tabs.Panel value="settings">
          {@render unavailableBanner()}
          <AgentTabState
            tab={copy.tabs.settings}
            shape="form"
            pending={definition.isPending}
            error={definition.error}
            updatedAt={definition.dataUpdatedAt}
            onRetry={() => void definition.refetch()}
          >
            <AgentSettings
              {id}
              detail={definition.data}
              name={name ?? id}
              chats={chats.data === undefined ? undefined : (usage?.count ?? 0)}
            />
          </AgentTabState>
        </Tabs.Panel>
      </Tabs>
    </article>
  </StaleRegion>
{/if}
