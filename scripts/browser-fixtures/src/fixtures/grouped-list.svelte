<script lang="ts">
  import { Button, GroupedList, GroupedListItem } from '@lostgradient/cinder';
</script>

<div style="max-inline-size: 28rem;">
  <GroupedList header="Runs" footer="Runs older than a week are archived.">
    <GroupedListItem href="/runs/1">
      {#snippet lead()}45 min left{/snippet}
      {#snippet title()}Nightly backup{/snippet}
      {#snippet subtitle()}Running{/snippet}
      {#snippet action()}<Button size="sm" variant="ghost" aria-label="Pause">Pause</Button
        >{/snippet}
    </GroupedListItem>
    <GroupedListItem href="/runs/2">
      {#snippet lead()}9:30{/snippet}
      {#snippet title()}Index rebuild{/snippet}
      {#snippet subtitle()}Scheduled{/snippet}
      {#snippet trailing()}A longer trailing value{/snippet}
      {#snippet action()}<Button size="sm" variant="ghost" aria-label="Run now">Run</Button
        >{/snippet}
    </GroupedListItem>
  </GroupedList>
</div>
