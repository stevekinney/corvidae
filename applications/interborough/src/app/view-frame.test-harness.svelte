<script lang="ts">
  /**
   * Test-only page that provides what a view frame reads from its ancestors (a client, a principal
   * store, a query client) and renders a frame around a stub of the view's content. Never imported
   * by production code.
   */
  import type { HttpClient } from '@lostgradient/weft';
  import { QueryClientProvider, type QueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { provideClient } from '../lib/client.ts';
  import { createQueryClient } from '../lib/query.ts';
  import {
    providePrincipalStore,
    type AuthorizationScope,
    type PrincipalStore,
  } from '../lib/scopes.svelte.ts';
  import ViewFrame from './view-frame.svelte';
  import type { ViewName } from './views.ts';

  interface ViewFrameHarnessProps {
    client: HttpClient;
    scopes: readonly AuthorizationScope[];
    view: ViewName;
    parameters?: Readonly<Record<string, string>>;
    /** The matched route's pattern, for a view whose routes ask different questions. */
    pattern?: string;
    /** Receives the principal store the frame reads, so a test can watch a scope being revoked. */
    onStore?: (store: PrincipalStore) => void;
    /** Receives the query client the frame reads, so a test can wait on a query's own state. */
    onQueryClient?: (client: QueryClient) => void;
  }

  let {
    client,
    scopes,
    view,
    parameters = {},
    pattern,
    onStore,
    onQueryClient,
  }: ViewFrameHarnessProps = $props();

  provideClient(untrack(() => client));
  const store = providePrincipalStore();
  store.setPrincipal({
    scopes: untrack(() => scopes),
    subject: 'tester',
    unauthenticatedAccess: null,
  });
  untrack(() => onStore)?.(store);
  const queryClient = createQueryClient();
  untrack(() => onQueryClient)?.(queryClient);
</script>

<QueryClientProvider client={queryClient}>
  <ViewFrame {view} {parameters} {pattern}>
    <p data-testid="content">The {view} view’s content.</p>
  </ViewFrame>
</QueryClientProvider>
