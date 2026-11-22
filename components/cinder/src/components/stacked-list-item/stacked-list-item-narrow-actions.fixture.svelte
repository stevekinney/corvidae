<script lang="ts">
  import Hourglass from '@lucide/svelte/icons/hourglass';

  import { Badge } from '../badge/index.ts';
  import { DataList } from '../data-list/index.ts';
  import { StatusDot } from '../status-dot/index.ts';
  import { StackedListItem } from './index.ts';

  const rows = [{ id: 'row' }];
</script>

<!-- Rows 20rem wide, under the 448px container width. `actions` is a two-line row with a tile, a
     long title, a meta that wraps and one action (a Needs attention row), whose button takes a line
     of its own under the text. `badges` is a status-first row whose title is followed by three
     badges (a run in three states), which drop to a line under the title. -->
<div class="stacked-list-item-actions-fixture">
  <div data-testid="actions">
    <DataList items={rows} key={(row) => row.id}>
      {#snippet children()}
        <StackedListItem
          lines
          wrapMeta
          leadingTone="warning"
          actions={[{ label: 'View run', href: '#run' }]}
        >
          {#snippet leading()}<Hourglass aria-hidden="true" size={16} />{/snippet}
          {#snippet title()}Tool runner has cost $12.35, over the spend threshold{/snippet}
          {#snippet meta()}Found over the threshold at Nov 2, 10:46 AM. The run finished at Nov 2,
            10:47 AM.{/snippet}
        </StackedListItem>
      {/snippet}
    </DataList>
  </div>
  <div data-testid="actions-no-leading" hidden>
    <DataList items={rows} key={(row) => row.id}>
      {#snippet children()}
        <StackedListItem lines wrapMeta actions={[{ label: 'View run', href: '#run' }]}>
          {#snippet title()}Tool runner has cost $12.35, over the spend threshold{/snippet}
          {#snippet meta()}Found over the threshold at Nov 2, 10:46 AM. The run finished at Nov 2,
            10:47 AM.{/snippet}
        </StackedListItem>
      {/snippet}
    </DataList>
  </div>
  <div data-testid="badges">
    <DataList items={rows} key={(row) => row.id}>
      {#snippet children()}
        <StackedListItem>
          {#snippet status()}<StatusDot word="Running" />{/snippet}
          {#snippet title()}Look up order 4468{/snippet}
          {#snippet badge()}
            <Badge size="xs" variant="warning" data-badge>Stalled</Badge>
            <Badge size="xs" variant="warning" data-badge>Looping</Badge>
            <Badge size="xs" variant="danger" data-badge>Overspending</Badge>
          {/snippet}
          {#snippet time()}10:48 AM{/snippet}
          {#snippet meta()}Chat, Tool runner{/snippet}
        </StackedListItem>
      {/snippet}
    </DataList>
  </div>
</div>

<style>
  .stacked-list-item-actions-fixture {
    /* 20rem: ten 2rem steps of the space scale, so the fixture adds no literal length. */
    inline-size: calc(var(--cinder-space-8) * 10);
  }
</style>
