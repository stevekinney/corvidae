<script lang="ts">
  import type { Snippet } from 'svelte';

  import { getActionEmphasisContext, setActionEmphasisContext } from './action-emphasis-context.ts';

  /**
   * Scope for a header's actions. In compact mode each Button draws at the `xs` control height.
   * Renders no element of its own.
   */
  let { children, compact = true }: { children: Snippet; compact?: boolean } = $props();

  // Inherit the enclosing emphasis (a `<PageHeader error>` demotes primaries) and add only
  // `compact`. The getter keeps the read reactive.
  const enclosing = getActionEmphasisContext();

  setActionEmphasisContext({
    get demotePrimary() {
      return enclosing?.demotePrimary ?? false;
    },
    get compact() {
      return compact;
    },
  });
</script>

{@render children()}
