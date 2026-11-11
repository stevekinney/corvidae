<script lang="ts" module>
  export const title = 'A lead column and a fixed action column';
  export const description =
    'A time or number in the lead column lines up from row to row. A status is a 6px dot plus a word in the subtitle. The action column is 44px wide and holds an icon-only button, so a changing value never moves the click target.';
</script>

<script lang="ts">
  import { Button, GroupedList, GroupedListItem, StatusDot } from '@lostgradient/cinder';
  import Pause from '@lucide/svelte/icons/pause';
  import Play from '@lucide/svelte/icons/play';
</script>

<GroupedList header="Runs">
  <GroupedListItem href="/runs/1">
    {#snippet lead()}45 min left{/snippet}
    {#snippet title()}Nightly backup{/snippet}
    {#snippet subtitle()}<StatusDot status="info" word="Running" size="xs" />{/snippet}
    {#snippet action()}<Button iconOnly={true} size="sm" variant="ghost" label="Pause"
        ><Pause size={16} /></Button
      >{/snippet}
  </GroupedListItem>
  <GroupedListItem href="/runs/2">
    {#snippet lead()}9:30{/snippet}
    {#snippet title()}Index rebuild, which has a much longer name that wraps onto a second line{/snippet}
    {#snippet subtitle()}<StatusDot status="neutral" word="Scheduled" size="xs" />{/snippet}
    {#snippet action()}<Button iconOnly={true} size="sm" variant="ghost" label="Run now"
        ><Play size={16} /></Button
      >{/snippet}
  </GroupedListItem>
</GroupedList>
