# CommandPalette

Modal search overlay for keyboard-first commands, destinations, and record jumpers.

CommandPalette intentionally uses a native modal `<dialog>` for top-layer, backdrop, focus-trap, and `aria-modal` semantics. See the [native dialog contract](https://github.com/stevekinney/cinder/blob/main/docs/decisions/command-palette-native-dialog.md). For a non-modal single-value picker, use [Combobox](../combobox/README.md).

## Bottom sheet, key hints and prefixes

- **Sheet**: below `sheetBelow` (default `640px`; `false` keeps the centred panel) the palette opens as a bottom sheet: docked to the bottom edge with a grabber, a bordered search field with a Close button (`closeLabel`), and 44px rows. It rides above the on-screen keyboard, clears the bottom safe area, and its list scrolls inside the sheet. Under reduced motion it cross-fades instead of sliding. At wider widths it is the centred panel.
- **Key hints**: give a `CommandItem` `keys={['G', 'H']}` and the row ends with "G then H", each key a `Kbd`; `keys={['C']}` shows the single key. The hint is text in the row, so it is part of the option's accessible name.
- **Prefixes**: filtering stays with the page, which receives the query in `items`. `parseCommandQuery(query, [{ prefix: '>', scope: 'actions' }, { prefix: '@', scope: 'agents' }])` reads a leading prefix off the query and returns `{ scope, term }`, so typing `>` narrows to actions and `@` to agents. Say so in the footer snippet: "> actions", "@ agents", "Enter to open".

## Usage

```svelte
<script lang="ts">
  import { Button } from '@lostgradient/cinder';
  import { CommandItem } from '@lostgradient/cinder';
  import { CommandPalette } from '@lostgradient/cinder';

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

<div style="display: flex; flex-direction: column; gap: 1rem; align-items: flex-start;">
  <Button
    label="Open palette"
    onclick={(event: MouseEvent) => {
      triggerRef = event.currentTarget as HTMLElement;
      open = true;
    }}
  />

  {#if lastSelected}
    <p style="font-size: 0.875rem; color: var(--cinder-text-muted);">
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
```

## Grouped Results

Command items register with the palette by DOM node, so grouped results can use valid nested list markup without changing keyboard navigation. Use a presentational outer list item, an inner `ul[role="group"]` with an accessible name, and `CommandItem` children inside that inner list.

```svelte
<CommandPalette bind:open label="Command palette">
  {#snippet items()}
    <li role="presentation" class="cinder-command-group">
      <span class="cinder-command-group__label">Recent files</span>
      <ul role="group" aria-label="Recent files">
        <CommandItem value="roadmap" onSelect={() => openRoadmap()}>Roadmap</CommandItem>
        <CommandItem value="settings" onSelect={() => openSettings()}>Settings</CommandItem>
      </ul>
    </li>
  {/snippet}
</CommandPalette>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Class merged onto the palette panel. |
| `closeLabel` | `string` | no | `"Close"` | Accessible name and visible text of the Close button the sheet form shows beside the search field. |
| `escapeHint` | `string` \| `false` | no | `"esc"` | The key hint at the end of the search field, drawn as a `Kbd` ("esc"), which says how to close the palette. `false` leaves it out. The bottom sheet shows a Close button instead and never the hint. |
| `label` | `string` | no | — | Accessible name for the dialog, wired via `aria-label`. |
| `open` | `boolean` | yes | — | Bindable open state. The component mutates `open = false` on Escape, backdrop click, or any explicit close path, then fires `onClose`. |
| `placeholder` | `string` | no | — | Placeholder rendered inside the search input. |
| `query` | `string` | no | — | Bindable search query. Mutated by the input's oninput handler. Exposed to the items snippet so consumers can filter. Reset to an empty string each time the palette opens. |
| `sheetBelow` | `string` \| `false` | no | `"640px"` | Viewport width below which the palette opens as a bottom sheet instead of a centred panel: it docks to the bottom edge with a grabber, a search field with a Close button, 44px rows, and a height capped so the list scrolls inside it. It rides above the on-screen keyboard and respects the bottom safe area. A CSS length such as `"640px"`, or `false` to keep the centred panel at every width. |
| `empty` | `(opaque)` | no | — | Rendered when zero items are registered after filtering. Not expressible in JSON Schema; see the component types for the signature. |
| `footer` | `(opaque)` | no | — | Optional footer, e.g. for keybinding hints. Not part of the listbox. Not expressible in JSON Schema; see the component types for the signature. |
| `items` | `(opaque)` | yes | — | Receives the current query so consumers can filter. Not expressible in JSON Schema; see the component types for the signature. |
| `onClose` | `(opaque)` | no | — | Fired after any close path routed through the palette close lifecycle. Not expressible in JSON Schema; see the component types for the signature. |
| `triggerRef` | `(opaque)` | no | — | Element to restore focus to on close. Falls back to `captureFocus()`. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
