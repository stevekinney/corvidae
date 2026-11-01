<script lang="ts">
  /**
   * The Tools tab: every tool in the catalog (`bureau.agents.catalog`) as a list with the open tool
   * beside it. A tool's row shows its name, a line about it and its tier; its details show what it
   * may do, how it is approved by default, where it comes from, its inputs and its users.
   */
  import {
    Alert,
    Badge,
    Button,
    EmptyState,
    ListDetail,
    SearchField,
    SelectableRow,
    Skeleton,
  } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { CAPABILITIES_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import { getAgentCatalog } from '../../lib/agent-definitions.ts';
  import { queryKeys } from '../../lib/query.ts';
  import {
    matchesFilter,
    tierLabel,
    tierOf,
    tierVariant,
    toolSourceLabel,
    toolSummary,
  } from './capability-presentation.ts';
  import { routerSelectionLocationFor } from '../../lib/router-selection-location.ts';
  import ToolDetail from './tool-detail.svelte';

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

  let filter = $state('');
  const tools = $derived(catalog.data?.tools ?? []);
  const shown = $derived(tools.filter((tool) => matchesFilter(tool.name, filter)));
</script>

<div class="ib-capabilities__panel" data-testid="tools-panel">
  {#if catalog.isPending}
    <div role="status" aria-busy="true" aria-label={copy.tool.loading}>
      <Skeleton height="1.5rem" width="40%" />
      <Skeleton height="12rem" />
    </div>
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
        emptyTitle={copy.emptyDetailTitle}
        emptyDescription={copy.emptyDetailDescription}
        selectionParameter="tool"
        {selectionLocation}
        storageKey="interborough-capabilities-tools"
      >
        {#snippet header()}
          <p class="ib-capabilities__count" data-testid="tools-count">
            {copy.count(shown.length, tools.length)}
          </p>
          <SearchField
            aria-label={copy.filterLabel.tools}
            placeholder={copy.filterPlaceholder}
            bind:value={filter}
            onClear={() => (filter = '')}
          />
        {/snippet}
        {#snippet list(tool, row)}
          <SelectableRow
            selected={row.selected}
            selectedState="current"
            onclick={row.open}
            data-tool-row={tool.name}
          >
            {#snippet title()}<span class="ib-capability__identifier">{tool.name}</span>{/snippet}
            {#snippet description()}{toolSummary(tool)}{/snippet}
            {#snippet meta()}
              <Badge variant="neutral" size="sm" data-testid="tool-row-source"
                >{toolSourceLabel(tool)}</Badge
              >
              <Badge variant={tierVariant(tierOf(tool))} size="sm">{tierLabel(tierOf(tool))}</Badge>
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
      </ListDetail>
    </div>
  {/if}
</div>
