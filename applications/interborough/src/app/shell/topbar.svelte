<script lang="ts">
  /**
   * Topbar (design rows 06a, 06l, 03b): the page's breadcrumb trail, built from the route table
   * (`../breadcrumbs.svelte.ts`), the ⌘K search trigger on one line, the notification bell, and
   * the quick settings popover. Who the request acts as and which scopes it holds are facts about
   * the host, not controls, so they live on Settings › API reference › Your scopes and not here.
   *
   * The leading menu button is drawn only while the navigation is a drawer (under 640px, and on a
   * touch device under 1024px: `./shell-navigation.svelte.ts`), and is the only way to open it:
   * `Sidebar` renders no trigger of its own. The bar is 52px, and on a phone it reads menu, title,
   * then search, notifications and quick settings as icon buttons; the search field with its ⌘K
   * hint returns at tablet width. Below a top-level page on a phone, the trail's back link takes the
   * menu button's place (design row 06m), so the title is not squeezed out; the menu is one step
   * back, on the page that has no parent.
   */
  import { Breadcrumbs, Button, Kbd } from '@lostgradient/cinder';
  import { Menu, Search } from '@lucide/svelte';

  import { router } from '../../lib/router.svelte.ts';
  import { breadcrumbTrail } from '../breadcrumbs.svelte.ts';
  import { NAVIGATION_COPY, PALETTE_COPY } from '../copy/shell.ts';
  import { NOT_FOUND_COPY } from '../copy/views.ts';
  import { VIEW_COPY } from '../copy/view-pages.ts';
  import type { LayoutPreferences } from '../layout-preferences.svelte.ts';
  import type { NotificationStore } from '../notifications.svelte.ts';
  import type { ThemeStore } from '../theme.svelte.ts';
  import { getShellNavigation } from './shell-navigation.svelte.ts';
  import NotificationBell from './notification-bell.svelte';
  import QuickSettings from './quick-settings.svelte';

  interface TopbarProps {
    notifications: NotificationStore;
    theme: ThemeStore;
    layout: LayoutPreferences;
    paletteOpen: boolean;
  }

  let { notifications, theme, layout, paletteOpen = $bindable(false) }: TopbarProps = $props();

  const shell = getShellNavigation();

  // The trail for the page on screen. An address no route owns reads in words, as the leading
  // pages it does match and then "Not found" (Runs › Not found); one that matches none is only
  // "Not found".
  const trail = $derived.by(() => {
    const unmatched = router.current.route === null;
    const items = breadcrumbTrail(router.pathname, undefined, undefined, !unmatched);
    const linked = items.map((item) =>
      item.href === undefined ? item : { ...item, href: router.href(item.href) },
    );
    if (unmatched) return [...linked, { label: NOT_FOUND_COPY.breadcrumb }];
    if (linked.length > 0) return linked;
    const view = router.current.route?.view;
    return [{ label: view === undefined ? 'Interborough' : VIEW_COPY[view].label }];
  });

  /** A link in the "…" menu of hidden ancestors opens its page without leaving the application. */
  function onOverflowNavigate(item: { href?: string }, event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    if (item.href === undefined) return;
    event.preventDefault();
    router.navigate(item.href);
  }

  /** A breadcrumb link opens its page without leaving the application. */
  function onTrailClick(event: MouseEvent): void {
    // A link inside the entry's popover (a chat's agent) has already opened its page.
    if (event.defaultPrevented) return;
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

<!-- A page below a top-level one has a parent, which the trail offers as a back link on a phone
     (design row 06m: "‹ Chat", "‹ Health"). That link takes the menu button's place there
     (`data-nested`), so the title keeps the room: the menu is one step back, on the list. -->
<header class="weft-shell-topbar" data-nested={trail.length > 1 ? '' : undefined}>
  {#if shell?.mode === 'drawer'}
    <Button
      variant="ghost"
      iconOnly
      quiet
      class="weft-shell-topbar-control weft-shell-menu-trigger"
      aria-label={NAVIGATION_COPY.openNavigation}
      aria-expanded={shell.drawerOpen}
      onclick={() => (shell.drawerOpen = !shell.drawerOpen)}
    >
      <Menu aria-hidden="true" size={18} />
    </Button>
  {/if}

  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="weft-shell-topbar__trail" onclick={onTrailClick}>
    <Breadcrumbs
      items={trail}
      label={NAVIGATION_COPY.breadcrumb}
      separator="›"
      {onOverflowNavigate}
    />
  </div>

  <Button
    variant="ghost"
    class="weft-shell-topbar-control weft-shell-search-trigger"
    onclick={() => (paletteOpen = true)}
  >
    {#snippet leadingIcon()}<Search aria-hidden="true" size={16} />{/snippet}
    <span class="weft-shell-search-trigger__label">{PALETTE_COPY.trigger}</span>
    <span class="weft-shell-search-trigger__kbd" aria-hidden="true">
      <Kbd size="sm">⌘</Kbd><Kbd size="sm">K</Kbd>
    </span>
  </Button>

  <NotificationBell store={notifications} />

  <QuickSettings {theme} {layout} />
</header>
