<script lang="ts">
  /**
   * Test-only page for the Workflows area with the shell's toast host beside it, for a test that
   * reads what a page says in a toast after it has left (a schedule a delete could not take with
   * it). Never imported by production code.
   */
  import type { HttpClient } from '@lostgradient/weft';

  import ToastHost, { provideToastHost } from '../../app/toast-host.svelte';
  import type { AuthorizationScope } from '../../lib/scopes.svelte.ts';
  import AreaHarness from './area-harness.test-harness.svelte';

  interface ToastAreaHarnessProps {
    client: HttpClient;
    scopes: readonly AuthorizationScope[];
  }

  let { client, scopes }: ToastAreaHarnessProps = $props();

  // The shell mounts the toast host, so a write that fails has somewhere to say so.
  provideToastHost();
</script>

<AreaHarness {client} {scopes} />
<ToastHost />
