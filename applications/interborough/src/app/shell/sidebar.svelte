<script lang="ts">
  /**
   * Left sidebar (design rows 03a to 03m, 04a to 04c, 05r, 07h, 07k): the product's name as text,
   * Home on its own, then Work, Build and System, which sits at the bottom of the column. Each
   * destination is one Cinder `SideNavigationItem`, so its rows, its active state, its count and
   * its dot are Cinder's (`(destinations.ts)` lists them, in order).
   *
   * Reviews carries Needs you: the reviews waiting on the caller, which disappears at zero and never
   * counts system problems. Health carries a dot that follows `bureau.health.attention`: amber while
   * anything needs attention, green when nothing does, and left out while the count is unknown (a
   * caller without `bureau.diagnostics:read` is refused it). The dot is hidden from assistive
   * technology; the row's name says it ("Health, 3 need attention").
   *
   * The sidebar is a tonal surface with no rule beside it (Cinder's own, COR-2315): the product's
   * name and the fold button sit in Cinder's `brand` slot, New chat is the `primaryAction`, and the
   * current destination is a raised white pill.
   *
   * The sidebar takes one of three forms (`./shell-navigation.svelte.ts`): the 190px column, the
   * 76px rail (an icon over its label) with an overlay that opens the column over the page, and the
   * 280px drawer behind the phone's tab bar.
   */
  import {
    Button,
    Sidebar,
    SideNavigation,
    SideNavigationGroup,
    SideNavigationItem,
  } from '@lostgradient/cinder';
  import type { HttpClient } from '@lostgradient/weft';
  import { PanelLeftClose, PanelLeftOpen } from '@lucide/svelte';

  import { router } from '../../lib/router.svelte.ts';
  import { usePendingReviewsCount } from '../../routes/reviews/pending-reviews-count.svelte.ts';
  import { NAVIGATION_COPY, SHORTCUT_COPY, VIEW_COPY } from '../copy.ts';
  import { getKeyboardPreferences } from '../keyboard-preferences.svelte.ts';
  import { getLayoutPreferences, LayoutPreferences } from '../layout-preferences.svelte.ts';
  import { useAttentionCount } from './attention-count.svelte.ts';
  import {
    DESTINATIONS,
    DESTINATION_GROUPS,
    isActiveDestinationPath,
    NEW_CHAT_KEY,
    NEW_CHAT_PATH,
    type Destination,
    type DestinationGroup,
  } from './destinations.ts';
  import {
    DRAWER_BREAKPOINT,
    getShellNavigation,
    ShellNavigation,
  } from './shell-navigation.svelte.ts';

  interface SidebarNavProps {
    client: HttpClient;
  }

  let { client }: SidebarNavProps = $props();

  // The shell provides one object that the top bar's menu button shares. A sidebar mounted without
  // the shell, as the standalone views and most tests are, keeps its own.
  const shell: ShellNavigation =
    getShellNavigation() ?? new ShellNavigation(getLayoutPreferences() ?? new LayoutPreferences());

  // What is waiting on the caller: the same number the Health overview shows as Needs you.
  const reviewsPending = usePendingReviewsCount(() => client);
  // What needs attention: system problems, never reviews.
  const attention = useAttentionCount();

  const mode = $derived(shell.mode);
  const collapsed = $derived(shell.collapsed);
  const overlay = $derived(mode === 'rail' && !collapsed);

  /** The class that gives the sidebar's one element its form, for the shell's stylesheet. */
  const sidebarClass = $derived(
    `weft-shell-sidebar weft-shell-sidebar--${mode}${collapsed ? ' weft-shell-sidebar--collapsed' : ''}${overlay ? ' weft-shell-sidebar--overlay' : ''}`,
  );

  function destinationsIn(group: DestinationGroup): readonly Destination[] {
    return DESTINATIONS.filter((destination) => destination.group === group);
  }

  function isActivePath(path: string): boolean {
    return isActiveDestinationPath(router.pathname, path);
  }

  // The keyboard preferences are the shell's; a sidebar mounted without it shows the key, which is
  // what the registry does by default. With single-key shortcuts off the key does nothing, so the
  // glyph beside New chat is left out rather than promise it.
  const keyboard = getKeyboardPreferences();
  const showNewChatKey = $derived(keyboard?.singleKeyShortcuts ?? true);

  function onNavClick(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
    // A drawer and an overlay close on navigation; the person's own preference is never touched.
    shell.close();
  }

  /** The Reviews row's count: the reviews waiting on the caller, which never includes a problem. */
  const reviewsCount = $derived(reviewsPending.count() ?? 0);

  /**
   * The Health row's signal: an amber dot while anything needs attention, a green one when nothing
   * does, and nothing while the count is unknown, so a dot never claims what was not read.
   */
  const healthSignal = $derived.by(() => {
    const count = attention.count();
    if (count === undefined) return {};
    return {
      count,
      countLabel: NAVIGATION_COPY.healthCountLabel,
      emptyLabel: NAVIGATION_COPY.healthEmptyLabel,
      dot: count === 0 ? ('success' as const) : ('warning' as const),
    };
  });

  function toggleCollapsed(): void {
    shell.collapsed = !shell.collapsed;
  }

  function onNewChat(): void {
    router.navigate(NEW_CHAT_PATH);
    shell.close();
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape' && overlay) shell.close();
  }}
/>

{#if overlay}
  <!-- The scrim over the page behind an expanded rail. Escape and the collapse button close it too. -->
  <button
    type="button"
    class="weft-shell-sidebar-scrim"
    aria-label={NAVIGATION_COPY.collapseSidebar}
    tabindex="-1"
    onclick={() => shell.close()}
  ></button>
{/if}
<div class="weft-shell-sidebar-slot" data-mode={mode}>
  <Sidebar
    label={NAVIGATION_COPY.productName}
    closeLabel={NAVIGATION_COPY.closeNavigation}
    mobileBreakpoint={DRAWER_BREAKPOINT}
    railLabels={mode === 'rail'}
    bind:collapsed={() => shell.collapsed, (value) => (shell.collapsed = value)}
    class={sidebarClass}
  >
    {#snippet navigation()}
      {#snippet brandRow()}
        <div class="weft-shell-sidebar__brand">
          <span class="weft-shell-sidebar__name">{NAVIGATION_COPY.productName}</span>
          <Button
            variant="ghost"
            iconOnly
            size="sm"
            aria-label={collapsed ? NAVIGATION_COPY.expandSidebar : NAVIGATION_COPY.collapseSidebar}
            aria-expanded={!collapsed}
            onclick={toggleCollapsed}
          >
            {#if collapsed}
              <PanelLeftOpen aria-hidden="true" size={16} />
            {:else}
              <PanelLeftClose aria-hidden="true" size={16} />
            {/if}
          </Button>
        </div>
      {/snippet}
      {#snippet newChatAction()}
        <!-- Cinder draws the control: a neutral, sidebar-wide row with an accent plus, this label,
             and the key as plain text. The key's name is `aria-keyshortcuts`, so the glyph is
             decoration. -->
        <button
          type="button"
          aria-keyshortcuts={showNewChatKey ? NEW_CHAT_KEY.toUpperCase() : undefined}
          onclick={onNewChat}
        >
          {SHORTCUT_COPY.newChat}
          {#if showNewChatKey}
            <span data-cinder-shortcut aria-hidden="true">{NEW_CHAT_KEY.toUpperCase()}</span>
          {/if}
        </button>
      {/snippet}
      {#snippet destinationItem(destination: Destination)}
        {@const Icon = destination.icon}
        {@const label = VIEW_COPY[destination.view].label}
        {#if destination.view === 'reviews'}
          <SideNavigationItem
            href={router.href(destination.path)}
            {label}
            count={reviewsCount}
            countLabel={NAVIGATION_COPY.reviewsCountLabel}
            active={isActivePath(destination.path)}
            onclick={(event) => onNavClick(event, destination.path)}
          >
            {#snippet icon()}<Icon size="1rem" />{/snippet}
            {label}
          </SideNavigationItem>
        {:else if destination.view === 'health'}
          <SideNavigationItem
            href={router.href(destination.path)}
            {label}
            {...healthSignal}
            active={isActivePath(destination.path)}
            onclick={(event) => onNavClick(event, destination.path)}
          >
            {#snippet icon()}<Icon size="1rem" />{/snippet}
            {label}
          </SideNavigationItem>
        {:else}
          <SideNavigationItem
            href={router.href(destination.path)}
            {label}
            active={isActivePath(destination.path)}
            onclick={(event) => onNavClick(event, destination.path)}
          >
            {#snippet icon()}<Icon size="1rem" />{/snippet}
            {label}
          </SideNavigationItem>
        {/if}
      {/snippet}
      <SideNavigation
        ariaLabel={NAVIGATION_COPY.destinations}
        class="weft-shell-side-navigation"
        brand={mode === 'drawer' ? undefined : brandRow}
        primaryAction={newChatAction}
      >
        {#each DESTINATION_GROUPS as group (group)}
          {#if group === 'home'}
            {#each destinationsIn(group) as destination (destination.path)}
              {@render destinationItem(destination)}
            {/each}
          {:else}
            <SideNavigationGroup
              label={NAVIGATION_COPY.groups[group]}
              collapsible={false}
              class={group === 'system' ? 'weft-shell-nav-system' : ''}
            >
              {#each destinationsIn(group) as destination (destination.path)}
                {@render destinationItem(destination)}
              {/each}
            </SideNavigationGroup>
          {/if}
        {/each}
      </SideNavigation>
    {/snippet}
  </Sidebar>
</div>
