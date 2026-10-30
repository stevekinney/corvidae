<script lang="ts">
  /**
   * Topbar: the title of the current view, the ⌘K search trigger, the notification bell, and the
   * theme toggle, all ghost buttons of one height. Who the request acts as and which scopes it
   * holds are facts about the host, not controls, so they live on System's Scopes tab and not
   * here. `router.current.route` drives a lightweight current-domain label — full breadcrumbs are
   * a per-surface concern (workflow/schedule/review detail headers), out of the shell's scope.
   *
   * The leading menu button (PROJECT-BRIEF: "topbar condenses … overflow
   * menu for secondary controls") is CSS-hidden above Cinder Sidebar's own
   * mobile breakpoint (`foundation.css`, `639.98px`) and is the only way to
   * reopen the navigation drawer on a small viewport once it's closed —
   * `Sidebar` itself renders no trigger of its own below that width.
   */
  import { Button, Kbd } from '@lostgradient/cinder';
  import { Menu, Monitor, Moon, Search, Sun } from '@lucide/svelte';

  import { router } from '../../lib/router.svelte.ts';
  import { PALETTE_COPY, VIEW_COPY } from '../copy.ts';
  import type { ThemeStore } from '../theme.svelte.ts';
  import NotificationBell from './notification-bell.svelte';
  import type { NotificationStore } from '../notifications.svelte.ts';

  interface TopbarProps {
    notifications: NotificationStore;
    theme: ThemeStore;
    paletteOpen: boolean;
    /** Bound to `Sidebar`'s own `collapsed` (`./shell.svelte`) — below the mobile breakpoint this doubles as "drawer closed"; the menu button toggles it open. */
    sidebarCollapsed: boolean;
  }

  let {
    notifications,
    theme,
    paletteOpen = $bindable(false),
    sidebarCollapsed = $bindable(false),
  }: TopbarProps = $props();

  const domainLabel = $derived.by(() => {
    const view = router.current.route?.view;
    return view === undefined ? 'Interborough' : VIEW_COPY[view].label;
  });

  const THEME_LABEL = { light: 'Light theme', dark: 'Dark theme', system: 'System theme' } as const;
</script>

<header class="weft-shell-topbar">
  <Button
    variant="ghost"
    iconOnly
    class="weft-shell-menu-trigger"
    aria-label="Toggle navigation menu"
    onclick={() => (sidebarCollapsed = !sidebarCollapsed)}
  >
    <Menu aria-hidden="true" size={18} />
  </Button>

  <span class="weft-shell-topbar__domain">{domainLabel}</span>

  <Button variant="ghost" class="weft-shell-search-trigger" onclick={() => (paletteOpen = true)}>
    {#snippet leadingIcon()}<Search aria-hidden="true" size={16} />{/snippet}
    <span class="weft-shell-search-trigger__label">{PALETTE_COPY.placeholder}</span>
    <span class="weft-shell-search-trigger__kbd" aria-hidden="true">
      <Kbd size="sm">⌘</Kbd><Kbd size="sm">K</Kbd>
    </span>
  </Button>

  <NotificationBell store={notifications} />

  <Button
    variant="ghost"
    iconOnly
    aria-label={`Theme: ${THEME_LABEL[theme.mode]}. Activate to switch.`}
    title={THEME_LABEL[theme.mode]}
    onclick={() => theme.cycle()}
  >
    {#if theme.mode === 'light'}
      <Sun aria-hidden="true" size={16} />
    {:else if theme.mode === 'dark'}
      <Moon aria-hidden="true" size={16} />
    {:else}
      <Monitor aria-hidden="true" size={16} />
    {/if}
  </Button>
</header>
