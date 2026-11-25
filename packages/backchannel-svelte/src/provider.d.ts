import type { CatalogTransport, SubscriptionTransport } from '@lostgradient/backchannel/client';
import type { QueryClient } from '@tanstack/svelte-query';
import type { Component, Snippet } from 'svelte';

declare const Provider: Component<{
  scope: string;
  cache: QueryClient;
  transport: CatalogTransport;
  subscription?: SubscriptionTransport | undefined;
  children: Snippet;
}>;
export default Provider;
