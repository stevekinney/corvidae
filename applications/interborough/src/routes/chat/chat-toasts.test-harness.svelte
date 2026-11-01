<script lang="ts">
  /**
   * Test-only page that renders the conversation below a query client with the shell's toast host
   * beside it, for the controls that answer with a toast. Never imported by production code.
   */
  import type { ComponentProps } from 'svelte';

  import ToastHost from '../../app/toast-host.svelte';
  import QueryPage from './query-page.test-harness.svelte';

  let props: ComponentProps<typeof QueryPage> = $props();
</script>

<QueryPage {...props} />
<ToastHost />
