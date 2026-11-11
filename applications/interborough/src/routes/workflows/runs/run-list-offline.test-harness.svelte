<script lang="ts">
  /**
   * Test-only: the route outlet (`route-outlet.test-harness.svelte`) under the shell's connection
   * monitor, so a test can show a page over a server that does not answer. The outlet's own harness
   * takes no monitor, and the page reads it from its ancestors, as it does under the shell. Never
   * imported by production code.
   */
  import type { HttpClient } from '@lostgradient/weft';
  import { untrack } from 'svelte';

  import { provideConnection, type ConnectionMonitor } from '../../../app/connection.svelte.ts';
  import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
  import type { AuthorizationScope } from '../../../lib/scopes.svelte.ts';

  interface Props {
    /** The client the views read through. */
    client: HttpClient;
    /** The scopes the principal holds. */
    scopes: readonly AuthorizationScope[];
    /** The shell's connection monitor, already told the server is unreachable. */
    connection: ConnectionMonitor;
  }

  let { client, scopes, connection }: Props = $props();

  provideConnection(untrack(() => connection));
</script>

<RouteOutletHarness {client} {scopes} />
