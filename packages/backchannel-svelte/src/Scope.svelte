<script lang="ts">
  import { onDestroy, untrack, type Snippet } from 'svelte';
  import type { CatalogTransport, SubscriptionTransport } from '@lostgradient/backchannel/client';
  import type { QueryClient } from '@tanstack/svelte-query';
  import { createCatalogHost } from './index.ts';
  import { setCatalogHost } from './context.ts';

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
  const host = untrack(() => createCatalogHost({ scope, cache, transport, subscription }));
  setCatalogHost(host);
  onDestroy(() => host.dispose());
</script>

{@render children()}
