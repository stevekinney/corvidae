<script lang="ts" module>
  export const title = 'Time-led rows';
  export const description =
    'A fixed 72px lead holds a number and a unit from a closed vocabulary. Urgent uses the warning text colour, soon is muted, and a stale row draws a gray clock and a short age.';
</script>

<script lang="ts">
  import { GroupedList, GroupedListItem } from '@lostgradient/cinder';
</script>

<GroupedList header="Open now">
  <GroupedListItem href="/places/rooftop" leadValue={45} leadUnit="min left" urgency="urgent">
    {#snippet title()}The Rooftop{/snippet}
    {#snippet subtitle()}Half-price wells until 8:00 pm{/snippet}
    {#snippet trailing()}0.4 mi{/snippet}
  </GroupedListItem>
  <GroupedListItem href="/places/lantern" leadValue="4:30" leadUnit="starts" urgency="soon">
    {#snippet title()}Lantern Room, which has a much longer name that wraps onto a second line{/snippet}
    {#snippet subtitle()}Two-dollar drafts{/snippet}
    {#snippet trailing()}1.2 mi{/snippet}
  </GroupedListItem>
  <GroupedListItem href="/places/pier" leadValue="Fri" staleAge="3d">
    {#snippet title()}The Pier{/snippet}
    {#snippet subtitle()}Oysters and rosé{/snippet}
    {#snippet trailing()}2.8 mi{/snippet}
  </GroupedListItem>
</GroupedList>
