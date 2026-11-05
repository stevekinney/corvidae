<script lang="ts">
  /**
   * Test-only page that renders the sidebar under the query client it reads its badge counts
   * from. Never imported by production code.
   */
  import type { HttpClient } from '@lostgradient/weft';
  import { QueryClientProvider } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { createQueryClient } from '../../lib/query.ts';
  import {
    AUTHORIZATION_SCOPES,
    providePrincipalStore,
    type AuthorizationScope,
  } from '../../lib/scopes.svelte.ts';
  import { provideShellNavigation, type ShellNavigation } from './shell-navigation.svelte.ts';
  import Sidebar from './sidebar.svelte';

  interface SidebarHarnessProps {
    client: HttpClient;
    /** The scopes the principal holds; every scope by default. */
    scopes?: readonly AuthorizationScope[];
    /** The shell's navigation state, which a test drives; the sidebar keeps its own without it. */
    navigation?: ShellNavigation;
  }

  let { client, scopes = AUTHORIZATION_SCOPES, navigation }: SidebarHarnessProps = $props();

  const providedNavigation = untrack(() => navigation);
  if (providedNavigation !== undefined) provideShellNavigation(providedNavigation);

  providePrincipalStore().setPrincipal({
    scopes: untrack(() => scopes),
    subject: 'tester',
    unauthenticatedAccess: null,
  });

  const initialClient = untrack(() => client);
  const queryClient = createQueryClient();
</script>

<QueryClientProvider client={queryClient}>
  <Sidebar client={initialClient} />
</QueryClientProvider>
