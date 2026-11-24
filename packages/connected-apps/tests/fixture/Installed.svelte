<script lang="ts">
  import { ConnectedAppsProvider } from '@lostgradient/connected-apps/svelte';
  import ConnectedApps from '@lostgradient/connected-apps/ui';
  import { httpJsonRpcTransport } from '@lostgradient/backchannel/client';
  import { QueryClient } from '@tanstack/svelte-query';
  const cache = new QueryClient();
  let scope = $state('A');
  const transport = httpJsonRpcTransport({
    baseUrl: '/connected-apps',
    headers: { 'x-csrf': 'valid' },
  });
</script>

<button
  onclick={() => {
    scope = scope === 'A' ? 'B' : 'A';
    document.cookie = `workspace=${scope}; path=/`;
  }}>Change account</button
>
<ConnectedAppsProvider {scope} {cache} {transport}><ConnectedApps /></ConnectedAppsProvider>
