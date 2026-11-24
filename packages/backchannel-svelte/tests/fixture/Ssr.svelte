<script lang="ts">
  import { QueryClient } from '@tanstack/svelte-query';
  import { ProbeProvider } from './generated/operation-client.svelte.ts';
  import Seeded from './Seeded.svelte';
  let { onRead = () => {} }: { onRead?: () => void } = $props();
  const cache = new QueryClient();
  const transport = async () => {
    onRead();
    throw new Error('Hydration must use the seed');
  };
</script>

<ProbeProvider scope="a" {cache} {transport}><Seeded /></ProbeProvider>
