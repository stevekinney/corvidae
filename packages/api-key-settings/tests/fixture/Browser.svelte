<script lang="ts">
  import { QueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';
  import { ApiKeySettingsProvider } from '../../src/svelte.ts';
  import ApiKeySettings from '../../src/ApiKeySettings.svelte';
  const cache = new QueryClient();
  let scope = $state('A');
  let showPage = $state(true);
  let writes = $state(0);
  let reads = $state(0);
  let uncertain = $state(false);
  let inspection = $state('');
  let delayNext = false;
  let resolveDelayed: (() => void) | undefined;
  let delivered = $state(false);
  let keys = $state<
    {
      id: string;
      label: string;
      subject: string;
      scopes: string[];
      workspaceId: string;
      actions: string[];
    }[]
  >([]);
  const transport = async (operation: string) =>
    untrack(() => {
      if (operation === 'api.keys.list') {
        reads++;
        return { keys, targets: [{ subject: 'service', scopes: ['read'] }] };
      }
      writes++;
      keys = [
        {
          id: 'id',
          label: 'sync',
          subject: 'service',
          scopes: ['read'],
          workspaceId: scope,
          actions: ['rotate', 'revoke'],
        },
      ];
      if (uncertain) throw new Error('Connection interrupted');
      if (delayNext) {
        delayNext = false;
        return new Promise((resolve) => {
          resolveDelayed = () => {
            delivered = true;
            resolve({ id: 'id', secret: 'late-secret', retiresAt: 20, revoked: true });
          };
        });
      }
      return { id: 'id', secret: 'secret-value', retiresAt: 20, revoked: true };
    });
</script>

<button
  onclick={() => {
    scope = scope === 'A' ? 'B' : 'A';
  }}>Change authority</button
>
<button
  onclick={() => {
    uncertain = true;
  }}>Lose response</button
>
<button
  onclick={() => {
    showPage = !showPage;
  }}>Toggle page</button
>
<button
  onclick={() => {
    delayNext = true;
  }}>Delay response</button
>
<button
  onclick={() => {
    resolveDelayed?.();
  }}>Resolve response</button
>
<button
  onclick={() => {
    inspection = JSON.stringify([
      cache
        .getQueryCache()
        .getAll()
        .map((entry) => ({ key: entry.queryKey, data: entry.state.data })),
      cache
        .getMutationCache()
        .getAll()
        .map((entry) => entry.state.data),
    ]);
  }}>Inspect caches</button
>
<output data-testid="reads">{reads}</output><output data-testid="writes">{writes}</output>
<output data-testid="cache">{inspection}</output>
<output data-testid="delivered">{delivered}</output>
<ApiKeySettingsProvider {scope} {cache} {transport}>
  {#if showPage}<ApiKeySettings />{/if}
</ApiKeySettingsProvider>
