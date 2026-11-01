<script lang="ts">
  /**
   * The Sources tab: every tool source the host saved (`GET /host/tool-sources`), an MCP server or
   * an OpenAPI service, as a list with the open source beside it. A row says where the source
   * stands; its details list the tools it offers and let the owner set which of them accept
   * secrets. A source's tools join the Tools tab once the host has loaded them, which it does when
   * it starts.
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
  import { getToolSources } from '../../lib/host-tool-sources.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { routerSelectionLocationFor } from '../../lib/router-selection-location.ts';
  import {
    matchesFilter,
    sourceKindLabel,
    sourceStateLabel,
    sourceStateVariant,
  } from './capability-presentation.ts';
  import SourceDetail from './source-detail.svelte';

  const copy = CAPABILITIES_COPY;
  const selectionLocation = routerSelectionLocationFor('/capabilities');

  const sources = createQuery(
    () => ({
      queryKey: queryKeys.toolSources.list(),
      queryFn: ({ signal }) => getToolSources({ signal }),
      // A failure is shown with Try again, not retried behind the person's back.
      retry: false,
    }),
    undefined,
  );

  let filter = $state('');
  const all = $derived(sources.data?.sources ?? []);
  const shown = $derived(all.filter((source) => matchesFilter(source.id, filter)));
  const locked = $derived(sources.data?.lockReason !== undefined);
</script>

<div class="ib-capabilities__panel" data-testid="sources-panel">
  {#if sources.isPending}
    <div role="status" aria-busy="true" aria-label={copy.source.loading}>
      <Skeleton height="1.5rem" width="40%" />
      <Skeleton height="12rem" />
    </div>
  {:else if sources.isError}
    <Alert variant="danger">
      <p class="ib-capabilities__alert-title">{copy.source.loadFailed.title}</p>
      <p>{copy.source.loadFailed.description}</p>
      <Button variant="secondary" size="sm" onclick={() => void sources.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else if all.length === 0}
    <EmptyState
      kind="first-use"
      headingLevel={2}
      title={copy.source.empty.title}
      description={copy.source.empty.description}
    />
  {:else}
    <div class="ib-capabilities__frame" data-shortcut-region="list-detail">
      <ListDetail
        items={shown}
        key={(source) => source.id}
        label={copy.listLabel.sources}
        detailLabel={copy.detailLabel.sources}
        emptyTitle={copy.emptyDetailTitle}
        emptyDescription={copy.emptyDetailDescription}
        selectionParameter="source"
        {selectionLocation}
        storageKey="interborough-capabilities-sources"
      >
        {#snippet header()}
          <p class="ib-capabilities__count" data-testid="sources-count">
            {copy.count(shown.length, all.length)}
          </p>
          <SearchField
            aria-label={copy.filterLabel.sources}
            placeholder={copy.filterPlaceholder}
            bind:value={filter}
            onClear={() => (filter = '')}
          />
        {/snippet}
        {#snippet list(source, row)}
          <SelectableRow
            selected={row.selected}
            selectedState="current"
            onclick={row.open}
            data-source-row={source.id}
            data-state={source.state}
          >
            {#snippet title()}<span class="ib-capability__identifier">{source.id}</span>{/snippet}
            {#snippet description()}{sourceKindLabel(source)}{/snippet}
            {#snippet meta()}
              <Badge variant={sourceStateVariant(source.state)} size="sm"
                >{sourceStateLabel(source.state)}</Badge
              >
            {/snippet}
          </SelectableRow>
        {/snippet}
        {#snippet listEmpty()}
          <EmptyState
            kind="filtered"
            size="compact"
            headingLevel={3}
            title={copy.source.filtered.title}
            description={copy.source.filtered.description}
            clearFiltersLabel={copy.source.filtered.clear}
            onClearFilters={() => (filter = '')}
          />
        {/snippet}
        {#snippet detail(source)}
          <!-- Keyed, so a sign-in or a write in flight never carries over to the next source opened. -->
          {#key source.id}
            <SourceDetail {source} {locked} />
          {/key}
        {/snippet}
      </ListDetail>
    </div>
  {/if}
</div>
