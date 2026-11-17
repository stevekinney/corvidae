<script lang="ts" module>
  export const title = 'Key hints and prefixes';
  export const description =
    'Navigation rows end with a key sequence read as "G then H"; a single key shows alone. Typing > narrows the list to actions and @ to agents. Below 640px the palette opens as a bottom sheet.';
</script>

<script lang="ts">
  import { Button, CommandItem, CommandPalette, parseCommandQuery } from '@lostgradient/cinder';

  let open = $state(false);
  let triggerRef: HTMLElement | null = $state(null);

  const scopes = [
    { prefix: '>', scope: 'actions' },
    { prefix: '@', scope: 'agents' },
  ] as const;

  const rows = [
    { value: 'home', label: 'Go to Home', keys: ['G', 'H'], scope: 'actions' },
    { value: 'chat', label: 'Go to Chat', keys: ['G', 'C'], scope: 'actions' },
    { value: 'new-chat', label: 'New chat', keys: ['C'], scope: 'actions' },
    { value: 'assistant', label: 'Assistant', keys: undefined, scope: 'agents' },
  ] as const;
</script>

<Button
  label="Search everything"
  onclick={(event) => {
    triggerRef = event.currentTarget as HTMLElement;
    open = true;
  }}
/>

<CommandPalette bind:open label="Search everything" placeholder="Search everything" {triggerRef}>
  {#snippet items({ query })}
    {@const parsed = parseCommandQuery(query, scopes)}
    {#each rows.filter((row) => (parsed.scope === undefined || row.scope === parsed.scope) && row.label
          .toLowerCase()
          .includes(parsed.term.toLowerCase())) as row (row.value)}
      <CommandItem value={row.value} keys={row.keys} onSelect={() => (open = false)}>
        {row.label}
      </CommandItem>
    {/each}
  {/snippet}

  {#snippet empty()}
    Nothing matches.
  {/snippet}

  {#snippet footer()}
    <span>&gt; actions</span>
    <span>@ agents</span>
    <span>Enter to open</span>
  {/snippet}
</CommandPalette>
