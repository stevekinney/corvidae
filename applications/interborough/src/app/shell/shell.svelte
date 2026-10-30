<script lang="ts">
  /**
   * Console chrome (plan §13 T1.6): mounted once a client + principal are
   * final (`../app.svelte` owns the bootstrap/API-key-entry sequence ahead
   * of this). `provideClient()`/`providePrincipalStore()` run here, during
   * this component's own initialization — Svelte only allows `setContext`
   * during init, which is why the boot sequence that builds the client lives
   * one level up in `../app.svelte`.
   *
   * Keyboard (plan §13 T1.6's "⌘K opens palette, Esc closes overlays"):
   * ⌘K is registered by `./command-palette.svelte`; Esc-closes-overlays is
   * already Cinder's own contract for `CommandPalette` and `Dropdown` (both
   * close on Escape internally). Every other key goes through the shortcut
   * registry (`../../lib/shortcuts.ts`): the shell registers `g` then a letter
   * for each destination and `?` for the map (`./destinations.ts`), and reads
   * each key press against it.
   */
  import { SIDEBAR_MOBILE_MEDIA_QUERY } from '@lostgradient/cinder';
  import type { HttpClient } from '@lostgradient/weft';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';

  import { provideClient } from '../../lib/client.ts';
  import { BureauEventSource } from '../../lib/live-source/bureau-event-source.svelte.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { shortcuts } from '../../lib/shortcuts.ts';
  import type { Principal } from '../../lib/scopes.svelte.ts';
  import { providePrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import { subscribeBureauInvalidation } from '../bureau-event-queries.ts';
  import { EngineStatusController, provideFleetEventSource } from '../engine-status.svelte.ts';
  import { connectFleetInvalidation } from '../fleet-invalidation.svelte.ts';
  import { provideBureauEventSource } from '../live-polling.svelte.ts';
  import { connectNotificationFeed } from '../notification-feed.svelte.ts';
  import { LayoutPreferences, provideLayoutPreferences } from '../layout-preferences.svelte.ts';
  import { NotificationStore } from '../notifications.svelte.ts';
  import { subscribeTaskEvidenceInvalidation } from '../task-event-queries.ts';
  import { ThemeStore } from '../theme.svelte.ts';
  import AuthModeBanner from './auth-mode-banner.svelte';
  import CommandPaletteLauncher from './command-palette.svelte';
  import CriticalAlertStrip from './critical-alert-strip.svelte';
  import { registerShellShortcuts } from './destinations.ts';
  import RouteOutlet from './route-outlet.svelte';
  import ShortcutMap from './shortcut-map.svelte';
  import Sidebar from './sidebar.svelte';
  import Topbar from './topbar.svelte';

  interface ShellProps {
    client: HttpClient;
    initialPrincipal: Principal;
    onAuthExpired: (expiredClient: HttpClient) => void;
  }

  let { client, initialPrincipal, onAuthExpired }: ShellProps = $props();

  // `client`/`initialPrincipal` are read exactly once, here, at Shell's own
  // initialization — see the module doc: these values belong to one
  // credential session, so there is deliberately no reactive dependency on
  // either prop past this point. `untrack()` makes that explicit instead of
  // triggering Svelte's "state referenced locally" warning.
  const {
    client: initialClient,
    principal: resolvedPrincipal,
    onAuthExpired: authExpiredHandler,
  } = untrack(() => ({
    client,
    principal: initialPrincipal,
    onAuthExpired,
  }));

  provideClient(initialClient);
  const principalStore = providePrincipalStore({
    onAuthExpired: () => authExpiredHandler(initialClient),
  });
  principalStore.setPrincipal(resolvedPrincipal);

  const theme = new ThemeStore();
  const layout = provideLayoutPreferences(new LayoutPreferences());
  const notifications = new NotificationStore();
  const engineStatus = new EngineStatusController(initialClient);
  // Additive Track B workaround — see `engine-status.svelte.ts`'s
  // `provideFleetEventSource()` doc: shares the ONE fleet SSE connection with
  // route components instead of each opening its own.
  provideFleetEventSource(engineStatus.fleetSource);

  // The Bureau's own feed (`bureau.events`): the one connection the Bureau's views follow instead of
  // asking again on a timer. Provided before anything below reads it.
  const bureauEvents = new BureauEventSource();
  provideBureauEventSource(bureauEvents);

  $effect(() => {
    return () => {
      engineStatus.dispose();
      bureauEvents.close();
    };
  });

  // A host problem is named in the bell as well as by the status dot: the dot turns red or amber,
  // and the bell says which problem it is and keeps saying it until the engine answers again.
  $effect(() => {
    notifications.reportEngineStatus(engineStatus.status, Date.now());
  });

  // What is waiting on the person, and what finished, comes from the Bureau.
  connectNotificationFeed(notifications);

  let shortcutMapOpen = $state(false);

  $effect(() =>
    registerShellShortcuts(shortcuts, {
      navigate: (path) => router.navigate(path),
      openShortcutMap: () => (shortcutMapOpen = true),
    }),
  );

  // Every key press is read against the registry, in the scope of the route on screen and the
  // focus regions (`data-shortcut-region`) around the focus.
  $effect(() => {
    function onKeydown(event: KeyboardEvent): void {
      if (event.defaultPrevented) return;
      const target = event.target;
      const element = target instanceof Element ? target : null;
      const editable =
        element instanceof HTMLElement &&
        (element.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName));
      const regions: string[] = [];
      for (
        let region = element?.closest('[data-shortcut-region]');
        region;
        region = region.parentElement?.closest('[data-shortcut-region]')
      ) {
        const id = region.getAttribute('data-shortcut-region');
        if (id !== null) regions.push(id);
      }
      const handled = shortcuts.handleKey(
        {
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          editable,
        },
        { routePattern: router.current.route?.pattern ?? null, regions },
        Date.now(),
      );
      if (handled) event.preventDefault();
    }
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  // A dead-lettered or delivered task result refreshes the task evidence on screen and the
  // Dashboard's alerts without a manual refresh. This rides the one shared fleet subscription.
  const queryClient = useQueryClient();
  $effect(() => subscribeTaskEvidenceInvalidation(engineStatus.fleetSource, queryClient));
  // The engine's feed, applied for every page: a schedule that fires and the run it launches
  // settling, a review requested or decided, a worker connecting, a run's update answered.
  connectFleetInvalidation(engineStatus.fleetSource, queryClient);
  // The Bureau's feed, applied for every page: a review requested or decided, a run settling.
  $effect(() => subscribeBureauInvalidation(bureauEvents, queryClient));

  /**
   * On a desktop viewport the sidebar's `collapsed` is the person's icon-rail preference, which
   * the shell keeps in storage. Below `SIDEBAR_MOBILE_MEDIA_QUERY` Cinder's `Sidebar` becomes a
   * drawer and `collapsed` means "drawer closed" (its own `open = !collapsed`), which starts
   * closed on every page load and is never stored: a phone must not open on a drawer over the
   * whole screen, and closing the drawer must not fold the desktop sidebar.
   */
  const isMobileViewport = new MediaQuery(SIDEBAR_MOBILE_MEDIA_QUERY, false);

  let drawerOpen = $state(false);

  function sidebarCollapsed(): boolean {
    return isMobileViewport.current ? !drawerOpen : layout.sidebarCollapsed;
  }

  function setSidebarCollapsed(collapsed: boolean): void {
    if (isMobileViewport.current) drawerOpen = !collapsed;
    else layout.setSidebarCollapsed(collapsed);
  }

  let paletteOpen = $state(false);
</script>

<div class="weft-shell">
  <Sidebar
    {client}
    engineStatus={engineStatus.status}
    bind:collapsed={sidebarCollapsed, setSidebarCollapsed}
  />
  <div class="weft-shell-main">
    <Topbar {notifications} {theme} {layout} bind:paletteOpen bind:drawerOpen />
    <AuthModeBanner mode={principalStore.bannerMode} />
    <CriticalAlertStrip store={notifications} />
    <RouteOutlet />
  </div>
</div>

<CommandPaletteLauncher
  bind:open={paletteOpen}
  {client}
  scheduleReadGate={scopeGate(principalStore, ['schedules:read'])}
/>

<ShortcutMap registry={shortcuts} bind:open={shortcutMapOpen} />
