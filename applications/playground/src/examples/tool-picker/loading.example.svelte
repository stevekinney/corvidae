<script lang="ts" module>
  export const title = 'Loading';
  export const description =
    'While the list loads, the title and a live search field stay, and three skeleton rows appear after 300 ms so a quick load never flashes a placeholder. Done waits until the list is there.';
</script>

<script lang="ts">
  import { Button, ToolPicker } from '@lostgradient/cinder';

  let open = $state(false);
</script>

<Button variant="secondary" onclick={() => (open = true)}>Add tools and skills</Button>

<ToolPicker bind:open items={[]} loading />
