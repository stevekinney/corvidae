<script lang="ts">
  import { Checkbox } from '../checkbox/index.ts';
  import { DataList } from '../data-list/index.ts';
  import { StackedListItem } from './index.ts';

  const rows = [
    { id: 'short', title: 'Send the quarterly report' },
    {
      id: 'long',
      title:
        'Archive every receipt that arrives from the shop and file it under the quarter it was issued, so the accountant can find it without asking anyone',
    },
  ];
</script>

<div class="stacked-list-item-fixture" data-testid="rows">
  <DataList items={rows} key={(row) => row.id}>
    {#snippet children(row)}
      <StackedListItem>
        {#snippet leading()}
          <Checkbox variant="task" aria-label={row.title} />
        {/snippet}
        {#snippet title()}{row.title}{/snippet}
      </StackedListItem>
    {/snippet}
  </DataList>
</div>

<style>
  .stacked-list-item-fixture {
    inline-size: 20rem;
  }
</style>
