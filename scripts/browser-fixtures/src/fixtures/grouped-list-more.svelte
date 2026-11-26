<script lang="ts">
  import { GroupedList, GroupedListItem } from '@lostgradient/cinder';
</script>

<!-- COR-2765: a group that shows part of its set ends in a `more` link, 8px under the group (or
     under its footer), on the group's edge like the header and footer (COR-2768). -->
<div class="example-frame">
  <div data-testid="more-only">
    <GroupedList
      header="Recent events"
      more={{ label: 'View the whole History', href: '/history' }}
    >
      <GroupedListItem href="/events/1">
        {#snippet title()}Workflow started{/snippet}
        {#snippet subtitle()}09:30:12{/snippet}
      </GroupedListItem>
      <GroupedListItem href="/events/2">
        {#snippet title()}Activity scheduled{/snippet}
        {#snippet subtitle()}09:30:13{/snippet}
      </GroupedListItem>
      <GroupedListItem href="/events/3">
        {#snippet title()}Activity completed{/snippet}
        {#snippet subtitle()}09:30:20{/snippet}
      </GroupedListItem>
    </GroupedList>
  </div>

  <div data-testid="footer-and-more">
    <GroupedList
      header="Recent events"
      footer="Showing the latest 3 of 128 events."
      more={{ label: 'View the whole History', href: '/history' }}
    >
      <GroupedListItem href="/events/1">
        {#snippet title()}Workflow started{/snippet}
        {#snippet subtitle()}09:30:12{/snippet}
      </GroupedListItem>
      <GroupedListItem href="/events/2">
        {#snippet title()}Activity scheduled{/snippet}
        {#snippet subtitle()}09:30:13{/snippet}
      </GroupedListItem>
      <GroupedListItem href="/events/3">
        {#snippet title()}Activity completed{/snippet}
        {#snippet subtitle()}09:30:20{/snippet}
      </GroupedListItem>
    </GroupedList>
  </div>
</div>

<style>
  .example-frame {
    display: grid;
    gap: var(--cinder-space-6);
  }
</style>
