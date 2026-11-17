<script lang="ts">
  import { DataList } from '../data-list/index.ts';
  import { StatusDot } from '../status-dot/index.ts';
  import { StackedListItem } from './index.ts';

  const rows = [{ id: 'worker', title: 'Refund worker' }];
</script>

<!-- A 360px pane: the row's own width is a phone's, whatever the viewport is. -->
<div class="stacked-list-item-pane-fixture" data-testid="pane">
  <DataList items={rows} key={(row) => row.id}>
    {#snippet children(row)}
      <StackedListItem>
        {#snippet status()}<StatusDot word="Waiting on you" />{/snippet}
        {#snippet title()}{row.title}{/snippet}
        {#snippet time()}10:42 AM{/snippet}
        {#snippet meta()}Chat{/snippet}
      </StackedListItem>
    {/snippet}
  </DataList>
</div>

<style>
  .stacked-list-item-pane-fixture {
    inline-size: 360px;
  }
</style>
