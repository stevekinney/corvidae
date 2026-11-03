<script lang="ts" module>
  export const title = 'Band group row';
  export const description =
    'groupLayout="band" draws a group row as one line: the status dot outside a tinted band holding a chevron, the bold title, muted text and the toggle label. The missed runs of one schedule use the warning tone.';
</script>

<script lang="ts">
  import { DataList, StackedListItem, StatusDot } from '@lostgradient/cinder';

  let expanded = $state(false);
  const missed = ['Mon Nov 2, 3:00 AM', 'Sun Nov 1, 3:00 AM', 'Sat Oct 31, 4:00 AM'];
</script>

<DataList items={['missed']} key={(id) => id}>
  {#snippet children()}
    <StackedListItem bind:expanded groupLayout="band" tone="warning" expandLabel="Show each">
      {#snippet status()}<StatusDot
          status="warning"
          label="Missed runs"
          labelVisible={false}
        />{/snippet}
      {#snippet title()}Missed 4 times since Oct 30{/snippet}
      {#snippet meta()}Interborough was off{/snippet}
      {#snippet details()}
        {#each missed as occurrence (occurrence)}
          <div>{occurrence}</div>
        {/each}
      {/snippet}
    </StackedListItem>
  {/snippet}
</DataList>
