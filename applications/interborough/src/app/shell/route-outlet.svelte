<script lang="ts">
  /**
   * Route outlet (plan §13 T1.6): lazily mounts the matched route
   * component from `../routes.ts`, wrapped in `<FaultBoundary>` per route
   * (T1.5) with a `<Skeleton>` shown while the chunk loads. Keeps the
   * placeholder shell's dynamic-import behavior — this is the same
   * `definition.load()` contract every domain track's `index.svelte`
   * already satisfies.
   */
  import type { Component } from 'svelte';

  import { Button, Skeleton, EmptyState } from '@lostgradient/cinder';
  import { CircleAlert, SearchX } from '@lucide/svelte';

  import { router } from '../../lib/router.svelte.ts';
  import { NOT_FOUND_ROUTE_COPY, ROUTE_LOAD_FAILURE_COPY } from '../copy.ts';
  import { clearChunkReloadGuard, reloadOnceForMissingChunk } from './chunk-reload.ts';
  import FaultBoundary from '../fault-boundary.svelte';
  import ViewFrame from '../view-frame.svelte';
  import { effectiveDensity, getLayoutPreferences } from '../layout-preferences.svelte.ts';
  import { pageWidth, VIEWS } from '../views.ts';

  const layoutPreferences = getLayoutPreferences();

  let activeComponent = $state<Component | null>(null);
  let loading = $state(false);
  let notFound = $state(false);
  /** Set when the matched route's code could not be fetched. */
  let loadFailed = $state(false);

  // The key the mounted component was loaded for. A navigation that leaves it as it was (a change
  // to the query string, or a page that asked to be kept, `router.navigate`'s `keep`) is not a
  // new page: it must not unmount what is on screen.
  let loadedKey: string | undefined;

  function goToChats(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(NOT_FOUND_ROUTE_COPY.action.href);
  }

  $effect(() => {
    const match = router.current;
    const definition = match.route;
    const key = router.viewKey;
    if (definition !== null && definition.redirect === undefined && key === loadedKey) return;
    loadedKey = undefined;

    if (!definition) {
      activeComponent = null;
      loading = false;
      loadFailed = false;
      notFound = true;
      return;
    }

    notFound = false;
    loadFailed = false;
    loading = true;
    let cancelled = false;
    if (definition.redirect !== undefined) {
      // The route renders nothing: it names where to go, and a failure to say lands on the
      // chat list, which shows what is wrong in its own words.
      definition.redirect({ params: match.params }).then(
        (path) => {
          if (!cancelled) router.navigate(path, { replace: true });
          return undefined;
        },
        () => {
          if (!cancelled) router.navigate('/chats', { replace: true });
          return undefined;
        },
      );
      return () => {
        cancelled = true;
      };
    }
    definition
      .load()
      .then((loadedModule) => {
        if (cancelled) return undefined;
        activeComponent = loadedModule.default;
        loadedKey = key;
        loading = false;
        clearChunkReloadGuard();
        return undefined;
      })
      .catch((error: unknown) => {
        if (cancelled) return undefined;
        // The host was rebuilt since this tab loaded, so the chunk's name is gone: fetch the new
        // page once instead of showing the failure. The skeleton stays up while the page goes.
        if (reloadOnceForMissingChunk(error)) return undefined;
        // The previous route's component must not stay on screen under the new address.
        activeComponent = null;
        loading = false;
        loadFailed = true;
        return undefined;
      });

    return () => {
      cancelled = true;
    };
  });
</script>

<!-- The outlet is the only thing that pads a page. The view the route belongs to decides how dense
     the page is, unless the person asked for compact everywhere, and the kind of page the route is
     decides how wide (`views.ts`, `pageWidth`), so a page never chooses either for itself: it reads
     Cinder's density tokens, and `foundation.css` centres a reading page in the reading column. A
     route that belongs to no view (the not-found page) reads like a reading page. -->
<main
  class="weft-shell-outlet"
  data-density={effectiveDensity(
    router.current.route?.view ? VIEWS[router.current.route.view].density : 'comfortable',
    layoutPreferences?.density ?? 'comfortable',
  )}
  data-width={router.current.route ? pageWidth(router.current.route.kind) : 'reading'}
>
  <FaultBoundary>
    {#if notFound}
      <div class="weft-view" data-view="not-found" data-state="not-found">
        <EmptyState
          title={NOT_FOUND_ROUTE_COPY.title}
          description={NOT_FOUND_ROUTE_COPY.description}
          headingLevel={1}
        >
          {#snippet icon()}<SearchX size={28} aria-hidden="true" />{/snippet}
          {#snippet action()}
            <div class="weft-not-found__action">
              <code class="ib-identifier weft-not-found__path">{router.pathname}</code>
              <Button
                variant="primary"
                href={router.href(NOT_FOUND_ROUTE_COPY.action.href)}
                onclick={goToChats}
              >
                {NOT_FOUND_ROUTE_COPY.action.label}
              </Button>
            </div>
          {/snippet}
        </EmptyState>
      </div>
    {:else if loadFailed}
      <div class="weft-view" data-state="error" data-view="route">
        <EmptyState
          title={ROUTE_LOAD_FAILURE_COPY.title}
          description={ROUTE_LOAD_FAILURE_COPY.description}
          headingLevel={1}
        >
          {#snippet icon()}<CircleAlert size={28} aria-hidden="true" />{/snippet}
          {#snippet action()}
            <Button variant="secondary" onclick={() => window.location.reload()}>
              {ROUTE_LOAD_FAILURE_COPY.action}
            </Button>
          {/snippet}
        </EmptyState>
      </div>
    {:else if loading || !activeComponent}
      <div class="weft-shell-outlet__skeleton" role="status" aria-busy="true" aria-label="Loading">
        <Skeleton height="1.5rem" width="40%" />
        <Skeleton height="10rem" />
        <Skeleton height="10rem" />
      </div>
    {:else}
      {#key router.viewKey}
        {@const ActiveComponent = activeComponent}
        {@const view = router.current.route?.view}
        {#if view}
          <ViewFrame
            {view}
            parameters={router.current.params}
            pattern={router.current.route?.pattern}
          >
            <ActiveComponent />
          </ViewFrame>
        {:else}
          <ActiveComponent />
        {/if}
      {/key}
    {/if}
  </FaultBoundary>
</main>
