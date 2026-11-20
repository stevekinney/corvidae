<script lang="ts">
  import { Link } from '../link/index.ts';
  import { DataList } from '../data-list/index.ts';
  import { StatusDot } from '../status-dot/index.ts';
  import { StackedListItem } from './index.ts';

  const rows = [{ id: 'daily-summary', title: 'Daily summary' }];
  const wide =
    'Schedule, Assistant, every day at 3:00 AM (9:00 AM UTC), missed 4 times since Oct 30';
</script>

<!-- The missed runs' group row as the Runs list draws it (rows 05w, 09q): on a phone line two is
     the compact "Schedule since Oct 30", led by the status, once; the time and the disclosure stay
     on line one. Wider, line two is the whole sentence and the status leads in its column. -->
<div data-testid="meta-compact">
  <DataList items={rows} key={(row) => row.id}>
    {#snippet children(row)}
      <StackedListItem tone="warning" wrapMeta tooltip={row.title} metaTooltip={wide}>
        {#snippet status()}<StatusDot word="Missed runs" qualifier={4} />{/snippet}
        {#snippet title()}{row.title}{/snippet}
        {#snippet time()}Oct 30{/snippet}
        {#snippet meta()}{wide}{/snippet}
        {#snippet metaCompact()}Schedule since Oct 30{/snippet}
        {#snippet details()}<Link href="#schedule">View schedule</Link>{/snippet}
      </StackedListItem>
    {/snippet}
  </DataList>
</div>

<!-- The same row in a column 38rem wide, following the window (`phoneWidth="viewport"`): narrower
     than 640px, it still leads with the status column on a tablet or desktop (row 05x). -->
<div class="stacked-list-item-meta-compact-fixture" data-testid="meta-compact-viewport">
  <DataList items={rows} key={(row) => row.id}>
    {#snippet children(row)}
      <StackedListItem
        tone="warning"
        wrapMeta
        phoneWidth="viewport"
        tooltip={row.title}
        metaTooltip={wide}
      >
        {#snippet status()}<StatusDot word="Missed runs" qualifier={4} />{/snippet}
        {#snippet title()}{row.title}{/snippet}
        {#snippet time()}Oct 30{/snippet}
        {#snippet meta()}Schedule, Assistant, missed 4 times since Oct 30{/snippet}
        {#snippet metaCompact()}Schedule since Oct 30{/snippet}
        {#snippet details()}<Link href="#schedule">View schedule</Link>{/snippet}
      </StackedListItem>
    {/snippet}
  </DataList>
</div>

<style>
  .stacked-list-item-meta-compact-fixture {
    inline-size: min(38rem, 100%);
    margin-block-start: var(--cinder-space-6);
  }
</style>
