<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';

  import { Button } from '../button/index.ts';
  import { DataList } from '../data-list/index.ts';
  import { StatusDot } from '../status-dot/index.ts';
  import { StackedListItem } from './index.ts';

  const rows = [{ id: 'row' }];
  const paneRows = [{ id: 'worker', title: 'Refund worker' }];
</script>

<!-- Two rows under the 448px container width: one whose trailing region is a decorative chevron,
     which stays beside the body, and one whose trailing region holds a button, which drops under
     it. -->
<div class="stacked-list-item-trailing-fixture">
  <div data-testid="glyph">
    <DataList items={rows} key={(row) => row.id}>
      {#snippet children()}
        <StackedListItem href="#archived" trailingGlyph>
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
  <div data-testid="lines-control">
    <DataList items={rows} key={(row) => row.id}>
      {#snippet children()}
        <StackedListItem actions={[{ label: 'Connect provider', href: '#provider' }]} lines>
          {#snippet leading()}<span aria-hidden="true">!</span>{/snippet}
          {#snippet title()}Connect a provider before the next run{/snippet}
          {#snippet meta()}Scheduled runs cannot start until a provider is connected.{/snippet}
        </StackedListItem>
      {/snippet}
    </DataList>
  </div>
  <div data-testid="lines-control-viewport">
    <DataList items={rows} key={(row) => row.id}>
      {#snippet children()}
        <StackedListItem
          actions={[{ label: 'Connect provider', href: '#provider' }]}
          lines
          phoneWidth="viewport"
        >
          {#snippet leading()}<span aria-hidden="true">!</span>{/snippet}
          {#snippet title()}Connect a provider before the next run{/snippet}
          {#snippet meta()}Scheduled runs cannot start until a provider is connected.{/snippet}
        </StackedListItem>
      {/snippet}
    </DataList>
  </div>
</div>

<!-- A 360px pane: the row's own width is a phone's, whatever the viewport is (COR-2448). -->
<div class="stacked-list-item-pane-fixture" data-testid="pane">
  <DataList items={paneRows} key={(row) => row.id}>
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
  .stacked-list-item-trailing-fixture {
    inline-size: 20rem;
  }

  .stacked-list-item-pane-fixture {
    inline-size: 360px;
  }
</style>
