<script lang="ts">
  import { setContext, type Snippet } from 'svelte';

  // Stands in for Cinder's Accordion. It only needs to share the open-item list
  // with its items so a test can open a "Show code" disclosure the way a reader
  // does and let the page react to `expandedIds`.
  let {
    expandedIds = $bindable([] as string[]),
    children,
  }: { expandedIds?: string[]; children?: Snippet } = $props();

  setContext('component-page-accordion-mock', {
    toggle(id: string): void {
      expandedIds = expandedIds.includes(id)
        ? expandedIds.filter((expandedId) => expandedId !== id)
        : [...expandedIds, id];
    },
  });
</script>

<div>
  {#if children !== undefined}
    {@render children()}
  {/if}
</div>
