<script lang="ts">
  /**
   * Left sidebar (design rows 01a to 01d, 24a): one ordered list of destinations
   * (`./destinations.ts`) on one left edge, with Settings pinned to the bottom. Health is the
   * engine's overview, and its dot is the engine's status, with the words in its label. Each
   * item's title names its keyboard shortcut. On a desktop viewport the header button folds the
   * sidebar to its icon rail, and the shell remembers it (`../layout-preferences.svelte.ts`).
   * Badge counts (reviews pending, workers unhealthy) are TanStack queries — a fetch failure (e.g.
   * a 403 from a scope this principal lacks) just hides the count rather than showing a
   * stale/wrong number or breaking the nav.
   *
   * "Unhealthy" for the workers badge has no dedicated wire field —
   * `WorkerSummary.health` is `'active' | 'draining' | 'drained'` (an
   * operator-intent state, not a liveness one). This counts `'drained'`
   * (fully disconnected) plus workers whose heartbeat is stale beyond
   * `STALE_HEARTBEAT_MS`, a documented v1 heuristic, and shows it on Health, the way in to the
   * workers page; the Workers page owns the authoritative staleness presentation.
   */
  import {
    Badge,
    Button,
    Sidebar,
    SIDEBAR_MOBILE_MEDIA_QUERY,
    SideNavigation,
    SideNavigationItem,
    StatusDot,
    type StatusDotStatus,
  } from '@lostgradient/cinder';
  import type { HttpClient } from '@lostgradient/weft';
  import { PanelLeftClose, PanelLeftOpen } from '@lucide/svelte';
  import { MediaQuery } from 'svelte/reactivity';

  import { createQuery } from '@tanstack/svelte-query';

  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { getPrincipalStore } from '../../lib/scopes.svelte.ts';
  import {
    partitionPendingReviews,
    pendingEntriesOnly,
  } from '../../routes/reviews/review-domain.ts';
  import {
    REVIEW_POLL_MILLISECONDS,
    bureauReviewsQuery,
    weftReviewsQueryOptions,
  } from '../../routes/reviews/reviews-data.ts';
  import type { LiveSourceStatus } from '../../lib/live-source/index.ts';
  import { NAVIGATION_COPY, VIEW_COPY } from '../copy.ts';
  import { useFleetEventsLive } from '../live-polling.svelte.ts';
  import { DESTINATIONS, destinationKeys, type Destination } from './destinations.ts';

  interface SidebarNavProps {
    client: HttpClient;
    engineStatus: LiveSourceStatus;
    collapsed?: boolean;
  }

  let { client, engineStatus, collapsed = $bindable(false) }: SidebarNavProps = $props();

  /**
   * On a mobile viewport, `collapsed` doubles as "drawer closed" (Cinder
   * `Sidebar`'s own `open = !collapsed`) — a nav click there should close
   * the drawer after navigating, same as any other mobile drawer nav
   * pattern. On desktop, `collapsed` is the user's icon-rail preference and
   * must NOT be touched by a nav click.
   */
  const isMobileViewport = new MediaQuery(SIDEBAR_MOBILE_MEDIA_QUERY, false);

  /**
   * App-owned collapsed/mobile layout hooks for `foundation.css`'s width
   * rules. Derived from state this component already owns (`collapsed`,
   * bound straight into `Sidebar`, and `isMobileViewport`, computed from the
   * same public `SIDEBAR_MOBILE_MEDIA_QUERY` breakpoint Sidebar itself uses)
   * rather than reading back Cinder's rendered mobile class or
   * collapsed-state attribute on the sidebar root.
   */
  const sidebarStateClass = $derived(
    `weft-shell-sidebar${collapsed ? ' weft-shell-sidebar--collapsed' : ''}${isMobileViewport.current ? ' weft-shell-sidebar--mobile' : ''}`,
  );

  const STALE_HEARTBEAT_MS = 30_000;

  // What is waiting on the caller: the Bureau's reviews, and the engine's when the principal may
  // read them. They are the entries `/reviews` reads, so the count and the list change together.
  const principalStore = getPrincipalStore();
  const bureauReviews = bureauReviewsQuery();
  const fleetLive = useFleetEventsLive();
  const engineReviews = createQuery(
    () =>
      weftReviewsQueryOptions(
        client,
        'pending',
        principalStore.hasScope('reviews:read'),
        fleetLive(),
      ),
    undefined,
  );

  const workersQuery = createQuery(
    () => ({
      queryKey: queryKeys.workers.list(),
      queryFn: () => client.operations['weft.workers.list']({}),
      staleTime: 15_000,
    }),
    undefined,
  );

  // One number from whichever sources answered; none while neither has.
  // The engine's reviews are counted as the page files them: one past its deadline is under Timed
  // out, not pending, so the badge and the page's count agree. The deadline is checked as often as
  // the list is read.
  let reviewsNow = $state(Date.now());
  $effect(() => {
    // poll-reason: clock
    const timer = setInterval(() => {
      reviewsNow = Date.now();
    }, REVIEW_POLL_MILLISECONDS);
    return () => clearInterval(timer);
  });
  const enginePending = $derived(
    partitionPendingReviews(pendingEntriesOnly(engineReviews.data ?? []), reviewsNow).pending
      .length,
  );
  const reviewsPendingCount = $derived(
    bureauReviews.data === undefined && engineReviews.data === undefined
      ? undefined
      : (bureauReviews.data?.length ?? 0) +
          (principalStore.hasScope('reviews:read') ? enginePending : 0),
  );
  const workersUnhealthyCount = $derived(
    workersQuery.data?.items.filter(
      (worker) => worker.health === 'drained' || worker.heartbeatAgeMs > STALE_HEARTBEAT_MS,
    ).length,
  );

  /** The count a destination's item shows, and its tone; none for a destination without one. */
  function badgeOf(
    destination: Destination,
  ): { readonly count: number; readonly variant: 'warning' | 'danger' } | undefined {
    if (destination.view === 'reviews' && reviewsPendingCount !== undefined) {
      return { count: reviewsPendingCount, variant: 'warning' };
    }
    if (destination.view === 'health' && workersUnhealthyCount !== undefined) {
      return { count: workersUnhealthyCount, variant: 'danger' };
    }
    return undefined;
  }

  function isActivePath(path: string): boolean {
    // The home screen is Chat, so Chat is also active at `/`.
    if (path === '/chats' && router.pathname === '/') return true;
    return router.pathname === path || router.pathname.startsWith(`${path}/`);
  }

  function onNavClick(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
    if (isMobileViewport.current) collapsed = true;
  }

  /** The dot's color for each state of the live feed: green while the engine answers, red when it does not. */
  const ENGINE_DOT_STATUS: Readonly<Record<LiveSourceStatus, StatusDotStatus>> = {
    connecting: 'pending',
    live: 'online',
    reconnecting: 'warning',
    polling: 'online',
    stale: 'warning',
    closed: 'danger',
  };

  const engineStatusWords = $derived(NAVIGATION_COPY.engineStatus[engineStatus]);

  /**
   * The words of an item's title, which the browser shows as its tooltip: its name, and the keys
   * that open it. Cinder's `Tooltip` wraps its trigger, which here is the text of a link, so its
   * panel would become part of the link's own text.
   */
  function titleText(destination: Destination): string {
    return `${VIEW_COPY[destination.view].label} (${destinationKeys(destination).join(' ')})`;
  }
</script>

<Sidebar label="Interborough" bind:collapsed class={sidebarStateClass}>
  {#snippet navigation()}
    {#if !isMobileViewport.current}
      <div class="weft-shell-sidebar__brand">
        <Button
          variant="ghost"
          iconOnly
          size="sm"
          aria-label={collapsed ? NAVIGATION_COPY.expandSidebar : NAVIGATION_COPY.collapseSidebar}
          aria-expanded={!collapsed}
          title={collapsed ? NAVIGATION_COPY.expandSidebar : NAVIGATION_COPY.collapseSidebar}
          onclick={() => (collapsed = !collapsed)}
        >
          {#if collapsed}
            <PanelLeftOpen aria-hidden="true" size={16} />
          {:else}
            <PanelLeftClose aria-hidden="true" size={16} />
          {/if}
        </Button>
      </div>
    {/if}
    <SideNavigation ariaLabel={NAVIGATION_COPY.destinations}>
      {#each DESTINATIONS as destination (destination.path)}
        {@const Icon = destination.icon}
        {@const badge = badgeOf(destination)}
        <SideNavigationItem
          href={router.href(destination.path)}
          title={titleText(destination)}
          active={isActivePath(destination.path)}
          class="weft-shell-nav-item"
          listItemClass={destination.pinned ? 'weft-shell-nav-pinned' : ''}
          onclick={(event) => onNavClick(event, destination.path)}
        >
          <!-- The icon is the link's own child: on the icon rail Cinder keeps it and hides the rest,
               whose words stay in the link's accessible name. -->
          <Icon aria-hidden="true" size={16} class="weft-shell-nav-item__icon" />
          <span class="weft-shell-nav-item__label">{VIEW_COPY[destination.view].label}</span>
          {#if destination.view === 'health'}
            <span class="weft-shell-nav-health" data-engine-status={engineStatus}>
              <StatusDot
                status={ENGINE_DOT_STATUS[engineStatus]}
                label={engineStatusWords}
                labelVisible={false}
                live
              />
            </span>
          {/if}
          {#if badge !== undefined && badge.count > 0}
            <Badge variant={badge.variant} size="sm" class="weft-shell-nav-badge"
              >{badge.count}</Badge
            >
          {/if}
        </SideNavigationItem>
      {/each}
    </SideNavigation>
  {/snippet}
</Sidebar>
