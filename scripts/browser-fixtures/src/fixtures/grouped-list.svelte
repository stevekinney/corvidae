<script lang="ts">
  import { Button, GroupedList, GroupedListItem, StatusDot } from '@lostgradient/cinder';
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

  <!-- Text actions (COR-2329): trailing buttons, full width under the text on a phone. -->
  <GroupedList aria-label="Waiting on you" data-testid="grouped-list-actions">
    <GroupedListItem actions={[{ label: 'Answer', href: '/reviews/1', changes: true }]}>
      {#snippet title()}Which environment should the release go to?{/snippet}
      {#snippet subtitle()}Question, Request human input, waiting 3 h{/snippet}
    </GroupedListItem>
    <GroupedListItem actions={[{ label: 'View run', href: '/runs/7' }]}>
      {#snippet title()}Nightly backup{/snippet}
      {#snippet subtitle()}<StatusDot word="Running" />, Schedule, started 10:42 AM{/snippet}
    </GroupedListItem>
  </GroupedList>
</div>
