<script lang="ts" module>
  export const title = 'Leading slots';
  export const description =
    'The leading slot holds an icon, an avatar, a 56px thumbnail or a control, each sized for its kind.';
</script>

<script lang="ts">
  import { Avatar, GroupedList, GroupedListItem } from '@lostgradient/cinder';
</script>

<GroupedList header="People">
  <GroupedListItem href="/people/ada">
    {#snippet leading()}<Avatar name="Ada Lovelace" />{/snippet}
    {#snippet title()}Ada Lovelace{/snippet}
    {#snippet subtitle()}Engineer{/snippet}
  </GroupedListItem>
  <GroupedListItem href="/people/grace">
    {#snippet leading()}<Avatar name="Grace Hopper" />{/snippet}
    {#snippet title()}Grace Hopper{/snippet}
    {#snippet subtitle()}Admiral{/snippet}
  </GroupedListItem>
</GroupedList>
