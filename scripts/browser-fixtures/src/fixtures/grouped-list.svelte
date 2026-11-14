<script lang="ts">
  import {
    Button,
    EmptyState,
    ErrorState,
    GroupedList,
    GroupedListItem,
    StatusDot,
  } from '@lostgradient/cinder';
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

  <!-- Trailing values (COR-2329): one line, on the title's line, the subtitle under both on a phone. -->
  <GroupedList aria-label="Recent chats" data-testid="grouped-list-trailing">
    <GroupedListItem href="/chats/1">
      {#snippet title()}Please refund order 4471, it arrived damaged.{/snippet}
      {#snippet subtitle()}<StatusDot word="Waiting on you" />, I found order 4471 ($42.00). I need
        your approval to refund it.{/snippet}
      {#snippet trailing()}10:42 AM{/snippet}
    </GroupedListItem>
    <GroupedListItem href="/chats/2">
      {#snippet title()}Say hello{/snippet}
      {#snippet subtitle()}<StatusDot word="Done" />, Hello! How can I help?{/snippet}
      {#snippet trailing()}Yesterday, 4:12 PM{/snippet}
    </GroupedListItem>
  </GroupedList>

  <!-- A list's empty and failed rows (COR-2329): their actions end on the list buttons' edge. -->
  <div data-testid="grouped-list-empty-row">
    <EmptyState kind="done" layout="row" title="Nothing needs attention">
      {#snippet action()}<Button variant="secondary" size="sm" label="Open Health" />{/snippet}
    </EmptyState>
  </div>
  <div data-testid="grouped-list-error-row">
    <ErrorState
      variant="row"
      headingLevel={3}
      title="Couldn’t load system problems."
      description="The rest of Home is live."
      onRetry={() => {}}
    />
  </div>
</div>
