<script lang="ts" module>
  export const title = 'A lead column and a fixed action column';
  export const description =
    'The lead column and the action column have fixed widths, so a longer value in one row never moves another row or a click target.';
</script>

<script lang="ts">
  import { Button, GroupedList, GroupedListItem } from '@lostgradient/cinder';
</script>

<GroupedList header="Runs">
  <GroupedListItem href="/runs/1">
    {#snippet lead()}45 min left{/snippet}
    {#snippet title()}Nightly backup{/snippet}
    {#snippet subtitle()}Running{/snippet}
    {#snippet action()}<Button size="sm" variant="ghost" aria-label="Pause">Pause</Button>{/snippet}
  </GroupedListItem>
  <GroupedListItem href="/runs/2">
    {#snippet lead()}9:30{/snippet}
    {#snippet title()}Index rebuild, which has a much longer name that wraps onto a second line{/snippet}
    {#snippet subtitle()}Scheduled{/snippet}
    {#snippet action()}<Button size="sm" variant="ghost" aria-label="Run now">Run</Button>{/snippet}
  </GroupedListItem>
</GroupedList>
