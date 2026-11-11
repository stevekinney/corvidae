<script lang="ts" module>
  export const title = 'Leading slots';
  export const description =
    'The leading slot holds an icon, an avatar, a 56px thumbnail or a control, each sized for its kind. A control aligns to the first line of a wrapping title.';
</script>

<script lang="ts">
  import { Avatar, Checkbox, GroupedList, GroupedListItem } from '@lostgradient/cinder';

  let done = $state(false);
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

<GroupedList header="Places">
  <GroupedListItem href="/places/rooftop" leadingKind="media">
    {#snippet leading()}<svg viewBox="0 0 56 56" aria-hidden="true">
        <rect width="56" height="56" fill="var(--cinder-accent-solid)" />
        <circle cx="28" cy="28" r="14" fill="var(--cinder-surface)" />
      </svg>{/snippet}
    {#snippet title()}Rooftop bar{/snippet}
    {#snippet subtitle()}Open until 2 AM{/snippet}
  </GroupedListItem>
  <GroupedListItem href="/places/patio" leadingKind="media">
    {#snippet leading()}<svg viewBox="0 0 56 56" aria-hidden="true">
        <rect width="56" height="56" fill="var(--cinder-accent-solid)" />
        <circle cx="28" cy="28" r="14" fill="var(--cinder-surface)" />
      </svg>{/snippet}
    {#snippet title()}Patio{/snippet}
    {#snippet subtitle()}Dogs welcome{/snippet}
  </GroupedListItem>
</GroupedList>

<GroupedList header="Tasks">
  <GroupedListItem leadingKind="control">
    {#snippet leading()}<Checkbox aria-label="Done" bind:checked={done} />{/snippet}
    {#snippet title()}Reconcile the quarterly statements with the bank export, then send the summary
      to finance{/snippet}
  </GroupedListItem>
  <GroupedListItem leadingKind="control">
    {#snippet leading()}<Checkbox aria-label="Done" />{/snippet}
    {#snippet title()}Call the plumber{/snippet}
  </GroupedListItem>
</GroupedList>
