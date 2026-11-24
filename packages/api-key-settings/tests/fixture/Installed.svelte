<script lang="ts">
  import { ApiKeySettingsProvider } from '@lostgradient/api-key-settings/svelte';
  import ApiKeySettings from '@lostgradient/api-key-settings/ui';
  import { httpJsonRpcTransport } from '@lostgradient/backchannel/client';
  import { dehydrate, QueryClient } from '@tanstack/svelte-query';
  const cache = new QueryClient();
  const transport = httpJsonRpcTransport({
    baseUrl: '/key-admin',
    headers: { 'x-csrf-token': 'valid' },
  });
  let scope = $state(document.cookie.includes('workspace=B') ? 'B' : 'A');
  (window as typeof window & { inspectSettings: () => string }).inspectSettings = () =>
    JSON.stringify({
      hydration: dehydrate(cache),
      queries: cache
        .getQueryCache()
        .getAll()
        .map((entry) => entry.state.data),
      mutations: cache
        .getMutationCache()
        .getAll()
        .map((entry) => entry.state.data),
      local: { ...localStorage },
      session: { ...sessionStorage },
      html: document.documentElement.outerHTML,
    });
</script>

<button
  onclick={() => {
    scope = scope === 'A' ? 'B' : 'A';
    document.cookie = `workspace=${scope}; path=/`;
  }}>Change authority</button
>
<ApiKeySettingsProvider {scope} {cache} {transport}><ApiKeySettings /></ApiKeySettingsProvider>
