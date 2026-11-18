# CommandItem

Individual selectable row within a command palette or dropdown command list.

`keys` shows a key sequence at the end of the row, read as "G then H" (each key in a `Kbd`); a single key shows alone. It is text in the row, so it joins the option's accessible name unless `accessibleLabel` is set. A sequence is not a chord, so it does not set `aria-keyshortcuts`; pass `keyboardShortcut` for a chord.

## Usage

```svelte
<script lang="ts">
  import { CommandItem } from '@lostgradient/cinder';
  import { CommandPalette } from '@lostgradient/cinder';

  let open = $state(true);
</script>

<CommandPalette bind:open label="Commands">
  {#snippet items()}
    <CommandItem value="new-file" onSelect={() => {}}>New file</CommandItem>
  {/snippet}
</CommandPalette>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `accessibleLabel` | `string` | no | — | Accessible name for the option when the rendered row contains secondary text or rich content. |
| `class` | `string` | no | — | Class merged with `.cinder-command-item`. |
| `description` | `string` | no | — | Optional secondary text shown below the main label. |
| `disabled` | `boolean` | no | — | When true, the item is skipped by arrow keys and cannot be activated. |
| `keyboardShortcut` | `string` | no | — | Keyboard shortcut exposed through `aria-keyshortcuts`, e.g. `Meta+N`. |
| `keys` | `string`[] | no | — | A key sequence shown at the end of the row, read as "G then H": each key in a `Kbd`, with "then" between them. One key shows alone ("C"). It is text in the row, so it joins the option's accessible name unless `accessibleLabel` is set; it does not set `aria-keyshortcuts`, which describes a chord, not a sequence. Pass `keyboardShortcut` as well for a chord. |
| `leadingTone` | `"neutral"` \| `"warning"` | no | `"neutral"` | How the leading content is drawn. `neutral` is a bare glyph in muted ink; `warning` is the glyph on a small amber tile, for a row that is waiting on the person. |
| `selectionMode` | `"item"` \| `"parent"` | no | — | `selectionMode` is a compile-time discriminant that only controls whether `onSelect` is required; it has no runtime effect on activation dispatch. `'item'` is the default CommandPalette mode, in which this component's own `onSelect` is required. |
| `value` | `string` | yes | — | Submitted value; surfaced through the registration record. |
| `children` | `(opaque)` | yes | — | Main label content. Not expressible in JSON Schema; see the component types for the signature. |
| `leading` | `(opaque)` | no | — | Leading content (icon, avatar). Rendered with aria-hidden. Not expressible in JSON Schema; see the component types for the signature. |
| `meta` | `(opaque)` | no | — | Secondary text on the label's own line, after it and muted ("Refund order 4471 for $42.00?" with the meta "Approval, waiting"). The label and the meta truncate together as one line. Rendered with aria-hidden, so name the row with `accessibleLabel` when the meta carries meaning. Not expressible in JSON Schema; see the component types for the signature. |
| `onSelect` | `(opaque)` | no | — | Invoked when the item is activated inside CommandPalette. Not expressible in JSON Schema; see the component types for the signature. |
| `trailing` | `(opaque)` | no | — | Trailing content (kbd hint, badge). Rendered with aria-hidden. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

`CommandItemProps` is a discriminated union that the table above flattens to one row. With the default `selectionMode: 'item'`, `onSelect` is required. With `selectionMode: 'parent'` — the mode `CommandMenu` uses — `onSelect` is optional and activation is owned by the parent list.

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
