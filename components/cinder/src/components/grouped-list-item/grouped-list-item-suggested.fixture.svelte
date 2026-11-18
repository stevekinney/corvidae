<script lang="ts">
  import { GroupedList } from '../grouped-list/index.ts';
  import { GroupedListItem } from './index.ts';
</script>

<div class="grouped-list-item-suggested-fixture">
  <GroupedList header="Next actions">
    <GroupedListItem suggested>
      {#snippet title()}Call the landlord{/snippet}
      {#snippet subtitle()}About the lease renewal{/snippet}
      {#snippet trailing()}Friday{/snippet}
    </GroupedListItem>
    <GroupedListItem>
      {#snippet title()}Call the landlord{/snippet}
      {#snippet subtitle()}About the lease renewal{/snippet}
      {#snippet trailing()}Friday{/snippet}
    </GroupedListItem>
  </GroupedList>
</div>

<style>
  .grouped-list-item-suggested-fixture {
    max-inline-size: 28rem;
  }
</style>
