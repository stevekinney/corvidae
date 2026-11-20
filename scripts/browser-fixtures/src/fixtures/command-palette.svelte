<script lang="ts">
  import { Button, CommandItem, CommandPalette } from '@lostgradient/cinder';

  let open = $state(false);
  let triggerRef: HTMLElement | null = $state(null);
  let lastSelected = $state('');

  const commands = [
    { value: 'new-file', label: 'New file' },
    { value: 'open-settings', label: 'Open settings' },
    { value: 'sign-out', label: 'Sign out' },
  ];

  function select(label: string) {
    lastSelected = label;
    open = false;
  }
</script>

<div class="example-layout gap-4">
  <Button
    label="Open palette"
    onclick={(event) => {
      triggerRef = event.currentTarget as HTMLElement;
      open = true;
    }}
  />

  {#if lastSelected}
    <p class="note text-muted">
      Selected: <strong>{lastSelected}</strong>
    </p>
  {/if}
</div>

<CommandPalette bind:open label="Basic palette" {triggerRef}>
  {#snippet items({ query })}
    {@const filteredCommands = commands.filter((command) =>
      command.label.toLowerCase().includes(query.toLowerCase()),
    )}
    {#each filteredCommands as command (command.value)}
      <CommandItem
        value={command.value}
        accessibleLabel={command.label}
        onSelect={() => select(command.label)}
      >
        {command.label}
      </CommandItem>
    {/each}
  {/snippet}

  {#snippet empty()}
    No commands found.
  {/snippet}
</CommandPalette>

<style>
  .example-layout {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
  }

  .note {
    font-size: var(--cinder-text-base);
  }
</style>
