<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';

  import { Button } from '../button/index.ts';
  import { DataList } from '../data-list/index.ts';
  import { StackedListItem } from './index.ts';

  const rows = [{ id: 'row' }];
</script>

<!-- Two rows under the 448px container width: one whose trailing region is a decorative chevron,
     which stays beside the body, and one whose trailing region holds a button, which drops under
     it. -->
<div class="stacked-list-item-trailing-fixture">
  <div data-testid="glyph">
    <DataList items={rows} key={(row) => row.id}>
      {#snippet children()}
        <StackedListItem href="#archived">
          {#snippet title()}Archived chats{/snippet}
          {#snippet trailing()}<ChevronRight aria-hidden="true" size={16} />{/snippet}
        </StackedListItem>
      {/snippet}
    </DataList>
  </div>
  <div data-testid="control">
    <DataList items={rows} key={(row) => row.id}>
      {#snippet children()}
        <StackedListItem>
          {#snippet title()}Nightly export{/snippet}
          {#snippet trailing()}<Button variant="secondary" size="sm">Run now</Button>{/snippet}
        </StackedListItem>
      {/snippet}
    </DataList>
  </div>
</div>

<style>
  .stacked-list-item-trailing-fixture {
    inline-size: 20rem;
  }
</style>
