# ShortcutHint

Inline shortcut hint that renders a key combo via Kbd alongside an action label, with an accessible text representation not reliant on visual keycaps alone.

## Usage

```svelte
<script lang="ts">
  import { ShortcutHint } from '@lostgradient/cinder';
</script>

<div style="display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap;">
  <ShortcutHint keys={['Ctrl', 'S']}>Save</ShortcutHint>
  <ShortcutHint keys={['Ctrl', 'Z']}>Undo</ShortcutHint>
  <ShortcutHint keys={['Escape']}>Cancel</ShortcutHint>
  <ShortcutHint keys={['Space']} keysLabel="Space bar" keysPosition="before">Play</ShortcutHint>
</div>
```

## Guidance

### Use When

- Showing a keyboard shortcut inline beside a label in a toolbar button, menu item, or tooltip.
- Pairing with command-palette items to surface available shortcuts.

### Avoid When

- Displaying a full shortcut reference table — use keyboard-shortcuts instead.

## In a button

Prefer Button's `shortcut` prop to nesting a hint by hand. On a filled `primary` or `danger` button the key caps drop their raised fill and use the variant's contrast color with a translucent edge, and on `secondary` and `ghost` they use muted text, so the hint reads as part of the button on every variant and theme. Hand-written markup inside a button gets the same treatment.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class names merged with `.cinder-shortcut-hint`. |
| `keys` | `string`[] | yes | — | The key sequence to display. |
| `keysLabel` | `string` | no | — | Accessible label for the key combo. |
| `keysPosition` | `"before"` \| `"after"` | no | `"after"` | Position of keys relative to children. |
| `children` | `(opaque)` | no | — | The action label rendered beside the keys. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
