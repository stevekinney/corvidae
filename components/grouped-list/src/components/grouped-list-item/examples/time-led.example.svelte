<script lang="ts" module>
  export const title = 'Time-led rows';
  export const description =
    'The lead is the time window, with free text under it. Urgent colours only that line in the warning text colour, soon mutes the window, a row with no caption draws no empty line, and a stale row draws a gray clock and a short age. On a phone the trailing value sits on the name’s line and the subtitle takes the width under both.';
</script>

<script lang="ts">
  import { GroupedList, GroupedListItem } from '@lostgradient/grouped-list';
</script>

<GroupedList header="Open now">
  <GroupedListItem
    href="/places/rooftop"
    timeWindow="3–6 pm"
    timeCaption="12 min left"
    urgency="urgent"
  >
    {#snippet title()}The Rooftop{/snippet}
    {#snippet subtitle()}Half-price wells until 8:00 pm{/snippet}
    {#snippet trailing()}0.4 mi{/snippet}
  </GroupedListItem>
  <GroupedListItem
    href="/places/lantern"
    timeWindow="10 pm–1 am"
    timeCaption="starts in 1 h"
    urgency="soon"
  >
    {#snippet title()}Lantern Room, which has a much longer name that wraps onto a second line{/snippet}
    {#snippet subtitle()}Two-dollar drafts{/snippet}
    {#snippet trailing()}1.2 mi{/snippet}
  </GroupedListItem>
  <GroupedListItem href="/places/pier" timeWindow="All day" staleAge="3d">
    {#snippet title()}The Pier{/snippet}
    {#snippet subtitle()}Oysters and rosé{/snippet}
    {#snippet trailing()}2.8 mi{/snippet}
  </GroupedListItem>
</GroupedList>
