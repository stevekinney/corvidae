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
   * Esc-closes-overlays is already Cinder's own contract for `CommandPalette`
   * and `Dropdown` (both close on Escape internally). Every key goes through
   * the shortcut registry (`../../lib/shortcuts.ts`): the shell registers ⌘K
   * for the palette, `g` then a letter for each destination and `?` for the
   * map (`./destinations.ts`), and reads each key press against it. ⌘K acts from inside a field,
   * the composer included, and never under Shift (⌘⇧K is the composer's link shortcut); the plain
   * keys never act inside a field, and a person can turn them off in Settings.
   */
  import { Banner } from '@lostgradient/cinder';
  import type { HttpClient } from '@lostgradient/weft';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { onDestroy, untrack } from 'svelte';

  import { provideClient } from '../../lib/client.ts';
  import { BureauEventSource } from '../../lib/live-source/bureau-event-source.svelte.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { shortcuts } from '../../lib/shortcuts.ts';
  import { armWriteGuard } from '../../lib/write-guard.ts';
  import type { Principal } from '../../lib/scopes.svelte.ts';
  import { providePrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import { subscribeBureauInvalidation } from '../bureau-event-queries.ts';
  import { CONNECTION_COPY } from '../copy.ts';
  import {
    CONNECTION_MAX_ATTEMPTS,
    connectionBannerPreset,
    ConnectionMonitor,
    provideConnection,
  } from '../connection.svelte.ts';
  import { EngineStatusController, provideFleetEventSource } from '../engine-status.svelte.ts';
  import { restartActivity } from '../restart/host-restart-flow.svelte.ts';
  import { connectFleetInvalidation } from '../fleet-invalidation.svelte.ts';
  import { provideBureauEventSource } from '../live-polling.svelte.ts';
  import { connectNotificationFeed } from '../notification-feed.svelte.ts';
  import {
    KeyboardPreferences,
    provideKeyboardPreferences,
  } from '../keyboard-preferences.svelte.ts';
  import { LayoutPreferences, provideLayoutPreferences } from '../layout-preferences.svelte.ts';
  import { NotificationStore } from '../notifications.svelte.ts';
  import { subscribeTaskEvidenceInvalidation } from '../task-event-queries.ts';
  import { ThemeStore } from '../theme.svelte.ts';
  import AuthModeBanner from './auth-mode-banner.svelte';
  import { holdChangingActions } from './changing-actions.ts';
  import CommandPaletteLauncher from './command-palette.svelte';
  import CriticalAlertStrip from './critical-alert-strip.svelte';
  import { registerShellShortcuts } from './destinations.ts';
  import PluginProblemsBanner from './plugin-problems-banner.svelte';
  import RouteOutlet from './route-outlet.svelte';
  import ShortcutMap from './shortcut-map.svelte';
  import { provideShellNavigation, ShellNavigation } from './shell-navigation.svelte.ts';
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

  const queryClient = useQueryClient();

  // Whether the server answers. Every request that gets no answer says so, the browser's own
  // offline event says so, and the probe of `/v1/health` that the monitor makes while it is down
  // says when it is back, at which point what the page kept is fetched again.
  const connection = provideConnection(
    new ConnectionMonitor({
      probe: () =>
        fetch(`${initialClient.baseUrl}/v1/health`, {
          headers: initialClient.headers,
          cache: 'no-store',
        }),
      onRecovered: () => void queryClient.invalidateQueries(),
    }),
  );
  // Armed while the shell initializes, not in an effect, because a child that captures `fetch` when
  // it is created (a chat's run wiring) would otherwise keep the one that never refuses.
  const disarmWriteGuard = armWriteGuard(
    () => connection.unreachable,
    [window.location.origin, new URL(initialClient.baseUrl, window.location.origin).origin],
  );
  onDestroy(disarmWriteGuard);
  $effect(() => {
    const stopObserving = connection.observe(queryClient);
    const goOffline = () => connection.setBrowserOffline(true);
    const comeOnline = () => connection.setBrowserOffline(false);
    // A page opened while the browser is already offline gets no `offline` event to say so.
    // Untracked: a change to the monitor's own state must not re-run this effect.
    untrack(() => {
      if (connection.browserOffline) connection.reportUnreachable();
    });
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', comeOnline);
    return () => {
      stopObserving();
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', comeOnline);
    };
  });
  // Disposed with the shell, not with the effect: the monitor outlives a re-run of the effect.
  onDestroy(() => connection.dispose());

  // While the host restarts the monitor keeps quiet (see the banner below). When the restart is
  // over it asks the server once, so a host that is back does not wait out a countdown behind a
  // banner that is no longer true.
  let restartWasActive = false;
  $effect(() => {
    const active = restartActivity.active;
    untrack(() => {
      if (restartWasActive && !active) void connection.check();
      restartWasActive = active;
    });
  });

  const theme = new ThemeStore();
  const layout = provideLayoutPreferences(new LayoutPreferences());
  const keyboard = provideKeyboardPreferences(new KeyboardPreferences());
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
  connectNotificationFeed(notifications, {
    canReadSchedules: () => principalStore.hasScope('schedules:read'),
  });

  let shortcutMapOpen = $state(false);
  let paletteOpen = $state(false);

  $effect(() =>
    registerShellShortcuts(shortcuts, {
      navigate: (path) => router.navigate(path),
      openShortcutMap: () => (shortcutMapOpen = true),
      openPalette: () => (paletteOpen = true),
    }),
  );

  // "Use single-key shortcuts" in Settings: with it off the registry ignores the plain keys, and
  // the palette stops printing them beside its actions (design row 03f).
  $effect(() => {
    shortcuts.setSingleKeyShortcuts(keyboard.singleKeyShortcuts);
    return () => shortcuts.setSingleKeyShortcuts(true);
  });

  // Every key press is read against the registry, in the scope of the route on screen and the
  // focus regions (`data-shortcut-region`) around the focus.
  $effect(() => {
    function onKeydown(event: KeyboardEvent): void {
      // A field that handled its own Enter has prevented it, but ⌘Enter is the key a field never
      // handles, and is meant to act from inside one (`modifier: 'mod'`).
      if (event.defaultPrevented && !event.metaKey && !event.ctrlKey) return;
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
          shiftKey: event.shiftKey,
          editable,
          repeat: event.repeat,
        },
        {
          routePattern: router.current.route?.pattern ?? null,
          regions,
          dialogOpen:
            shortcutMapOpen || paletteOpen || document.querySelector('dialog[open]') !== null,
        },
        Date.now(),
      );
      if (handled) event.preventDefault();
    }
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  // The engine's feed giving up is the server being unreachable. While the feed is only retrying
  // the server may be fine, so that asks the server once instead of saying it is down.
  $effect(() => {
    const status = engineStatus.status;
    untrack(() => {
      if (status === 'stale' || status === 'closed') connection.reportUnreachable();
    });
  });
  $effect(() => {
    if (engineStatus.fleetSource.status === 'reconnecting') untrack(() => void connection.check());
  });

  // A dead-lettered or delivered task result refreshes the task evidence on screen and the
  // Dashboard's alerts without a manual refresh. This rides the one shared fleet subscription.
  $effect(() => subscribeTaskEvidenceInvalidation(engineStatus.fleetSource, queryClient));
  // The engine's feed, applied for every page: a schedule that fires and the run it launches
  // settling, a review requested or decided, a worker connecting, a run's update answered.
  connectFleetInvalidation(engineStatus.fleetSource, queryClient);
  // The Bureau's feed, applied for every page: a review requested or decided, a run settling.
  $effect(() => subscribeBureauInvalidation(bureauEvents, queryClient));

  // How the navigation is shown at this width and pointer: the column, the rail, or the drawer
  // (`./shell-navigation.svelte.ts`). The sidebar and the top bar's menu button share it.
  provideShellNavigation(new ShellNavigation(layout));

  // While the server does not answer, every control that changes something is held back: dimmed by
  // the shell's `data-connection` attribute, refused on activation, and marked `aria-disabled`.
  // The page's own `disabled` state is never touched (`./changing-actions.ts`).
  // A dialog renders outside the shell, so the hold covers the whole document.
  $effect(() => {
    if (!connection.unreachable) return;
    return holdChangingActions(document.body, CONNECTION_COPY.changesOff);
  });
</script>

<div class="weft-shell" data-connection={connection.unreachable ? 'unreachable' : 'reachable'}>
  <Sidebar {client} />
  <div class="weft-shell-main">
    <Topbar {notifications} {theme} {layout} bind:paletteOpen />
    {#if connection.unreachable && !restartActivity.active}
      <!-- While the host restarts the restart dialog is the one account of it, so this stays quiet.
           The preset writes the words (`bannerPresetCopy`): the browser offline, the server not
           answering with its countdown, or the retries stopped. Retry now is always there. -->
      <Banner
        preset={connectionBannerPreset(connection)}
        dataUpdatedAt={connection.lastHealthyAt}
        retryInSeconds={connection.retryInSeconds}
        attempt={connection.browserOffline || connection.attempt === 0
          ? undefined
          : connection.attempt}
        maxAttempts={CONNECTION_MAX_ATTEMPTS}
        onRetry={() => void connection.retryNow()}
      />
    {/if}
    <AuthModeBanner mode={principalStore.bannerMode} />
    <PluginProblemsBanner unreachable={connection.unreachable} />
    <CriticalAlertStrip store={notifications} />
    <RouteOutlet />
  </div>
</div>

<CommandPaletteLauncher
  bind:open={paletteOpen}
  {client}
  store={notifications}
  registry={shortcuts}
  scheduleReadGate={scopeGate(principalStore, ['schedules:read'])}
  workflowReadGate={scopeGate(principalStore, ['workflows:read'])}
  reviewReadGate={scopeGate(principalStore, ['reviews:read'])}
  systemReadGate={scopeGate(principalStore, ['system:read'])}
/>

<ShortcutMap registry={shortcuts} bind:open={shortcutMapOpen} />
