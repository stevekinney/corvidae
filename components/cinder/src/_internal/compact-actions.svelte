<script lang="ts">
  import type { Snippet } from 'svelte';

  import { setActionEmphasisContext } from './action-emphasis-context.ts';

  /**
   * Scope for a header's actions: every Button rendered inside draws at the `xs` control height,
   * so the header is never taller than its title. Renders no element of its own.
   */
  let { children }: { children: Snippet } = $props();

  setActionEmphasisContext({
    demotePrimary: false,
    compact: true,
  });
</script>

{@render children()}
