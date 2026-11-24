<script lang="ts">
  import { ApiKeySettingsProvider } from '@lostgradient/api-key-settings/svelte';
  import ApiKeySettings from '@lostgradient/api-key-settings/ui';
  import { httpJsonRpcTransport } from '@lostgradient/backchannel/client';
  import { dehydrate, QueryClient } from '@tanstack/svelte-query';
  const cache = new QueryClient();
  let loseNextResponse = false;
  (window as typeof window & { loseNextSettingsResponse: () => void }).loseNextSettingsResponse =
    () => {
      loseNextResponse = true;
    };
  const transport = httpJsonRpcTransport({
    baseUrl: '/key-admin',
    headers: { 'x-csrf-token': 'valid' },
    fetch: async (input, init) => {
      const method =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as { method?: string }).method
          : undefined;
      const response = await fetch(input, init);
      if (loseNextResponse && method === 'api.keys.issue') {
        loseNextResponse = false;
        await response.body?.cancel();
        throw new Error('Response lost after commit');
      }
      return response;
    },
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
