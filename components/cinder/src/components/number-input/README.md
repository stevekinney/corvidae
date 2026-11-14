# NumberInput

Numeric text input with increment and decrement stepper controls.

## Usage

```svelte
<script lang="ts">
  import { NumberInput } from '@lostgradient/cinder';

  let quantity = $state<number | null>(1);

  function handleChange(value: number | null) {
    quantity = value;
  }
</script>

<NumberInput
  id="quantity"
  label="Quantity"
  value={quantity}
  min={1}
  max={99}
  onValueChange={handleChange}
/>
<p style="margin-top: 0.5rem; color: var(--cinder-text-muted);">
  Value: {quantity ?? 'empty'}
</p>
```

By default the number is reported when the field is left, when Enter is pressed, or by a stepper. Set `commitWhileTyping` to report each number as it is typed, for a field whose value writes through at once; text that is not a number yet (a lone `-`) is held until the field is left, leaving the field reports nothing for a number (it was reported as it was typed, so a value shown rounded is not changed by a visit), and an emptied field reports `null` without marking a required field invalid while it has focus.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `adornment` | `string` | no | — | Optional non-interactive text rendered before the stepper controls. |
| `class` | `string` | no | — |  |
| `commitWhileTyping` | `boolean` | no | `false` | Reports each number as it is typed, not only when the field is left or Enter is pressed. Text that is not a number yet (such as `-`) is not reported and does not mark the field invalid until the field is left. Leaving the field reports nothing for a number, because it was reported as it was typed, so a value shown rounded is not changed by a visit. |
| `description` | `string` | no | — |  |
| `disabled` | `boolean` | no | — |  |
| `error` | `string` | no | — |  |
| `id` | `string` | yes | — |  |
| `label` | `string` | no | — |  |
| `locale` | `string` | no | — |  |
| `max` | `number` | no | — |  |
| `min` | `number` | no | — |  |
| `name` | `string` | no | — |  |
| `required` | `boolean` | no | — |  |
| `size` | `"sm"` \| `"md"` \| `"lg"` | no | `"md"` | Height step from the shared `--cinder-control-height-*` scale: `sm` 28px, `md` 32px, `lg` 40px, the same heights as an Input of that size. |
| `step` | `number` | no | — |  |
| `value` | `number` \| `null` | no | — |  |
| `format` | `(opaque)` | no | — | Locale-aware formatting options passed to `Intl.NumberFormat`. Not expressible in JSON Schema; see the component types for the signature. |
| `inputAttachment` | `(opaque)` | no | — | Attachment for native input access and lifecycle-scoped listeners. Not expressible in JSON Schema; see the component types for the signature. |
| `onValueChange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
