<script lang="ts" module>
  export const title = 'Bottom sheet with detents';
  export const description =
    'A bottom sheet that rests at peek, medium or large. The grabber is the resize control, the peek bar shows a live count, and the footer holds the action.';
</script>

<script lang="ts">
  import { Button, Drawer, GroupedList, GroupedListItem } from '@lostgradient/cinder';
  import type { DrawerDetent } from '@lostgradient/cinder';

  let open = $state(false);
  let detent = $state<DrawerDetent>('medium');
  let triggerRef: HTMLElement | null = $state(null);

  const runs = Array.from({ length: 12 }, (_, index) => ({
    id: `run-${index + 1}`,
    name: `Nightly run ${index + 1}`,
  }));
</script>

<Button
  label="Open sheet"
  onclick={(event) => {
    triggerRef = event.currentTarget as HTMLElement;
    open = true;
  }}
/>

<Drawer
  bind:open
  bind:detent
  placement="bottom"
  title="Runs"
  detents={['peek', 'medium', 'large']}
  count="12 results"
  {triggerRef}
>
  <GroupedList header="Runs">
    {#each runs as run (run.id)}
      <GroupedListItem>
        {#snippet title()}{run.name}{/snippet}
        {#snippet subtitle()}Completed{/snippet}
      </GroupedListItem>
    {/each}
  </GroupedList>

  {#snippet footer()}
    <Button label="Show 12 results" onclick={() => (open = false)} />
  {/snippet}
</Drawer>
