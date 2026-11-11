<script lang="ts" module>
  export const title = 'A 380px list pane';
  export const description =
    'The phone layout keys on the viewport, not the container, so a 380px list pane on a desktop keeps its fixed status column; a long approval title clamps to two lines beside the status, with line two and the time keeping their place.';
</script>

<script lang="ts">
  import { DataList, StackedListItem, StatusDot } from '@lostgradient/cinder';

  const approval =
    'Refund order 4471 for $42.00 to the original card, plus the $6.00 return shipping the customer paid last week, for the Parcelly damaged-carrier claim?';
</script>

<div style="max-width: 380px;">
  <DataList items={['approval']} key={(id) => id} statusColumn>
    {#snippet children()}
      <StackedListItem href="#approval" tooltip={approval}>
        {#snippet status()}<StatusDot word="Waiting on you" />{/snippet}
        {#snippet title()}{approval}{/snippet}
        {#snippet time()}4 min{/snippet}
        {#snippet meta()}Approval, Tool runner{/snippet}
      </StackedListItem>
    {/snippet}
  </DataList>
</div>
