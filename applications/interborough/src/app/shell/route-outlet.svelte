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

  import { ErrorState, Skeleton } from '@lostgradient/cinder';
  import { useQueryClient } from '@tanstack/svelte-query';

  import { agentsListQuery } from '../../lib/agent-queries.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { NOT_FOUND_ROUTE_COPY, ROUTE_LOAD_FAILURE_COPY } from '../copy/views.ts';
  import { clearChunkReloadGuard, reloadOnceForMissingChunk } from './chunk-reload.ts';
  import FaultBoundary from '../fault-boundary.svelte';
  import NotFoundState from '../not-found-state.svelte';
  import ViewFrame from '../view-frame.svelte';
  import { pageWidth } from '../views.ts';

  let activeComponent = $state<Component | null>(null);
  let loading = $state(false);
  let notFound = $state(false);
  /** Set when the matched route's code could not be fetched. */
  let loadFailed = $state(false);
  const queryClient = useQueryClient();

  // The key the mounted component was loaded for. A navigation that leaves it as it was (a change
  // to the query string, or a page that asked to be kept, `router.navigate`'s `keep`) is not a
  // new page: it must not unmount what is on screen.
  let loadedKey: string | undefined;

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
    // Start the agent list while the route chunk is loading. The page and its view probe use the
    // same key, so TanStack shares this request without tying it to route teardown.
    if (definition.view === 'agents') void queryClient.prefetchQuery(agentsListQuery());
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

<!-- The outlet is the only thing that pads a page. The kind of page the route is decides how wide it
     is (`views.ts`, `pageWidth`), so a page never chooses its width for itself: `foundation.css`
     centres a reading page in the reading column. Every page has one density. A route that belongs
     to no view (the not-found page) reads like a reading page. -->
<main
  class="weft-shell-outlet"
  data-width={router.current.route ? pageWidth(router.current.route.kind) : 'reading'}
>
  <FaultBoundary>
    {#if notFound}
      <div class="weft-view" data-view="not-found" data-state="not-found">
        <NotFoundState title={NOT_FOUND_ROUTE_COPY.title} />
      </div>
    {:else if loadFailed}
      <div class="weft-view" data-state="error" data-view="route">
        <ErrorState
          variant="flat"
          title={ROUTE_LOAD_FAILURE_COPY.title}
          description={ROUTE_LOAD_FAILURE_COPY.description}
          headingLevel={1}
          retryLabel={ROUTE_LOAD_FAILURE_COPY.action}
          onRetry={() => window.location.reload()}
        />
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
