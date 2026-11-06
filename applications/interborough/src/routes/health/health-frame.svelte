<script lang="ts">
  /**
   * The frame every Health tab sits in: the heading "Health", the line that names the storage
   * backend, a Live indicator at the right, and the tab bar (Overview, Workers, Storage, Audit
   * log). The heading is the same on every tab; the tab is the breadcrumb's leaf ("Health ›
   * Storage"). Each tab is its own address, so choosing one navigates, and the tab that is open
   * is the page's own, not the address's `?tab=`. Below 640 pixels Cinder's tabs collapse to one
   * select reading "Section: Storage"; a bar that overflows at a tablet width fades at its end.
   *
   * Diagnostics (metrics, alerts and checks) is not a tab. It sits behind the Advanced disclosure
   * at the foot of Overview (`advanced-diagnostics.svelte`).
   */
  import type { Snippet } from 'svelte';

  import { ConnectionIndicator, PageHeader, Tabs } from '@lostgradient/cinder';
  import type { ConnectionIndicatorStatus } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { getConnection } from '../../app/connection.svelte.ts';
  import { getFleetEventSource, hasFleetEventSource } from '../../app/engine-status.svelte.ts';
  import { getHostPaths } from '../../lib/host-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import StorageBackend from '../storage/storage-backend.svelte';
  import {
    HEALTH_FRAME_COPY,
    HEALTH_PAGE_TABS,
    HEALTH_TITLE,
    type HealthTabValue,
  } from './health-copy.ts';

  interface Props {
    /** The tab this page is. */
    active: HealthTabValue;
    /** Nothing to draw: a page that is still loading shows its own skeleton, and the frame stays real text. */
    live?: boolean;
    /** The tab's content. */
    children: Snippet;
  }

  let { active, live = true, children }: Props = $props();

  const pathsQuery = createQuery(
    () => ({
      queryKey: queryKeys.hostPaths(),
      queryFn: ({ signal }) => getHostPaths({ signal }),
      retry: false,
    }),
    undefined,
  );

  // The one indicator: the fleet feed's own state, and a server that does not answer reads as
  // reconnecting, which is all it says (the shell's banner carries the attempt).
  const source = hasFleetEventSource() ? getFleetEventSource() : undefined;
  const connection = getConnection();
  const status = $derived<ConnectionIndicatorStatus>(
    connection.unreachable ? 'reconnecting' : (source?.status ?? 'live'),
  );

  function open(next: string): void {
    const tab = HEALTH_PAGE_TABS.find((candidate) => candidate.value === next);
    if (tab !== undefined && tab.value !== active) router.navigate(tab.path);
  }
</script>

<div class="ib-health-frame" data-page="health" data-tab={active}>
  <PageHeader title={HEALTH_TITLE} headingLevel={1}>
    {#snippet description()}
      <StorageBackend paths={pathsQuery.data} />
    {/snippet}
    {#snippet actions()}
      {#if live}
        <ConnectionIndicator {status} />
      {/if}
    {/snippet}
  </PageHeader>

  <Tabs
    value={active}
    collapseLabel={HEALTH_FRAME_COPY.tabsLabel}
    activateOnFocus={false}
    onValueChange={open}
  >
    <Tabs.List label={HEALTH_FRAME_COPY.tabsLabel}>
      {#each HEALTH_PAGE_TABS as tab (tab.value)}
        <Tabs.Trigger value={tab.value}>{tab.label}</Tabs.Trigger>
      {/each}
    </Tabs.List>
    <Tabs.Panel value={active}>
      {@render children()}
    </Tabs.Panel>
  </Tabs>
</div>

<style>
  .ib-health-frame {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-width: 0;
  }
</style>
