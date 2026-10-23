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
  import { CircleAlert } from '@lucide/svelte';

  import { router } from '../../lib/router.svelte.ts';
  import { ROUTE_LOAD_FAILURE_COPY } from '../copy.ts';
  import FaultBoundary from '../fault-boundary.svelte';
  import ViewFrame from '../view-frame.svelte';

  let activeComponent = $state<Component | null>(null);
  let loading = $state(false);
  let notFound = $state(false);
  /** Set when the matched route's code could not be fetched. */
  let loadFailed = $state(false);

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
    if (definition.redirect !== undefined) {
      // The route renders nothing: it names where to go, and a failure to say lands on the
      // chat list, which shows what is wrong in its own words.
      definition.redirect({ params: match.params }).then(
        (path) => {
          if (!cancelled) router.navigate(path, { replace: true });
          return undefined;
        },
        () => {
          if (!cancelled) router.navigate('/chat', { replace: true });
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
        return undefined;
      })
      .catch(() => {
        if (cancelled) return undefined;
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

<main class="weft-shell-outlet">
  <FaultBoundary>
    {#if notFound}
      <EmptyState
        title="Page not found"
        description="This path isn't one of the console's routes. Use the sidebar or Cmd+K to navigate."
      />
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
