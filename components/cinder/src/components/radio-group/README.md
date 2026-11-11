# RadioGroup

Coordinates a set of radio buttons under a single name with shared validation state.

## Usage

```svelte
<script lang="ts">
  import { RadioGroup } from '@lostgradient/cinder';
</script>

<RadioGroup name="disabled-region" label="Region (locked for trial accounts)" value="us" disabled>
  <RadioGroup.Option id="disabled-region-us" value="us" label="United States" />
  <RadioGroup.Option id="disabled-region-eu" value="eu" label="European Union" />
  <RadioGroup.Option id="disabled-region-ap" value="ap" label="Asia Pacific" />
</RadioGroup>
```

## Alignment with a wrapping label

Each option's circle sits beside the first line of its label, never the middle of a label that wraps: the row aligns its items to the start and offsets the circle so its centre meets the centre of that first line. A one-line label looks the same as it did centred, and an option with a `description` follows the same rule.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class names merged with `.cinder-radio-group`. |
| `description` | `string` | no | — | Helper text displayed below the group; wired via `aria-describedby` on the fieldset. |
| `disabled` | `boolean` | no | — | Disables the entire group. |
| `error` | `string` | no | — | Validation error message; sets `aria-invalid="true"` on the group's children. |
| `label` | `string` | no | — | Visible group caption. Rendered as a `<legend>` inside the `<fieldset>`. Named `label` for consistency with every other form control — the element is a `<legend>` because the group is a fieldset. |
| `name` | `string` | yes | — | Shared `name` for all radios in the group; required for native form submission. |
| `required` | `boolean` | no | — | When true, marks the group's radios as required for form submission. |
| `value` | `string` | no | — | Bound selected value. |
| `variant` | `"default"` \| `"card"` | no | — | Visual layout. 'card' wraps each radio row in a bordered surface. |
| `children` | `(opaque)` | yes | — | Radio children. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
