<script lang="ts">
  /**
   * Test-only page that renders the Memory tab below a query client with the shell's toast host
   * beside it, for what the tab says in a toast: a memory added (with its Undo) and an export
   * saved. The shell mounts the host and says so, as `provideToastHost` does here. Never imported
   * by production code.
   */
  import type { ComponentProps } from 'svelte';

  import ToastHost, { provideToastHost } from '../../app/toast-host.svelte';
  import QueryPage from '../chat/query-page.test-harness.svelte';

  let props: ComponentProps<typeof QueryPage> = $props();

  provideToastHost();
</script>

<QueryPage {...props} />
<ToastHost />
