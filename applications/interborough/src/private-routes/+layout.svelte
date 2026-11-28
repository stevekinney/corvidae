<script lang="ts">
  import { getNavigationState } from '@lostgradient/velveteen/navigation';
  import { onDestroy, type Snippet } from 'svelte';
  import { router } from '../lib/router.svelte.ts';

  let { children }: { children: Snippet } = $props();

  if (typeof window !== 'undefined') {
    const state = getNavigationState();
    onDestroy(router.bindNative(state));
    const remove = state.registerNavigationHook?.('before', ({ type, routeId, to, cancel }) => {
      if (type === 'link' && routeId === null) {
        cancel();
        window.location.assign(to.href);
      }
    });
    if (remove !== undefined) onDestroy(remove);
  }
</script>

<svelte:head>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</svelte:head>

{@render children()}
