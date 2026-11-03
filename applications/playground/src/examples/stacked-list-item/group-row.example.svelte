<script lang="ts" module>
  export const title = 'Collapsed group row';
  export const description =
    'Pass details to make a group row, such as the missed runs under Today. It is not a link: Show and Hide reveal the details beneath the row, aligned with the title.';
</script>

<script lang="ts">
  import { DataList, StackedListItem, StatusDot } from '@lostgradient/cinder';

  let expanded = $state(false);
  const missed = [
    'Mon, Nov 2 · 3:00 AM',
    'Sun, Nov 1 · 3:00 AM',
    'Sat, Oct 31 · 4:00 AM',
    'Fri, Oct 30 · 4:00 AM',
  ];
</script>

<DataList items={['daily-summary']} key={(id) => id}>
  {#snippet children()}
    <StackedListItem bind:expanded>
      {#snippet status()}<StatusDot word="Missed runs · 4" />{/snippet}
      {#snippet title()}Daily summary missed 4 times since Oct 30{/snippet}
      {#snippet meta()}Schedule · Assistant · every day at 3:00 AM (9:00 AM UTC) · Interborough
        wasn’t running{/snippet}
      {#snippet details()}
        {#each missed as occurrence (occurrence)}
          <div>{occurrence}</div>
        {/each}
      {/snippet}
    </StackedListItem>
  {/snippet}
</DataList>
