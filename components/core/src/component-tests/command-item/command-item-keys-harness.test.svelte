<script lang="ts">
  import CommandItem from '@lostgradient/command-menu/components/command-item/command-item.svelte';
  import CommandPalette from '@lostgradient/command-palette/components/command-palette/command-palette.svelte';

  let { keys }: { keys?: readonly string[] } = $props();
</script>

<CommandPalette open sheetBelow={false}>
  {#snippet items()}
    <CommandItem value="home" {keys} onSelect={() => {}}>Go to Home</CommandItem>
  {/snippet}
</CommandPalette>
