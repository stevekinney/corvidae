<script lang="ts">
  /**
   * Topbar (design rows 06a, 06l, 03b): the page's breadcrumb trail, built from the route table
   * (`../breadcrumbs.svelte.ts`), the ⌘K search trigger on one line, the notification bell, and
   * the quick settings popover. Who the request acts as and which scopes it holds are facts about
   * the host, not controls, so they live on System's Scopes tab and not here.
   *
   * The leading menu button is CSS-hidden above Cinder Sidebar's own mobile breakpoint
   * (`foundation.css`, `639.98px`) and is the only way to open the navigation drawer on a small
   * viewport: `Sidebar` renders no trigger of its own below that width.
   */
  import { Breadcrumbs, Button, Kbd } from '@lostgradient/cinder';
  import { Menu, Search } from '@lucide/svelte';

  import { router } from '../../lib/router.svelte.ts';
  import { breadcrumbTrail } from '../breadcrumbs.svelte.ts';
  import { NAVIGATION_COPY, PALETTE_COPY, VIEW_COPY } from '../copy.ts';
  import type { LayoutPreferences } from '../layout-preferences.svelte.ts';
  import type { NotificationStore } from '../notifications.svelte.ts';
  import type { ThemeStore } from '../theme.svelte.ts';
  import NotificationBell from './notification-bell.svelte';
  import QuickSettings from './quick-settings.svelte';

  interface TopbarProps {
    notifications: NotificationStore;
    theme: ThemeStore;
    layout: LayoutPreferences;
    paletteOpen: boolean;
    /** Whether the navigation drawer is open below the mobile breakpoint; the menu button opens it. */
    drawerOpen: boolean;
  }

  let {
    notifications,
    theme,
    layout,
    paletteOpen = $bindable(false),
    drawerOpen = $bindable(false),
  }: TopbarProps = $props();

  // The trail for the page on screen. An address no route names, such as the not-found page,
  // falls back to the view's name, and to the product's name when there is no view either.
  const trail = $derived.by(() => {
    const items = breadcrumbTrail(router.pathname);
    if (items.length > 0) {
      return items.map((item) =>
        item.href === undefined ? item : { ...item, href: router.href(item.href) },
      );
    }
    const view = router.current.route?.view;
    return [{ label: view === undefined ? 'Interborough' : VIEW_COPY[view].label }];
  });

  /** A breadcrumb link opens its page without leaving the application. */
  function onTrailClick(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    const href = link?.getAttribute('href');
    if (href === null || href === undefined) return;
    event.preventDefault();
    router.navigate(href);
  }
</script>

<header class="weft-shell-topbar">
  <Button
    variant="ghost"
    iconOnly
    class="weft-shell-topbar-control weft-shell-menu-trigger"
    aria-label="Toggle navigation menu"
    onclick={() => (drawerOpen = !drawerOpen)}
  >
    <Menu aria-hidden="true" size={18} />
  </Button>

  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="weft-shell-topbar__trail" onclick={onTrailClick}>
    <Breadcrumbs items={trail} label={NAVIGATION_COPY.breadcrumb} separator="›" />
  </div>

  <Button
    variant="ghost"
    class="weft-shell-topbar-control weft-shell-search-trigger"
    onclick={() => (paletteOpen = true)}
  >
    {#snippet leadingIcon()}<Search aria-hidden="true" size={16} />{/snippet}
    <span class="weft-shell-search-trigger__label">{PALETTE_COPY.placeholder}</span>
    <span class="weft-shell-search-trigger__kbd" aria-hidden="true">
      <Kbd size="sm">⌘</Kbd><Kbd size="sm">K</Kbd>
    </span>
  </Button>

  <NotificationBell store={notifications} />

  <QuickSettings {theme} {layout} />
</header>
