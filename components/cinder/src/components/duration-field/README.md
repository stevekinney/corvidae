# DurationField

<!-- generated:a11y-record:required -->

`DurationField` is a number and the unit it is counted in, for a duration the data stores in milliseconds. The person types 30 and picks seconds; the value the page receives is one number, 30000. The unit starts as the largest that shows the stored value as a whole number (90000 reads as 90 seconds, 3600000 as 1 hour) and then follows the person's choice. A value replaced from outside, such as Edit as JSON in [`SchemaForm`](../schema-form/README.md), picks the unit again.

Set `unitSelectable` to `false` for a setting that always counts in one unit: the unit becomes text inside the number's own frame ("15 seconds") and there is no select. Inside a [`FormField`](../form-field/README.md) or [`SettingRow`](../setting-row/README.md) leave out `label`, which the row supplies.

By default the number reports when the field is left or Enter is pressed. Set `commitWhileTyping` for a field whose value writes through at once, such as a builder that shows what the page will say as you type: each number is then reported as it is typed, and an emptied field reports `null`. Text that is not a number yet (a lone `-`) is held until the field is left. Choosing another unit reports nothing, because the stored value does not change; the number is shown in the new unit, and the next number typed is counted in it. Pass `units` to offer other units than milliseconds to hours, such as days, and `size` to match the controls around the field.

`SchemaForm` renders a numeric property with this field when its schema says it is a duration: `format: "duration-ms"`, `unit: "milliseconds"`, or a name ending in `Ms`, `_ms` or `Milliseconds`. To show a duration read-only, format it with the `formatDuration` utility instead.

## Usage

```svelte
<script lang="ts">
  import { DurationField } from '@lostgradient/cinder';

  let timeout = $state<number | null>(90_000);
</script>

<DurationField id="timeout" label="Timeout" bind:value={timeout} />
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class merged with `.cinder-duration-field`. |
| `commitWhileTyping` | `boolean` | no | `false` | Reports each duration as the number is typed, not only when the field is left or Enter is pressed, for a field whose value writes through at once (a builder that shows its result as you type). Text that is not a number yet (such as `-`) is not reported. Changing the unit reports nothing: the stored value stays the same, and the number is shown in the new unit. |
| `description` | `string` | no | — | Helper text announced with the field. |
| `disabled` | `boolean` | no | — | Disables the number and the unit. |
| `error` | `string` | no | — | Validation error; marks the field invalid. |
| `id` | `string` | yes | — | Unique identifier for the number input. The unit select takes `${id}-unit`. |
| `integer` | `boolean` | no | `false` | Rounds the stored milliseconds to whole numbers, for a schema of type `integer`. |
| `label` | `string` | no | — | Visible label. Omit inside a FormField or SettingRow, which supplies the label. |
| `name` | `string` | no | — | Form field name for the number as typed (in the shown unit). |
| `required` | `boolean` | no | — | Marks the field required. |
| `size` | `"sm"` \| `"md"` \| `"lg"` | no | `"md"` | Height step from the shared `--cinder-control-height-*` scale, for the number and the unit: `sm` 28px, `md` 32px, `lg` 40px. |
| `unit` | `string` | no | — | The unit the number is shown in, by its `value`. Starts as the largest unit that shows the value as a whole number, and follows the person's choice. Bindable. |
| `unitSelectable` | `boolean` | no | `true` | Whether the person can change the unit. When `false` the unit is fixed text inside the field's frame ("30 seconds"), as a setting that always counts in seconds draws it. |
| `value` | `number` \| `null` | no | — | The duration in milliseconds, or `null` when the field is empty. Bindable. |
| `onblur` | `(opaque)` | no | — | Called when the number loses focus. Not expressible in JSON Schema; see the component types for the signature. |
| `onValueChange` | `(opaque)` | no | — | Called with the next duration in milliseconds, or `null` when the number is cleared or unparseable. Not expressible in JSON Schema; see the component types for the signature. |
| `units` | `(opaque)` | no | — | The units on offer, smallest first. The default is milliseconds, seconds, minutes and hours. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## Authoring checklist

<!-- generated:authoring:start -->

Before publishing this component, complete the live [component authoring pre-flight](../../../README.md#component-authoring-checklist).
<!-- generated:authoring:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
