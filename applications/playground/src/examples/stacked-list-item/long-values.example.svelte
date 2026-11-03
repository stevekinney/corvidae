<script lang="ts" module>
  export const title = 'Long values';
  export const description =
    'A long title clamps at two lines and a long line two ends in an ellipsis on one line, each carrying its full text as a tooltip. The status column and the time never move.';
</script>

<script lang="ts">
  import { DataList, StackedListItem, StatusDot } from '@lostgradient/cinder';

  const name =
    'Release notes digest for the platform, mobile and documentation teams, posted to the shared channel and the on-call list';
  const detail =
    'Workflow · Release notes · Every Friday at 11:00 AM · From a workflow file · Last run Oct 30, failed · Notifies the platform, mobile and documentation channels';
</script>

<div style="max-width: 44rem;">
  <DataList items={['digest']} key={(id) => id} statusColumn>
    {#snippet children()}
      <StackedListItem href="#digest" tooltip={name} metaTooltip={detail}>
        {#snippet status()}<StatusDot word="Active" />{/snippet}
        {#snippet title()}{name}{/snippet}
        {#snippet time()}Next Fri Nov 6, 11:00 AM{/snippet}
        {#snippet meta()}{detail}{/snippet}
      </StackedListItem>
    {/snippet}
  </DataList>
</div>
