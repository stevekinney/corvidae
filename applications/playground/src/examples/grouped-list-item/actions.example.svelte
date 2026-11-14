<script lang="ts" module>
  export const title = 'Text actions';
  export const description =
    'Rows whose button is their point end in secondary small buttons. On a phone the buttons stack full width under the text instead of folding into a menu, and a status leads the subtitle as a dot and its word.';
</script>

<script lang="ts">
  import { GroupedList, GroupedListItem, StatusDot } from '@lostgradient/cinder';
</script>

<GroupedList aria-label="Waiting on you">
  <GroupedListItem actions={[{ label: 'Answer', href: '/reviews/1', changes: true }]}>
    {#snippet title()}Which environment should the release go to?{/snippet}
    {#snippet subtitle()}Question, Request human input, waiting 3 h{/snippet}
  </GroupedListItem>
  <GroupedListItem actions={[{ label: 'View run', href: '/runs/7' }]}>
    {#snippet title()}Nightly backup{/snippet}
    {#snippet subtitle()}<StatusDot word="Running" />, Schedule, started 10:42 AM{/snippet}
  </GroupedListItem>
</GroupedList>
