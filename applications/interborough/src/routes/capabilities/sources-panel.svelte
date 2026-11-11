<script lang="ts">
  /**
   * The Sources tab: every tool source the host saved (`GET /host/tool-sources`), an MCP server or
   * an OpenAPI service, as a list with the open source beside it. A row says where the source
   * stands; its details list the tools it offers and let the owner set which of them accept
   * secrets. A source's tools join the Tools tab once the host has loaded them, which it does when
   * it starts, so a saved source that is not running yet comes with Restart Interborough
   * (`restart-banner.svelte`).
   *
   * Connecting a source belongs to the page header: its "+" and the empty state's primary
   * "Connect tools" both call `onConnect`, and the page opens the dialog that saves one
   * (`connect-dialog.svelte`). With no source saved, the empty state's button is the only primary
   * on the page (rows 31z, 32a).
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
  import { Plus } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';
  import { onDestroy } from 'svelte';

  import { CAPABILITIES_COPY, RETRY_LABEL } from '../../app/copy.ts';
  import { getToolSources } from '../../lib/host-tool-sources.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { routerSelectionLocationFor } from '../../lib/router-selection-location.ts';
  import {
    matchesSourceFilter,
    sourceHeading,
    sourceKindLabel,
    sourceStateLabel,
    sourceStateVariant,
    sourceWaitsForRestart,
  } from './capability-presentation.ts';
  import RestartBanner from './restart-banner.svelte';
  import { SourcesRestartFlow } from './restart-flow.svelte.ts';
  import SourceDetail from './source-detail.svelte';

  interface Props {
    /** Opens the dialog that connects a source. */
    onConnect: () => void;
    /**
     * Counts up each time the page connects a source: the list reads the open source from the
     * address once, when it is built, so a source just connected is opened by building the list
     * again over the new address.
     */
    listVersion: number;
  }

  let { onConnect, listVersion }: Props = $props();

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
  const shown = $derived(all.filter((source) => matchesSourceFilter(source, filter)));
  const locked = $derived(sources.data?.lockReason !== undefined);
  const waiting = $derived(all.filter(sourceWaitsForRestart).length);

  // The restart outlives the sources that were waiting for it: it says how it ended.
  const restart = new SourcesRestartFlow();
  onDestroy(() => restart.dispose());
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
    <RestartBanner flow={restart} {waiting} {locked} />
    <EmptyState
      kind="first-use"
      headingLevel={2}
      title={copy.source.empty.title}
      description={copy.source.empty.description}
    >
      {#snippet action()}
        <Button data-changes variant="primary" disabled={locked} onclick={onConnect}>
          {#snippet leadingIcon()}<Plus aria-hidden="true" size={16} />{/snippet}
          {copy.source.connect.action}
        </Button>
      {/snippet}
    </EmptyState>
  {:else}
    <RestartBanner flow={restart} {waiting} {locked} />
    {#key listVersion}
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
              {#snippet title()}{sourceHeading(source)}{/snippet}
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
    {/key}
  {/if}
</div>
