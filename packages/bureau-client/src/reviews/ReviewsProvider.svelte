<script lang="ts">
  import Provider from '@lostgradient/backchannel-svelte/provider';
  import type { CatalogTransport, SubscriptionTransport } from '@lostgradient/backchannel/client';
  import type { QueryClient } from '@tanstack/svelte-query';
  import type { Snippet } from 'svelte';
  import ReviewsScope from './ReviewsScope.svelte';
  import type { ApprovalHost } from './tool-approval-actions.svelte.ts';

  let {
    scope,
    cache,
    transport,
    subscription,
    authorized,
    decisionSurface,
    onOutcome,
    children,
  }: {
    scope: string;
    cache: QueryClient;
    transport: CatalogTransport;
    subscription?: SubscriptionTransport | undefined;
    children: Snippet;
  } & Omit<ApprovalHost, 'catalog'> = $props();
</script>

<Provider {scope} {cache} {transport} {subscription}>
  <ReviewsScope {authorized} {decisionSurface} {onOutcome}>{@render children()}</ReviewsScope>
</Provider>
