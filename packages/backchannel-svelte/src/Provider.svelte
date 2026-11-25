<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { CatalogTransport, SubscriptionTransport } from '@lostgradient/backchannel/client';
  import type { QueryClient } from '@tanstack/svelte-query';
  import Scope from './Scope.svelte';

  let {
    scope,
    cache,
    transport,
    subscription,
    children,
  }: {
    scope: string;
    cache: QueryClient;
    transport: CatalogTransport;
    subscription?: SubscriptionTransport | undefined;
    children: Snippet;
  } = $props();
</script>

{#key scope}
  <Scope {scope} {cache} {transport} {subscription}>{@render children()}</Scope>
{/key}
