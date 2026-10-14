<script lang="ts">
  /*
   * The palette half of "Search components". Loaded on demand by
   * `component-search.svelte`, so its `CommandPalette` graph never rides in a
   * page's first transfer. Results come from the sidebar's own inventory, and
   * each item carries its canonical documentation URL as its value; selecting
   * one hands that URL to the single navigation seam.
   */
  import { CommandItem, CommandPalette } from '@lostgradient/cinder';

  import { COMPONENT_SEARCH_LABEL } from './component-search-shortcut.ts';
  import {
    COMPONENT_SEARCH_EMPTY_TEXT,
    navigateToComponent,
    rankComponents,
  } from './component-search.ts';

  type Props = {
    open: boolean;
    components: readonly string[];
    /** Where focus returns when the palette closes. */
    returnFocusTo: HTMLElement | null;
  };

  let { open = $bindable(false), components, returnFocusTo }: Props = $props();

  function select(href: string): void {
    open = false;
    navigateToComponent(href);
  }
</script>

<CommandPalette
  bind:open
  label={COMPONENT_SEARCH_LABEL}
  placeholder="Search components…"
  triggerRef={returnFocusTo}
>
  {#snippet items({ query })}
    {#each rankComponents(components, query) as result (result.name)}
      <CommandItem
        value={result.href}
        accessibleLabel={result.label}
        onSelect={() => select(result.href)}
      >
        {result.label}
      </CommandItem>
    {/each}
  {/snippet}

  {#snippet empty()}
    {COMPONENT_SEARCH_EMPTY_TEXT}
  {/snippet}
</CommandPalette>
