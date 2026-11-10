<script lang="ts">
  import type { Snippet } from 'svelte';

  import { getActionEmphasisContext, setActionEmphasisContext } from './action-emphasis-context.ts';

  /**
   * Scope for a header's actions: every Button rendered inside draws at the `xs` control height,
   * so the header is never taller than its title. Renders no element of its own.
   */
  let { children }: { children: Snippet } = $props();

  // Inherit the enclosing emphasis (a `<PageHeader error>` demotes primaries) and add only
  // `compact`. The getter keeps the read reactive.
  const enclosing = getActionEmphasisContext();

  setActionEmphasisContext({
    get demotePrimary() {
      return enclosing?.demotePrimary ?? false;
    },
    compact: true,
  });
</script>

{@render children()}
