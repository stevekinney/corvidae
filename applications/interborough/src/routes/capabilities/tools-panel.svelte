<script lang="ts">
  /**
   * The Tools tab: every tool in the catalog (`bureau.agents.catalog`) as a list with the open tool
   * beside it. A tool's row is two lines (board PageCapabilities, "Capabilities, Tools tab"): its
   * name for a person at the left with the muted word for what it may do at the right, then where
   * it comes from and a line about it, cut with an ellipsis. From 40 tools the rows are grouped by
   * source. Its details show what it may do, how it is approved by default, where it comes from,
   * its inputs and its users.
   */
  import {
    Alert,
    Button,
    EmptyState,
    ListDetail,
    SearchField,
    SelectableRow,
  } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { CAPABILITIES_COPY } from '../../app/copy/capabilities.ts';
  import { RETRY_LABEL } from '../../app/copy/views.ts';
  import { getAgentCatalog } from '../../lib/agent-definitions.ts';
  import { getPlugins } from '../../lib/host-plugins.ts';
  import { getToolSources } from '../../lib/host-tool-sources.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import {
    GROUP_TOOLS_FROM,
    groupToolsBySource,
    lostTools,
    matchesToolFilter,
    riskLabel,
    tierOf,
    toolGroup,
    toolHeading,
    toolRowSource,
    toolSummary,
    type ShownTool,
  } from './capability-presentation.ts';
  import { routerSelectionLocationFor } from '../../lib/router-selection-location.ts';
  import CapabilitiesLoading from './capabilities-loading.svelte';
  import ToolDetail from './tool-detail.svelte';
  import ToolPageState from './tool-page-state.svelte';

  const copy = CAPABILITIES_COPY;
  const selectionLocation = routerSelectionLocationFor('/capabilities');

  const catalog = createQuery(
    () => ({
      queryKey: queryKeys.agents.catalog(),
      queryFn: ({ signal }) => getAgentCatalog({ signal }),
      // A failure is shown with Try again, not retried behind the person's back.
      retry: false,
    }),
    undefined,
  );

  // The tools that cannot run now (COR-2435): the last listings of the sources that are not
  // connected and the plugins that are off. Neither read is required: one that fails lists none.
  const sources = createQuery(
    () => ({
      queryKey: queryKeys.toolSources.list(),
      queryFn: ({ signal }) => getToolSources({ signal }),
      retry: false,
    }),
    undefined,
  );
  const plugins = createQuery(
    () => ({
      queryKey: queryKeys.hostPlugins(),
      queryFn: ({ signal }) => getPlugins({ signal }),
      retry: false,
    }),
    undefined,
  );

  let filter = $state('');
  const tools = $derived<readonly ShownTool[]>([
    ...(catalog.data?.tools ?? []),
    ...lostTools(catalog.data?.tools ?? [], sources.data?.sources, plugins.data?.plugins),
  ]);
  /** From 40 tools the rows are grouped by the source that brings them, so the list stays easy to scan. */
  const grouped = $derived(tools.length >= GROUP_TOOLS_FROM);
  const shown = $derived.by(() => {
    const matching = tools.filter((tool) => matchesToolFilter(tool, filter));
    return grouped ? groupToolsBySource(matching) : matching;
  });

  // A lost tool sits after every tool the catalog holds, often below the fold: the one the address
  // names is brought into view in the list.
  $effect(() => {
    const name = router.search.get('tool');
    if (name === null || !tools.some((tool) => tool.name === name && tool.lost !== undefined)) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      for (const row of document.querySelectorAll<HTMLElement>('[data-tool-row]')) {
        if (row.dataset['toolRow'] === name) row.scrollIntoView({ block: 'nearest' });
      }
    });
    return () => cancelAnimationFrame(frame);
  });

  /** The tool the address names (`?tool=`), which is a tool's own page while it loads, fails or is missing. */
  const requested = $derived(router.search.get('tool'));
  const asked = $derived(requested !== null && requested !== '');
  /** The address names a tool the catalog does not hold. A tool the filter only hides is held. */
  const missing = $derived(asked && !tools.some((tool) => tool.name === requested));

  /**
   * Stops waiting for the tool: the address no longer names it, so the list takes the page's place
   * while the catalog keeps loading. The request is not cancelled, because cancelling a query that
   * has never had an answer reverts it to a pending query with nothing in flight, which no load
   * state can leave.
   */
  function stopWaiting(): void {
    router.navigate('/capabilities', { replace: true });
  }
</script>

<div class="ib-capabilities__panel" data-testid="tools-panel">
  {#if catalog.isPending && asked}
    <ToolPageState kind="loading" onCancel={stopWaiting} />
  {:else if catalog.isPending}
    <CapabilitiesLoading label={copy.tool.loading} />
  {:else if catalog.isError && asked}
    <ToolPageState kind="failed" onRetry={() => void catalog.refetch()} />
  {:else if catalog.isError}
    <Alert variant="danger">
      <p class="ib-capabilities__alert-title">{copy.tool.loadFailed.title}</p>
      <p>{copy.tool.loadFailed.description}</p>
      <Button variant="secondary" size="sm" onclick={() => void catalog.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if tools.length === 0}
    <EmptyState
      kind="first-use"
      headingLevel={2}
      title={copy.tool.empty.title}
      description={copy.tool.empty.description}
    />
  {:else}
    <div class="ib-capabilities__frame" data-shortcut-region="list-detail">
      <ListDetail
        items={shown}
        key={(tool) => tool.name}
        label={copy.listLabel.tools}
        detailLabel={copy.detailLabel.tools}
        selectionParameter="tool"
        {selectionLocation}
        storageKey="interborough-capabilities-tools"
        {...grouped ? { groupBy: toolGroup } : {}}
      >
        {#snippet header()}
          <!-- The list itself shows no count; one reads at the right of the field once something is typed (row 32b). -->
          <div class="ib-capabilities__filter">
            <div class="ib-capabilities__filter-field">
              <SearchField
                aria-label={copy.filterLabel.tools}
                placeholder={copy.filterPlaceholder}
                bind:value={filter}
                onClear={() => (filter = '')}
              />
            </div>
            {#if filter.trim() !== ''}
              <p class="ib-capabilities__count" data-testid="tools-count">
                {copy.filteredCount.tools(shown.length, tools.length)}
              </p>
            {/if}
          </div>
        {/snippet}
        {#snippet list(tool, row)}
          <!-- A tool that cannot run now says so in the row, in the same muted word as its risk. -->
          {#snippet pausedWord()}
            <span class="ib-capabilities__row-risk" data-testid="tool-row-paused"
              >{copy.tool.lost.paused}</span
            >
          {/snippet}
          <SelectableRow
            meta={tool.lost === undefined ? undefined : pausedWord}
            selected={row.selected}
            selectedState="current"
            onclick={row.open}
            data-tool-row={tool.name}
            data-lost={tool.lost === undefined ? undefined : ''}
          >
            {#snippet title()}
              <span class="ib-capabilities__row-title">
                <span class="ib-capabilities__row-name" data-testid="tool-row-name"
                  >{toolHeading(tool)}</span
                >
                <!-- A muted word, never a colour of its own: Dangerous is not red (row 31g). -->
                <span class="ib-capabilities__row-risk" data-testid="tool-row-risk"
                  >{riskLabel(tierOf(tool))}</span
                >
              </span>
            {/snippet}
            {#snippet description()}
              <span class="ib-capabilities__row-line">
                <span class="ib-capabilities__row-source" data-testid="tool-row-source"
                  >{toolRowSource(tool)}</span
                >
                <span class="ib-capabilities__row-summary" data-testid="tool-row-summary"
                  >{toolSummary(tool)}</span
                >
              </span>
            {/snippet}
          </SelectableRow>
        {/snippet}
        {#snippet listEmpty()}
          <EmptyState
            kind="filtered"
            size="compact"
            headingLevel={3}
            title={copy.tool.filtered.title}
            description={copy.tool.filtered.description}
            clearFiltersLabel={copy.tool.filtered.clear}
            onClearFilters={() => (filter = '')}
          />
        {/snippet}
        {#snippet detail(tool)}
          <ToolDetail {tool} />
        {/snippet}
        {#snippet empty()}
          {#if missing}
            <ToolPageState kind="not-found" />
          {:else}
            <EmptyState
              kind="first-use"
              title={copy.emptyDetailTitle}
              description={copy.emptyDetailDescription}
            />
          {/if}
        {/snippet}
      </ListDetail>
    </div>
  {/if}
</div>
