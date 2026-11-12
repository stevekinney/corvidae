<script lang="ts">
  /**
   * `/agents`: every agent the Bureau tells the caller of (board PageAgents, "Agents, /agents"),
   * in two bordered cards. "Available" holds the agents that can run, most recently used first,
   * each a status-first two-line row (`agent-list-row.svelte`). "Unavailable" holds the agents a
   * disabled plugin holds back, read from `bureau.agents.definitions.list`, with one "Enable and
   * restart" in the card's header that opens the question Settings › Plugins asks
   * (`agent-list-enable.svelte`). The segments (All, Available) and a search narrow both cards.
   *
   * An agent file the Bureau cannot use is not an agent that can run, so `bureau.agents.list`
   * leaves it out. The definitions list also shows each invalid file with its error and its path,
   * and a link to its editor, so a broken file is never silently missing.
   *
   * The page keeps its header in every state, so it draws its own (`ownsStatesOnPatterns` in
   * `app/views.ts`): a read in progress shows placeholders after 300 ms and, once it is slow, a
   * Cancel that stops it and shows the failed state; nothing at all is the first-use state; only
   * held-back agents is a state whose first action is Enable and restart; a search or segment that
   * matches nothing is a Clear filters state. A server that does not answer is the shell's banner,
   * with the list still on screen.
   *
   * The chat count and last-chat time are the Bureau's own sessions grouped by agent
   * (`bureau.contexts.list`, every page of it). They are read again each time the page opens, so a
   * chat had since shows.
   */
  import {
    Badge,
    Button,
    Card,
    CodeLocation,
    DataList,
    EmptyState,
    ErrorState,
    FilterBar,
    PageHeader,
    RelativeTime,
    Skeleton,
    StackedListItem,
    type FilterSegment,
  } from '@lostgradient/cinder';
  import { Plug, Plus } from '@lucide/svelte';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { getConnection } from '../../app/connection.svelte.ts';
  import { AGENT_EDITOR_COPY, AGENTS_COPY } from '../../app/copy/agents.ts';
  import { CHAT_COPY } from '../../app/copy/chat.ts';
  import { RETRY_LABEL, STALE_DATA_LABEL } from '../../app/copy/views.ts';
  import { VIEW_COPY } from '../../app/copy/view-pages.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { listAgentDefinitions } from '../../lib/agent-definitions.ts';
  import { agentEditPath } from '../../lib/agent-paths.ts';
  import { agentsListQuery } from '../../lib/agent-queries.ts';
  import { listAllContexts } from '../../lib/bureau-client.ts';
  import { followLinks } from '../../lib/follow-links.ts';
  import { agentFilePath, getHostPaths } from '../../lib/host-paths.ts';
  import { getPlugins } from '../../lib/host-plugins.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { phoneViewport } from '../../lib/phone-viewport.svelte.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { useHostProviders } from '../home/home-queries.svelte.ts';
  import AgentListEnable from './agent-list-enable.svelte';
  import {
    activityText,
    availableRow,
    holdingPlugins,
    rowMatches,
    sortByActivity,
    unavailableRow,
    type AgentRow,
  } from './agent-list-model.ts';
  import AgentListRow from './agent-list-row.svelte';
  import { chatUsageByAgent } from './agent-presentation.ts';

  const PLUGINS_PATH = '/settings/plugins';
  const queryClient = useQueryClient();
  const phone = $derived(phoneViewport.current);

  const agents = createQuery(agentsListQuery);

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

  // A model agent cannot answer while no provider holds a key, so its New chat says so.
  const providers = useHostProviders();
  const noProvider = $derived(
    providers.data !== undefined && !providers.data.providers.some((provider) => provider.hasKey),
  );

  // The clock the times are counted from, read again whenever the lists are.
  const now = $derived.by(() => {
    void agents.dataUpdatedAt;
    void chats.dataUpdatedAt;
    return Date.now();
  });

  // The agents that can run, most recently used first; an unavailable agent is one the Bureau does
  // not list as able to run, so an agent in both lists is available.
  const availableRows = $derived(
    sortByActivity((agents.data ?? []).map((agent) => availableRow(agent, usage.get(agent.name)))),
  );
  const heldRows = $derived.by(() => {
    const running = new Set(availableRows.map((row) => row.id));
    return (definitions.data ?? [])
      .filter((entry) => entry.state === 'unavailable' && !running.has(entry.id))
      .map((entry) => unavailableRow(entry, usage.get(entry.id)));
  });

  // The plugins that hold agents back, as a person reads them: the host's title for each, or its
  // name in words while the plugins are not read.
  const plugins = createQuery(
    () => ({
      queryKey: queryKeys.hostPlugins(),
      queryFn: ({ signal }) => getPlugins({ signal }),
      enabled: heldRows.length > 0,
      retry: false,
    }),
    undefined,
  );
  const heldPlugins = $derived(
    holdingPlugins(heldRows).map((name) => ({
      name,
      title:
        plugins.data?.plugins.find((plugin) => plugin.descriptor.name === name)?.descriptor.title ??
        agentLabel(name, undefined),
    })),
  );
  const titleOfPlugin = (name: string | null): string =>
    heldPlugins.find((plugin) => plugin.name === name)?.title ?? agentLabel(name ?? '', undefined);

  type Segment = 'all' | 'available';
  let segment = $state<Segment>('all');
  let search = $state('');
  const needle = $derived(search.trim().toLowerCase());
  const filtered = $derived(segment !== 'all' || needle !== '');

  const matchedAvailable = $derived(availableRows.filter((row) => rowMatches(row, needle)));
  const matchedHeld = $derived(heldRows.filter((row) => rowMatches(row, needle)));
  const matchedInvalid = $derived(
    needle === '' ? invalid : invalid.filter((entry) => entry.id.toLowerCase().includes(needle)),
  );
  const shownHeld = $derived(segment === 'all' ? matchedHeld : []);
  const shownInvalid = $derived(segment === 'all' ? matchedInvalid : []);
  const segments = $derived<FilterSegment[]>([
    {
      value: 'all',
      label: AGENTS_COPY.segments.all,
      count: matchedAvailable.length + matchedHeld.length + matchedInvalid.length,
    },
    {
      value: 'available',
      label: AGENTS_COPY.segments.available,
      count: matchedAvailable.length,
    },
  ]);

  // What the page is: placeholders, the failed state (also after Cancel), the first-use state, the
  // state where only held-back agents exist, or the cards under the segments.
  let canceled = $state(false);
  const connection = getConnection();
  const failed = $derived((agents.isError && agents.data === undefined) || canceled);
  // A refresh that failed over a list already read leaves the list in place under the failure and
  // the age of what is shown. A server that does not answer is the shell's banner instead.
  const refreshFailed = $derived(
    agents.isRefetchError && agents.data !== undefined && !connection.unreachable,
  );
  const loading = $derived(!failed && agents.data === undefined);
  const nothing = $derived(
    agents.isSuccess && availableRows.length === 0 && heldRows.length === 0 && invalid.length === 0,
  );
  const onlyHeld = $derived(agents.isSuccess && availableRows.length === 0 && heldRows.length > 0);
  const nothingShown = $derived(
    matchedAvailable.length === 0 && shownHeld.length === 0 && shownInvalid.length === 0,
  );
  // Only the host's own agents exist, so a compact line offers to make the first of the owner's.
  const noneOfYours = $derived(
    !filtered &&
      availableRows.length > 0 &&
      availableRows.every((row) => row.builtIn) &&
      heldRows.length === 0 &&
      invalid.length === 0,
  );

  const enableLabel = AGENTS_COPY.enable.action;
  let enabling = $state(false);

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }

  function clearFilters(): void {
    search = '';
    segment = 'all';
  }

  function cancelLoading(): void {
    canceled = true;
    void queryClient.cancelQueries({ queryKey: queryKeys.agents.list() });
  }

  function tryAgain(): void {
    canceled = false;
    void agents.refetch();
    void queryClient.refetchQueries({ queryKey: queryKeys.view('agents', null) });
  }

  const activityOf = (row: AgentRow): string | undefined =>
    !chats.isSuccess || (row.state === 'unavailable' && row.usage === undefined)
      ? undefined
      : activityText(row.usage?.lastChatAt ?? null, now);
</script>

{#snippet agentRow(row: AgentRow)}
  <AgentListRow
    {row}
    {phone}
    activity={activityOf(row)}
    countsKnown={chats.isSuccess}
    chatBlocked={noProvider && row.usesModel}
    pluginTitle={titleOfPlugin(row.plugin)}
    onEnable={() => (enabling = true)}
  />
{/snippet}

{#snippet newAgentAction(variant: 'primary' | 'secondary')}
  <Button href={router.href('/agents/new')} {variant} onclick={(event) => go(event, '/agents/new')}>
    {#snippet leadingIcon()}<Plus size={14} aria-hidden="true" />{/snippet}
    {AGENT_EDITOR_COPY.newAction}
  </Button>
{/snippet}

{#snippet enableAction(variant: 'primary' | 'secondary')}
  <Button {variant} onclick={() => (enabling = true)} data-changes data-testid="agents-enable">
    {#snippet leadingIcon()}<Plug size={14} aria-hidden="true" />{/snippet}
    {enableLabel}
  </Button>
{/snippet}

<section class="ib-agents ib-records" aria-label={CHAT_COPY.agentsTitle} data-page="agents">
  <PageHeader
    title={CHAT_COPY.agentsTitle}
    description={AGENTS_COPY.subtitle}
    headingLevel={1}
    createAction={{
      label: AGENT_EDITOR_COPY.newAction,
      href: router.href('/agents/new'),
      onclick: (event) => go(event, '/agents/new'),
    }}
  />

  <div class="ib-agents__body" {@attach followLinks}>
    <!-- Always mounted: the banners that follow a restart outlive the held-back agents they were for. -->
    <AgentListEnable
      bind:open={enabling}
      plugins={heldPlugins}
      agents={heldRows.map((row) => row.title)}
    />

    {#if refreshFailed}
      <div data-testid="agents-refresh-failed">
        <ErrorState
          variant="flat"
          title={VIEW_COPY.agents.error.title}
          description={VIEW_COPY.agents.error.description}
          headingLevel={2}
          retryLabel={RETRY_LABEL}
          onRetry={tryAgain}
        />
        <p>{STALE_DATA_LABEL} <RelativeTime date={agents.dataUpdatedAt} /></p>
      </div>
    {/if}

    {#if failed}
      <ErrorState
        bordered
        title={VIEW_COPY.agents.error.title}
        description={VIEW_COPY.agents.error.description}
        headingLevel={2}
        retryLabel={RETRY_LABEL}
        onRetry={tryAgain}
      />
    {:else if loading}
      <Skeleton
        variant="list"
        rows={4}
        statusMarker="dot"
        delay={300}
        stillLoadingAfter={10_000}
        stillLoadingLabel={AGENTS_COPY.stillLoading}
        label={AGENTS_COPY.loading}
        onCancel={cancelLoading}
      />
    {:else if nothing}
      <EmptyState
        bordered
        kind="first-use"
        title={AGENTS_COPY.empty.title}
        description={AGENTS_COPY.empty.description}
        headingLevel={2}
      >
        {#snippet action()}
          {@render newAgentAction('primary')}
          <Button variant="secondary" href={router.href(PLUGINS_PATH)}>
            {AGENTS_COPY.empty.addPlugin}
          </Button>
        {/snippet}
      </EmptyState>
    {:else if onlyHeld}
      <EmptyState
        bordered
        kind="disabled"
        title={AGENTS_COPY.onlyUnavailable.title}
        description={AGENTS_COPY.onlyUnavailable.description(
          heldRows.map((row) => row.title),
          heldPlugins.map((plugin) => plugin.title),
        )}
        headingLevel={2}
      >
        {#snippet action()}
          {@render enableAction('primary')}
          {@render newAgentAction('secondary')}
        {/snippet}
      </EmptyState>
    {:else}
      <FilterBar
        aria-label={AGENTS_COPY.filtersLabel}
        {segments}
        segmentValue={segment}
        onSegmentChange={(value) => (segment = value === 'available' ? 'available' : 'all')}
        searchQuery={search}
        searchPlaceholder={AGENTS_COPY.searchPlaceholder}
        searchAriaLabel={AGENTS_COPY.searchLabel}
        onSearchChange={(query) => (search = query)}
      />

      {#if nothingShown}
        <EmptyState
          bordered
          kind="filtered"
          title={AGENTS_COPY.noMatch.title}
          description={AGENTS_COPY.noMatch.description}
          headingLevel={2}
          clearFiltersLabel={AGENTS_COPY.clearAction}
          onClearFilters={clearFilters}
        />
      {/if}

      {#if matchedAvailable.length > 0}
        <Card
          title={AGENTS_COPY.groups.availableCount(matchedAvailable.length)}
          headingLevel={2}
          variant="card"
          edge="border"
          padding="none"
          data-testid="agents-available"
        >
          {#snippet actions()}
            <span class="ib-agents__sorted">{AGENTS_COPY.groups.sortedBy}</span>
          {/snippet}
          <DataList
            items={matchedAvailable}
            key={(row) => row.id}
            statusColumn
            aria-label={AGENTS_COPY.groups.availableLabel}
          >
            {#snippet children(row)}
              {@render agentRow(row)}
            {/snippet}
          </DataList>
        </Card>
      {/if}

      {#if noneOfYours}
        <EmptyState
          bordered
          layout="row"
          size="compact"
          kind="first-use"
          title={AGENTS_COPY.noneOfYours.title}
          description={AGENTS_COPY.noneOfYours.description}
          headingLevel={2}
          data-testid="agents-none-of-yours"
        >
          {#snippet action()}
            {@render newAgentAction('primary')}
          {/snippet}
        </EmptyState>
      {/if}

      {#if shownHeld.length > 0}
        <!-- A phone has no group header: each held-back row says why and carries its own Enable and restart. -->
        {#if phone}
          <div class="ib-agents__plain" data-testid="agents-unavailable">
            <DataList
              items={shownHeld}
              key={(row) => row.id}
              statusColumn
              aria-label={AGENTS_COPY.groups.unavailableLabel}
            >
              {#snippet children(row)}
                {@render agentRow(row)}
              {/snippet}
            </DataList>
          </div>
        {:else}
          <Card
            title={AGENTS_COPY.groups.unavailableCount(shownHeld.length)}
            headingLevel={2}
            description={AGENTS_COPY.groups.held(
              heldPlugins.map((plugin) => plugin.title),
              heldRows.length,
            )}
            variant="card"
            edge="border"
            padding="none"
            data-testid="agents-unavailable"
          >
            {#snippet actions()}
              <Button
                variant="secondary"
                size="sm"
                onclick={() => (enabling = true)}
                data-changes
                data-testid="agents-enable"
              >
                {enableLabel}
              </Button>
            {/snippet}
            <DataList
              items={shownHeld}
              key={(row) => row.id}
              statusColumn
              aria-label={AGENTS_COPY.groups.unavailableLabel}
            >
              {#snippet children(row)}
                {@render agentRow(row)}
              {/snippet}
            </DataList>
          </Card>
        {/if}
      {/if}

      {#if shownInvalid.length > 0}
        <Card
          title={AGENTS_COPY.invalidListLabel}
          headingLevel={2}
          variant="card"
          edge="border"
          padding="none"
        >
          <DataList
            items={[...keyedByOccurrence(shownInvalid, (entry) => entry.id)]}
            key={(entry) => entry.key}
            aria-label={AGENTS_COPY.invalidListLabel}
          >
            {#snippet children({ item: entry })}
              <StackedListItem data-agent={entry.id} data-state="invalid">
                {#snippet title()}
                  <span class="ib-agent-row__title">
                    <a
                      class="ib-agent-name"
                      data-identifier
                      href={router.href(agentEditPath(entry.id))}>{entry.id}</a
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
        </Card>
      {/if}
    {/if}
  </div>
</section>
