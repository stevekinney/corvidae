<script lang="ts">
  import CommandItem from './command-item.svelte';
  import CommandPalette from '../command-palette/command-palette.svelte';

  let {
    tone,
    withMeta = false,
    escapeHint,
  }: { tone?: 'neutral' | 'warning'; withMeta?: boolean; escapeHint?: string | false } = $props();
</script>

<CommandPalette open sheetBelow={false} {...escapeHint === undefined ? {} : { escapeHint }}>
  {#snippet items()}
    <CommandItem value="waiting" leadingTone={tone} onSelect={() => {}}>
      Refund order 4471 for $42.00?
      {#snippet leading()}<svg data-glyph viewBox="0 0 24 24"></svg>{/snippet}
      {#snippet meta()}{#if withMeta}Approval · waiting{/if}{/snippet}
    </CommandItem>
  {/snippet}
</CommandPalette>
