<script lang="ts" module>
  export const title = 'Long values';
  export const description =
    'A long title clamps at two lines and a long line two ends in an ellipsis on one line, each carrying its full text as a tooltip. An unbroken identifier wraps anywhere instead of widening the page. The status column and the time never move.';
</script>

<script lang="ts">
  import { DataList, StackedListItem, StatusDot } from '@lostgradient/cinder';

  const name =
    'Release notes digest for the platform, mobile and documentation teams, posted to the shared channel and the on-call list';
  const identifier =
    'run-1-9f3a7c2e4b8d1a6f5e0c3b9d7a2f4e8c6b1d0a5f3e7c9b2d4a8f6e1c0b3d5a7f9e2c4b6';
  const detail =
    'Workflow · Release notes · Every Friday at 11:00 AM · From a workflow file · Last run Oct 30, failed · Notifies the platform, mobile and documentation channels';
</script>

<div style="max-width: 44rem;">
  <DataList items={['digest', 'identifier']} key={(id) => id} statusColumn>
    {#snippet children(id)}
      {#if id === 'digest'}
        <StackedListItem href="#digest" tooltip={name} metaTooltip={detail}>
          {#snippet status()}<StatusDot word="Active" />{/snippet}
          {#snippet title()}{name}{/snippet}
          {#snippet time()}Next Fri Nov 6, 11:00 AM{/snippet}
          {#snippet meta()}{detail}{/snippet}
        </StackedListItem>
      {:else}
        <StackedListItem href="#identifier" tooltip={identifier} metaTooltip={identifier}>
          {#snippet status()}<StatusDot word="Failed" />{/snippet}
          {#snippet title()}{identifier}{/snippet}
          {#snippet time()}10:12 AM{/snippet}
          {#snippet meta()}Run · {identifier}{/snippet}
        </StackedListItem>
      {/if}
    {/snippet}
  </DataList>
</div>
