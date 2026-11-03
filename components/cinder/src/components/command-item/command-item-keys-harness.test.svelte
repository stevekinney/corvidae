<script lang="ts">
  import CommandItem from './command-item.svelte';
  import CommandPalette from '../command-palette/command-palette.svelte';

  let { keys }: { keys?: readonly string[] } = $props();
</script>

<CommandPalette open sheetBelow={false}>
  {#snippet items()}
    <CommandItem value="home" {keys} onSelect={() => {}}>Go to Home</CommandItem>
  {/snippet}
</CommandPalette>
