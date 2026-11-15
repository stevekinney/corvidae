<script lang="ts">
  /** Test-only composition of the shared route harness (clients, queries, principal) around Home. */
  import type { HttpClient } from '@lostgradient/weft';
  import { untrack } from 'svelte';

  import { provideConnection, type ConnectionMonitor } from '../../app/connection.svelte.ts';
  import type { AuthorizationScope } from '../../lib/scopes.svelte.ts';
  import HomeRouteHarness from './home-route-harness.test-harness.svelte';
  import Home from './index.svelte';

  interface Props {
    client: HttpClient;
    scopes?: readonly AuthorizationScope[] | undefined;
    /** The identity the first-run checklist keeps its choices under; none keeps nothing. */
    workspace?: { readonly workspaceId: string; readonly actorId: string } | undefined;
    /** The shell's connection monitor, provided to the page as the shell does. */
    connection?: ConnectionMonitor | undefined;
  }

  let { client, scopes, workspace, connection }: Props = $props();

  const monitor = untrack(() => connection);
  if (monitor !== undefined) provideConnection(monitor);
</script>

<HomeRouteHarness {client} {scopes} {workspace}>
  {#snippet children()}
    <Home />
  {/snippet}
</HomeRouteHarness>
