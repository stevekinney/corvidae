<script lang="ts">
  import type { Snippet } from 'svelte';

  import { setActionEmphasisContext } from './action-emphasis-context.ts';

  let { children }: { children: Snippet } = $props();

  // What `<PageHeader error>` publishes for everything under it.
  setActionEmphasisContext({
    get demotePrimary() {
      return true;
    },
  });
</script>

{@render children()}
