<script lang="ts">
  /**
   * The context a dashboard view needs, supplied for a view a host renders
   * on its own, outside `WeftDashboard`
   * (`documentation/weft-ui-public-surface.md`, open question 1).
   *
   * A host supplies only what `@lostgradient/weft/ui` exports: a client from
   * `provideClient()`, a `QueryClientProvider` around `createQueryClient()`,
   * and the `router`. Every view also reads a principal store, most read the
   * shared fleet event source, and mutation errors report through a mounted
   * `<ToastHost>`, none of which a host can provide. Inside `WeftDashboard`
   * the shell provides all three and this component adds nothing but the
   * fault boundary; on its own it provides each one an ancestor did not.
   *
   * - The principal store resolves the client's principal before the view
   *   renders, so a view never flashes its locked state for a granted scope.
   *   A failure that is not an authentication answer falls open to an
   *   anonymous principal, as `WeftDashboard`'s boot sequence does.
   * - The fleet event source is this view's own, closed when the view is.
   *   It opens a connection only when the view subscribes to it.
   */
  import type { Snippet } from 'svelte';

  import { setCodeHighlighterContext, Skeleton } from '@lostgradient/cinder';

  import { getClient } from '../lib/client.ts';
  import { codeHighlighter } from '../lib/code-highlighter.ts';
  import { FleetEventSource } from '../lib/live-source/fleet-event-source.svelte.ts';
  import {
    hasPrincipalStore,
    providePrincipalStore,
    resolvePrincipal,
  } from '../lib/scopes.svelte.ts';
  import { hasFleetEventSource, provideFleetEventSource } from '../app/engine-status.svelte.ts';
  import FaultBoundary from '../app/fault-boundary.svelte';
  import ToastHost, { hasToastHost, provideToastHost } from '../app/toast-host.svelte';

  interface StandaloneViewProps {
    /** The view's own route component. */
    children: Snippet;
  }

  let { children }: StandaloneViewProps = $props();

  const client = getClient();

  // `WeftDashboard` publishes the same highlighter at its root, so a view
  // highlights its code blocks identically wherever it renders.
  setCodeHighlighterContext(codeHighlighter);

  const principalStore = hasPrincipalStore() ? undefined : providePrincipalStore();
  let principalResolved = $state(principalStore === undefined);

  $effect(() => {
    if (principalStore === undefined) return undefined;
    let cancelled = false;
    void resolvePrincipal(client).then(
      (principal) => {
        if (cancelled) return undefined;
        // `null` is the server's authentication answer: no credential was
        // accepted. The store stays empty, so every scope-gated surface
        // renders locked with its reason.
        if (principal !== null) principalStore.setPrincipal(principal);
        principalResolved = true;
        return undefined;
      },
      () => {
        if (cancelled) return undefined;
        principalStore.setPrincipal({ scopes: [], unauthenticatedAccess: null });
        principalResolved = true;
        return undefined;
      },
    );
    return () => {
      cancelled = true;
    };
  });

  if (!hasFleetEventSource()) {
    const fleetSource = new FleetEventSource({ baseUrl: client.baseUrl, headers: client.headers });
    provideFleetEventSource(fleetSource);
    $effect(() => () => fleetSource.close());
  }

  const ownsToastHost = !hasToastHost();
  if (ownsToastHost) provideToastHost();
</script>

<FaultBoundary>
  {#if principalResolved}
    {@render children()}
  {:else}
    <div role="status" aria-busy="true" aria-label="Loading">
      <Skeleton height="1.5rem" width="40%" />
      <Skeleton height="10rem" />
    </div>
  {/if}
</FaultBoundary>
{#if ownsToastHost}
  <ToastHost />
{/if}
