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
   * close on Escape internally) — nothing extra to wire here.
   */
  import { SIDEBAR_MOBILE_MEDIA_QUERY } from '@lostgradient/cinder';
  import type { HttpClient } from '@lostgradient/weft';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';

  import { provideClient } from '../../lib/client.ts';
  import { stepChord } from '../../lib/navigation-shortcuts.ts';
  import { router } from '../../lib/router.svelte.ts';
  import type { Principal } from '../../lib/scopes.svelte.ts';
  import { providePrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import { EngineStatusController, provideFleetEventSource } from '../engine-status.svelte.ts';
  import { NotificationStore } from '../notifications.svelte.ts';
  import { subscribeTaskEvidenceInvalidation } from '../task-event-queries.ts';
  import { ThemeStore } from '../theme.svelte.ts';
  import AuthModeBanner from './auth-mode-banner.svelte';
  import CommandPaletteLauncher from './command-palette.svelte';
  import CriticalAlertStrip from './critical-alert-strip.svelte';
  import RouteOutlet from './route-outlet.svelte';
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
  const notifications = new NotificationStore();
  const engineStatus = new EngineStatusController(initialClient, notifications);
  // Additive Track B workaround — see `engine-status.svelte.ts`'s
  // `provideFleetEventSource()` doc: shares the ONE fleet SSE connection with
  // route components instead of each opening its own.
  provideFleetEventSource(engineStatus.fleetSource);

  $effect(() => {
    return () => engineStatus.dispose();
  });

  // A host problem is named in the bell as well as by the status dot: the dot turns red or amber,
  // and the bell says which problem it is and keeps saying it until the engine answers again.
  $effect(() => {
    notifications.reportEngineStatus(engineStatus.status, Date.now());
  });

  // `g`, then a letter, opens a view (`../../lib/navigation-shortcuts.ts`); the sidebar's tooltips
  // name the same keys.
  $effect(() => {
    let armedAtMs: number | null = null;
    function onKeydown(event: KeyboardEvent): void {
      const target = event.target;
      const editable =
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));
      const step = stepChord(
        armedAtMs,
        {
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          editable,
        },
        Date.now(),
      );
      armedAtMs = step.armedAtMs;
      if (step.path !== null) router.navigate(step.path);
    }
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  // A dead-lettered or delivered task result refreshes the task evidence on screen and the
  // Dashboard's alerts without a manual refresh. This rides the one shared fleet subscription.
  const queryClient = useQueryClient();
  $effect(() => subscribeTaskEvidenceInvalidation(engineStatus.fleetSource, queryClient));

  /**
   * `collapsed` doubles as "drawer closed" once Cinder's `Sidebar` switches
   * to its mobile presentation below `SIDEBAR_MOBILE_MEDIA_QUERY` (its own
   * internal `open = !collapsed` — `sidebar.svelte`). Left at its plain
   * default of `false`, a mobile page load would render the navigation
   * drawer OPEN over the whole screen with no trigger to close it. Start
   * collapsed on a mobile viewport instead.
   *
   * The desktop shell has no manual icon-rail toggle (the design keeps the
   * sidebar always expanded above the mobile breakpoint — see the CSS
   * comment on `.weft-shell-menu-trigger` in `foundation.css`), so
   * `collapsed` must track the breakpoint directly: true while the
   * viewport is mobile, false once it crosses back to desktop. Anything
   * short of that (e.g. only forcing collapse on mobile *entry*) leaves a
   * desktop→mobile→desktop resize with the sidebar permanently stuck at
   * 64px with no way to re-expand it, since the only toggle
   * (`.weft-shell-menu-trigger`) is CSS-hidden above the breakpoint.
   */
  const isMobileViewport = new MediaQuery(SIDEBAR_MOBILE_MEDIA_QUERY, false);

  let sidebarCollapsed = $state(isMobileViewport.current);

  $effect(() => {
    sidebarCollapsed = isMobileViewport.current;
  });

  let paletteOpen = $state(false);
</script>

<div class="weft-shell">
  <Sidebar {client} engineStatus={engineStatus.status} bind:collapsed={sidebarCollapsed} />
  <div class="weft-shell-main">
    <Topbar
      {notifications}
      liveStatus={engineStatus.fleetSource.status}
      {theme}
      bind:paletteOpen
      bind:sidebarCollapsed
    />
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
