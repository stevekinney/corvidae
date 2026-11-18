<script lang="ts" module>
  export const title = 'Rows on one rounded surface';
  export const description =
    'The header and footer sit outside the group, rows are linked as a whole, and separators start at the text.';
</script>

<script lang="ts">
  import { GroupedList, GroupedListItem } from '@lostgradient/cinder';
  import Wifi from '@lucide/svelte/icons/wifi';
</script>

<GroupedList header="Wi-Fi" footer="Known networks join automatically.">
  <GroupedListItem href="/settings/home" leadingKind="icon">
    {#snippet leading()}<Wifi size={20} />{/snippet}
    {#snippet title()}Home{/snippet}
    {#snippet subtitle()}Connected{/snippet}
    {#snippet trailing()}Strong{/snippet}
  </GroupedListItem>
  <GroupedListItem href="/settings/office" selected>
    {#snippet leading()}<Wifi size={20} />{/snippet}
    {#snippet title()}Office{/snippet}
    {#snippet subtitle()}Known network{/snippet}
  </GroupedListItem>
  <GroupedListItem>
    {#snippet leading()}<Wifi size={20} />{/snippet}
    {#snippet title()}Cafe{/snippet}
  </GroupedListItem>
</GroupedList>
