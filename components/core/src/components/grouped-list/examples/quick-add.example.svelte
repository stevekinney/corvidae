<script lang="ts" module>
  export const title = 'A quick-add first row';
  export const description =
    'A leading accent plus and a borderless input. Return submits the text to onItemAdd and clears the input.';
</script>

<script lang="ts">
  import { GroupedList, GroupedListItem } from '@lostgradient/cinder';

  let tasks = $state(['Buy oat milk', 'Call the plumber']);
</script>

<GroupedList
  header="Today"
  onItemAdd={(value) => (tasks = [value, ...tasks])}
  addLabel="Add a task"
>
  {#each tasks as task (task)}
    <GroupedListItem>
      {#snippet title()}{task}{/snippet}
    </GroupedListItem>
  {/each}
</GroupedList>
