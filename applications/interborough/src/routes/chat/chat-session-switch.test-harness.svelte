<script lang="ts">
  /**
   * Test-only page that shows one chat at a time as the router does: a different session is a new
   * mount of the conversation, with the shell's toast host beside it. Never imported by production
   * code.
   */
  import type { Component } from 'svelte';

  import ToastHost from '../../app/toast-host.svelte';
  import { createQueryClient } from '../../lib/query.ts';
  import QueryPage from './query-page.test-harness.svelte';

  interface SessionSwitchProps {
    page: Component<Record<string, unknown>>;
    sessionId: string;
    pageProps?: Record<string, unknown>;
  }

  let { page, sessionId, pageProps = {} }: SessionSwitchProps = $props();
</script>

{#key sessionId}
  <QueryPage {page} pageProps={{ ...pageProps, sessionId }} client={createQueryClient()} />
{/key}
<ToastHost />
