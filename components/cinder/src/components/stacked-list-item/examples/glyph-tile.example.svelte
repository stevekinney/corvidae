<script lang="ts" module>
  export const title = 'Glyph tile with actions';
  export const description =
    'leadingTone draws the leading glyph as a tinted tile; lines takes the two-line layout for a row with no status or time, and actions are secondary buttons.';
</script>

<script lang="ts">
  import { DataList, StackedListItem } from '@lostgradient/cinder';
  import CalendarX2 from '@lucide/svelte/icons/calendar-x-2';
</script>

<DataList items={['schedule']} key={(id) => id}>
  {#snippet children()}
    <StackedListItem
      lines
      leadingTone="warning"
      actions={[{ label: 'View schedule', href: '#daily-summary' }]}
    >
      {#snippet leading()}<CalendarX2 size={16} aria-hidden="true" />{/snippet}
      {#snippet title()}Daily summary missed 4 runs since Oct 30{/snippet}
      {#snippet description()}Interborough was off when it was due on Oct 30, Oct 31, Nov 1 and Nov
        2.{/snippet}
    </StackedListItem>
  {/snippet}
</DataList>
