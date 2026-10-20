<script lang="ts">
  /**
   * Test-only page that renders the sidebar under the query client it reads its badge counts
   * from. Never imported by production code.
   */
  import type { HttpClient } from '@lostgradient/weft';
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import type { LiveSourceStatus } from '../../lib/live-source/index.ts';
  import { createQueryClient } from '../../lib/query.ts';
  import {
    AUTHORIZATION_SCOPES,
    providePrincipalStore,
    type AuthorizationScope,
  } from '../../lib/scopes.svelte.ts';
  import Sidebar from './sidebar.svelte';

  interface SidebarHarnessProps {
    client: HttpClient;
    engineStatus?: LiveSourceStatus;
    /** The scopes the principal holds; every scope by default. */
    scopes?: readonly AuthorizationScope[];
  }

  let {
    client,
    engineStatus = 'live',
    scopes = AUTHORIZATION_SCOPES,
  }: SidebarHarnessProps = $props();

  providePrincipalStore().setPrincipal({
    scopes: untrack(() => scopes),
    subject: 'tester',
    unauthenticatedAccess: null,
  });

  const initialClient = untrack(() => client);
  const queryClient = createQueryClient();
</script>

<QueryClientProvider client={queryClient}>
  <Sidebar client={initialClient} {engineStatus} />
</QueryClientProvider>
