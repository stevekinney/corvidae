<script lang="ts" module>
  export const title = 'A trailing photo';
  export const description =
    'A row with a trailing photo sits beside a row without one. The row without a photo reserves no space for it.';
</script>

<script lang="ts">
  import { GroupedList, GroupedListItem } from '@lostgradient/cinder';
</script>

<GroupedList header="Saved">
  <GroupedListItem href="/saved/1">
    {#snippet title()}Harbour walk{/snippet}
    {#snippet subtitle()}2.4 km{/snippet}
    {#snippet photo()}<svg viewBox="0 0 48 32" width="48" height="32" aria-hidden="true">
        <rect width="48" height="32" fill="var(--cinder-accent-solid)" />
        <circle cx="35" cy="11" r="5" fill="var(--cinder-surface)" />
      </svg>{/snippet}
  </GroupedListItem>
  <GroupedListItem href="/saved/2">
    {#snippet title()}City loop{/snippet}
    {#snippet subtitle()}5 km{/snippet}
  </GroupedListItem>
</GroupedList>
