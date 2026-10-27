<script lang="ts">
  /**
   * Left sidebar (plan §13 T1.6; design `Weft UI.dc.html` "SIDEBAR"):
   * product mark, the views in two groups (Work, for working with agents, then Engine, for
   * operating it) with Lucide icons + badge counts, active state from the router. Each item's
   * title names its keyboard shortcut (`../../lib/navigation-shortcuts.ts`), and the footer is
   * the engine's status: a dot, with the words in its title. Badge counts (reviews pending, workers
   * unhealthy) are TanStack queries — a fetch failure (e.g. a 403 from a
   * scope this principal lacks) just hides the count rather than showing a
   * stale/wrong number or breaking the nav.
   *
   * "Unhealthy" for the workers badge has no dedicated wire field —
   * `WorkerSummary.health` is `'active' | 'draining' | 'drained'` (an
   * operator-intent state, not a liveness one). This counts `'drained'`
   * (fully disconnected) plus workers whose heartbeat is stale beyond
   * `STALE_HEARTBEAT_MS`, a documented v1 heuristic — the Workers track
   * (§13 track C) owns the authoritative staleness presentation on its own
   * surface; this badge is a coarse smell test only.
   */
  import {
    Badge,
    NavigationItem,
    Sidebar,
    SIDEBAR_MOBILE_MEDIA_QUERY,
    SideNavigation,
    SideNavigationGroup,
    SideNavigationItem,
    StatusDot,
    type StatusDotStatus,
  } from '@lostgradient/cinder';
  import type { HttpClient } from '@lostgradient/weft';
  import {
    Bot,
    CalendarClock,
    Database,
    Gauge,
    Inbox,
    MessageSquare,
    Play,
    ScrollText,
    ServerCog,
    Settings,
    SlidersHorizontal,
    Workflow,
  } from '@lucide/svelte';
  import { MediaQuery } from 'svelte/reactivity';

  import { createQuery } from '@tanstack/svelte-query';

  import { shortcutKeys } from '../../lib/navigation-shortcuts.ts';
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
  import type { ViewName } from '../views.ts';

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
  const engineReviews = createQuery(
    () => weftReviewsQueryOptions(client, 'pending', principalStore.hasScope('reviews:read')),
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

  interface NavEntry {
    readonly view: ViewName;
    /** The words of the entry when they are not the view's own name. */
    readonly label?: string;
    readonly path: string;
    readonly icon: typeof Workflow;
    /** `undefined` for views with no badge count; `badgeVariant` stays a plain required field (never `undefined`) so it never needs a per-entry default under `exactOptionalPropertyTypes`. */
    readonly badge: number | undefined;
    readonly badgeVariant: 'warning' | 'danger';
  }

  interface NavGroup {
    readonly label: string;
    readonly entries: readonly NavEntry[];
  }

  /**
   * The sidebar: the primary views, then the engine console's. Chat is the home screen, so its
   * entry owns `/` as well as `/chat`.
   */
  const navGroups = $derived<readonly NavGroup[]>([
    {
      label: NAVIGATION_COPY.workGroup,
      entries: [
        {
          view: 'chat',
          path: '/chat',
          icon: MessageSquare,
          badge: undefined,
          badgeVariant: 'warning',
        },
        { view: 'agents', path: '/agents', icon: Bot, badge: undefined, badgeVariant: 'warning' },
        {
          view: 'workflows',
          path: '/workflows',
          icon: Workflow,
          badge: undefined,
          badgeVariant: 'warning',
        },
        {
          view: 'settings',
          path: '/settings',
          icon: SlidersHorizontal,
          badge: undefined,
          badgeVariant: 'warning',
        },
        { view: 'runs', path: '/runs', icon: Play, badge: undefined, badgeVariant: 'warning' },
        {
          view: 'schedules',
          path: '/schedules',
          icon: CalendarClock,
          badge: undefined,
          badgeVariant: 'warning',
        },
        {
          view: 'reviews',
          path: '/reviews',
          icon: Inbox,
          badge: reviewsPendingCount,
          badgeVariant: 'warning',
        },
      ],
    },
    {
      label: NAVIGATION_COPY.engineGroup,
      entries: [
        {
          view: 'engine',
          label: NAVIGATION_COPY.engineOverview,
          path: '/engine',
          icon: Gauge,
          badge: undefined,
          badgeVariant: 'warning',
        },
        {
          view: 'workers',
          path: '/workers',
          icon: ServerCog,
          badge: workersUnhealthyCount,
          badgeVariant: 'danger',
        },
        {
          view: 'storage',
          path: '/storage',
          icon: Database,
          badge: undefined,
          badgeVariant: 'warning',
        },
        {
          view: 'system',
          path: '/system',
          icon: Settings,
          badge: undefined,
          badgeVariant: 'warning',
        },
        {
          view: 'audit',
          path: '/audit',
          icon: ScrollText,
          badge: undefined,
          badgeVariant: 'warning',
        },
      ],
    },
  ]);

  function isActivePath(path: string): boolean {
    // The home screen is Chat, so Chat is also active at `/`.
    if (path === '/chat' && router.pathname === '/') return true;
    return router.pathname === path || router.pathname.startsWith(`${path}/`);
  }

  function onNavClick(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
      return;
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
  function titleText(label: string, path: string): string {
    const keys = shortcutKeys(path);
    return keys === undefined ? label : `${label} (${keys.join(' ')})`;
  }
</script>

<Sidebar label="Interborough" bind:collapsed class={sidebarStateClass}>
  {#snippet navigation()}
    <SideNavigation ariaLabel="Views">
      {#each navGroups as group (group.label)}
        <SideNavigationGroup label={group.label}>
          {#each group.entries as entry (entry.path)}
            {@const Icon = entry.icon}
            <SideNavigationItem
              href={router.href(entry.path)}
              title={titleText(entry.label ?? VIEW_COPY[entry.view].label, entry.path)}
              active={isActivePath(entry.path)}
              onclick={(event) => onNavClick(event, entry.path)}
            >
              <span class="weft-shell-nav-item">
                <Icon aria-hidden="true" size={16} class="weft-shell-nav-item__icon" />
                <span class="weft-shell-nav-item__label"
                  >{entry.label ?? VIEW_COPY[entry.view].label}</span
                >
                {#if entry.badge !== undefined && entry.badge > 0}
                  <Badge variant={entry.badgeVariant} size="sm" class="weft-shell-nav-badge"
                    >{entry.badge}</Badge
                  >
                {/if}
              </span>
            </SideNavigationItem>
          {/each}
        </SideNavigationGroup>
      {/each}
    </SideNavigation>
  {/snippet}
  {#snippet footer()}
    <NavigationItem
      href={router.href('/engine')}
      variant="vertical"
      aria-label={engineStatusWords}
      title={engineStatusWords}
      onclick={(event) => onNavClick(event, '/engine')}
    >
      <span class="weft-shell-nav-item" data-engine-status={engineStatus}>
        <StatusDot
          status={ENGINE_DOT_STATUS[engineStatus]}
          label={engineStatusWords}
          labelVisible={false}
          live
        />
        <span class="weft-shell-nav-item__label">{NAVIGATION_COPY.engineLink}</span>
      </span>
    </NavigationItem>
  {/snippet}
</Sidebar>
