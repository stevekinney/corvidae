<script lang="ts">
  import { untrack } from 'svelte';
  import { Button } from '../button/index.ts';
  import { GroupedList } from '../grouped-list/index.ts';
  import { GroupedListItem } from '../grouped-list-item/index.ts';
  import { Drawer } from './index.ts';
  import type { DrawerDetent } from './index.ts';

  type FixtureProps = {
    open?: boolean;
    detents?: DrawerDetent[];
    detent?: DrawerDetent;
    count?: string;
    rows?: number;
    /** Draws the header as a Cancel, title, action bar. */
    headerBar?: boolean;
  };

  let {
    open = true,
    detents = ['peek', 'medium', 'large'],
    detent = 'medium',
    count = '12 results',
    rows = 12,
    headerBar = false,
  }: FixtureProps = $props();
  let drawerOpen = $state(untrack(() => open));
  let drawerDetent = $state<DrawerDetent>(untrack(() => detent));
  const items = $derived(
    Array.from({ length: rows }, (_, index) => ({
      id: `drawer-sheet-row-${index + 1}`,
      name: `Nightly run ${index + 1}`,
    })),
  );
</script>

{#snippet runRows()}
  {#each items as item (item.id)}
    <GroupedListItem>
      {#snippet title()}{item.name}{/snippet}
      {#snippet subtitle()}Completed{/snippet}
    </GroupedListItem>
  {/each}
{/snippet}

{#snippet apply()}
  <Button size="sm" label="Apply" onclick={() => (drawerOpen = false)} />
{/snippet}

<div class="drawer-sheet-fixture">
  <p>The list behind the sheet is the reference: the same rows, drawn on the page.</p>
  <div data-testid="reference-list">
    <GroupedList header="Runs">
      {@render runRows()}
    </GroupedList>
  </div>

  <Drawer
    bind:open={drawerOpen}
    bind:detent={drawerDetent}
    placement="bottom"
    title="Runs"
    {detents}
    {count}
    {...headerBar ? { closeLabel: 'Cancel', action: apply } : {}}
  >
    <GroupedList header="Runs">
      {@render runRows()}
    </GroupedList>

    {#snippet footer()}
      <Button label={`Show ${count}`} onclick={() => (drawerOpen = false)} />
    {/snippet}
  </Drawer>
</div>

<style>
  .drawer-sheet-fixture {
    min-block-size: 20rem;
    padding: 1rem;
  }
</style>
