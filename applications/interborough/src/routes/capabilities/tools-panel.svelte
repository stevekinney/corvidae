<script lang="ts">
  /**
   * The Tools tab: every tool in the catalog (`bureau.agents.catalog`) as a list with the open tool
   * beside it. A tool's row reads as its page does: its name for a person, a line about it cut with
   * an ellipsis, then the page's one badge set (what it may do, when it asks, where it comes from)
   * in the page's own words, chips and order, on one baseline (owner report, 2026-11-19). From 40 tools the rows are grouped by
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
    toolGroup,
    toolHeading,
    sourceNamesOf,
    toolSummary,
    type ShownTool,
  } from './capability-presentation.ts';
  import { routerSelectionLocationFor } from '../../lib/router-selection-location.ts';
  import CapabilitiesLoading from './capabilities-loading.svelte';
  import ToolBadge from './tool-badge.svelte';
  import ToolDetail from './tool-detail.svelte';
  import ToolPageState from './tool-page-state.svelte';
  import ListPageEmpty from '../../app/list-page-empty.svelte';

  interface Props {
    /** Opens the Connect tools page, the first-use state's one action. */
    onConnect?: () => void;
    /** The host keeps its configuration in its deployment, so nothing can be connected here. */
    locked?: boolean;
  }

  let { onConnect, locked = false }: Props = $props();

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

  /** The names people call the saved sources: a row says "GitHub", as the chip does, not "Github". */
  const sourceNames = $derived(sourceNamesOf(sources.data?.sources));
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
   * The width at which ListDetail shows one pane at a time, passed to it so the two agree. Where the
   * list is the only pane there is no detail pane to hold the not-found state, so the page draws it
   * in place of the list (COR-2435), with the same way back.
   */
  const PUSH_BELOW = 600;
  let frameWidth = $state(0);
  const singlePane = $derived(frameWidth > 0 && frameWidth < PUSH_BELOW);

  function trackWidth(node: HTMLElement): () => void {
    const measure = (): void => {
      frameWidth = node.getBoundingClientRect().width;
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }

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
    <ToolPageState kind="failed" error={catalog.error} onRetry={() => void catalog.refetch()} />
  {:else if catalog.isError}
    <Alert variant="danger">
      <p class="ib-capabilities__alert-title">{copy.tool.loadFailed.title}</p>
      <p>{copy.tool.loadFailed.description}</p>
      <Button variant="secondary" size="sm" onclick={() => void catalog.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if tools.length === 0}
    <!-- The one list-page first use (owner report, 2026-11-19), with the header's Connect tools. -->
    <ListPageEmpty
      view="capabilities"
      title={copy.tool.empty.title}
      description={copy.tool.empty.description}
      create={onConnect === undefined
        ? undefined
        : {
            label: copy.source.connect.action,
            onclick: onConnect,
            ...(locked ? { inertReason: copy.source.refusal.locked } : {}),
          }}
    />
  {:else}
    <div class="ib-capabilities__frame" data-shortcut-region="list-detail" {@attach trackWidth}>
      {#if missing && singlePane}
        <ToolPageState kind="not-found" />
      {:else}
        <ListDetail
          pushBelow={PUSH_BELOW}
          items={shown}
          key={(tool) => tool.name}
          label={copy.listLabel.tools}
          detailLabel={copy.detailLabel.tools}
          openFirst
          selectionParameter="tool"
          {selectionLocation}
          storageKey="interborough-capabilities-tools"
          {...grouped ? { groupBy: (tool: ShownTool) => toolGroup(tool, sourceNames) } : {}}
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
            <SelectableRow
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
                  <!-- A tool that cannot run now says so on the first line, in a muted word. -->
                  {#if tool.lost !== undefined}
                    <span class="ib-capabilities__row-risk" data-testid="tool-row-paused"
                      >{copy.tool.lost.paused}</span
                    >
                  {/if}
                </span>
              {/snippet}
              {#snippet description()}
                <span class="ib-capabilities__row-line">
                  <span class="ib-capabilities__row-summary" data-testid="tool-row-summary"
                    >{toolSummary(tool)}</span
                  >
                  <!-- The page's own set, in its order, on one line that wraps on a narrow pane. The
                       chips are neutral, so Dangerous is not red (row 31g). -->
                  <span class="ib-capabilities__row-badges" data-testid="tool-row-badges">
                    <ToolBadge kind="risk" {tool} testId="tool-row-risk" />
                    <ToolBadge kind="asks" {tool} testId="tool-row-asks" />
                    <ToolBadge kind="source" {tool} {sourceNames} testId="tool-row-source" />
                  </span>
                </span>
              {/snippet}
            </SelectableRow>
          {/snippet}
          {#snippet listEmpty()}
            <EmptyState
              kind="filtered"
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
          <!-- A tool the address names that the catalog does not hold: the tool's own not-found page. -->
          {#snippet notFound()}
            <ToolPageState kind="not-found" />
          {/snippet}
          {#snippet empty()}
            <EmptyState
              kind="first-use"
              title={copy.emptyDetailTitle}
              description={copy.emptyDetailDescription}
            />
          {/snippet}
        </ListDetail>
      {/if}
    </div>
  {/if}
</div>
