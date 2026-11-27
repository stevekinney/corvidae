<script lang="ts">
  import Provider from '@lostgradient/backchannel-svelte/provider';
  import type { CatalogTransport, SubscriptionTransport } from '@lostgradient/backchannel/client';
  import type { QueryClient } from '@tanstack/svelte-query';
  import type { Snippet } from 'svelte';
  import ReviewsScope from './ReviewsScope.svelte';
  import { validatedReviewsTransport } from './validation.ts';
  import type { ApprovalHost } from './tool-approval-actions.svelte.ts';

  let {
    scope,
    cache,
    transport,
    subscription,
    authorized,
    decisionSurface,
    onOutcome,
    seed,
    children,
  }: {
    scope: string;
    cache: QueryClient;
    transport: CatalogTransport;
    subscription?: SubscriptionTransport | undefined;
    children: Snippet;
    seed?: { scope: string; entries: readonly { input: unknown; data: unknown }[] } | undefined;
  } & Omit<ApprovalHost, 'catalog'> = $props();

  let seedConsumed = false;
  function takeSeed(currentScope: string) {
    if (seedConsumed) return [];
    seedConsumed = true;
    return seed?.scope === currentScope ? seed.entries : [];
  }
</script>

<Provider {scope} {cache} transport={validatedReviewsTransport(transport)} {subscription}>
  <ReviewsScope {authorized} {decisionSurface} {onOutcome} {takeSeed}
    >{@render children()}</ReviewsScope
  >
</Provider>
