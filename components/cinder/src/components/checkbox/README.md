# Checkbox

Single boolean toggle for opt-in selections within forms or settings.

## Usage

```svelte
<script lang="ts">
  import { Checkbox } from '@lostgradient/cinder';
</script>

<Checkbox />
```

### Callback order

Three callbacks can observe a toggle, and they fire in this order with different values: `onchange` fires first, carrying the browser's raw, pre-veto `checked` value straight from the native change event; `onValueChangeRequest` runs next and can veto or rewrite the proposed value; `onValueChange` fires last with the committed value, after any veto has applied. A handler that reads `event.target.checked` inside `onchange` sees what the user actually clicked, not the post-veto result — use `onValueChange` when you need the value Cinder actually committed.

### Hit area

The box is drawn 18px, but the row around it is the hit area: at least 24px square, and at least 44px square under a coarse pointer (`any-pointer: coarse`), the targets of WCAG 2.5.8 and 2.5.5. The padding that makes it is taken back with negative margins, so the row takes exactly the box in layout and a list of checkboxes keeps its rhythm. A press on the padding is forwarded to the input, and the input stays the one keyboard and assistive-technology target.

### Alignment with the label

The box sits beside the first line of its label, never the middle of a label that wraps: the field aligns its items to the start and offsets the box so its centre meets the centre of that first line. A one-line label looks the same as it did centred. The label takes the rest of the line and wraps inside it, so a long label stays beside its box. A list row that leads with a checkbox follows the same rule: [`StackedListItem`](../stacked-list-item/README.md) aligns a leading checkbox to the first line of its title.

### Task variant

`variant="task"` draws the round 20px control of a task list. It shares the checked fill (the accent) and the check glyph with the square box, so the checked state is the same accent fill, which a test holds to 3:1 against the surface, and the unchecked ring keeps the control border tier, which the token contrast audit holds to 3:1. The hit area and the first-line alignment are the same as the square box's.

```svelte
<script lang="ts">
  import { Checkbox } from '@lostgradient/cinder';

  let done = $state(false);
</script>

<Checkbox variant="task" label="Send the quarterly report" bind:checked={done} />
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `checked` | `boolean` | no | — | Bound checked state. |
| `class` | `string` | no | — | Extra class names merged with `.cinder-checkbox`. |
| `description` | `string` | no | — | Helper text displayed below the checkbox; wired via `aria-describedby`. |
| `disabled` | `boolean` | no | — | Disables the checkbox. |
| `error` | `string` | no | — | Validation error message; sets `aria-invalid="true"` and `aria-describedby`. |
| `id` | `string` | no | — | Unique identifier for label association and ARIA wiring. Optional: when omitted, a stable id is generated via `$props.id()` (or inherited from a FormField context), matching Input/Autocomplete. Provide it when you need a known id to reference. |
| `indeterminate` | `boolean` | no | — | Bound indeterminate state. Mutually exclusive with `checked` visually. |
| `label` | `string` | no | — | Visible label rendered in a `<label>` element associated via `for`. |
| `mutating` | `boolean` | no | `false` | Marks a checkbox that changes something. Inside a stale `<StaleRegion>` it goes inert: `aria-disabled`, still focusable, a press is undone, and the region's reason describes it. It returns by itself when the region stops being stale. |
| `variant` | `"default"` \| `"task"` | no | `"default"` | Drawing of the control. `default` is the square 18px box; `task` is the round 20px control of a task list, with the same checked fill and check glyph. Either way the hit area is at least 24px, and at least 44px under a coarse pointer, without changing the drawn size. |
| `onValueChange` | `(opaque)` | no | — | Notify after the bindable value has been committed. Not expressible in JSON Schema; see the component types for the signature. |
| `onValueChangeRequest` | `(opaque)` | no | — | Intercept a proposed checked state before the bindable value is written. Return a replacement value to transform it. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
