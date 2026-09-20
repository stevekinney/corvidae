# ShortcutField

An accessible read-only keyboard shortcut recorder. Focus the field, press a combination, or press Escape to cancel capture.

## Usage

```svelte
<script lang="ts">
  import { ShortcutField } from '@corvidae/cinder';
</script>

<ShortcutField label="Open command palette" value={['Meta', 'K']} />
```

`value` is an ordered list of platform key names. The field enters capture mode when focused, calls `onValueChange` with the recorded combination, and uses Escape to cancel capture. Supply `validate` to return an error message for a combination the application cannot accept; keep the previous value until a valid replacement is committed. Set `disabled` when the shortcut is unavailable rather than hiding the field.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class merged with the component's root class. |
| `disabled` | `boolean` | no | — | Set when the shortcut is unavailable. |
| `label` | `string` | no | — | Accessible label for the shortcut field. |
| `value` | `string`[] | no | — | Ordered list of platform key names for the recorded combination. |
| `onValueChange` | `(opaque)` | no | — | Called with the recorded combination when capture completes. Not expressible in JSON Schema; see the component types for the signature. |
| `validate` | `(opaque)` | no | — | Returns an error message for a combination the application cannot accept; the field keeps the previous value until a valid replacement is committed. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->
