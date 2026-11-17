# SearchField

Dedicated text input with a clear button and search icon for filtering or querying.

## Usage

```svelte
<script lang="ts">
  import { SearchField } from '@lostgradient/cinder';
</script>

<SearchField />
```

## Filled appearance

`appearance` is forwarded to the inner Input: `"filled"` draws the inset fill inside the 1px `--cinder-control-border` edge, and a field with no `appearance` is filled under `data-density="comfortable"` and outlined otherwise.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `appearance` | `"outlined"` \| `"filled"` | no | — | How the field is drawn, forwarded to the inner Input. `"outlined"` is the control fill inside a 1px edge. `"filled"` is an inset fill inside the same 1px `--cinder-control-border` edge, which keeps the 3:1 boundary the fill alone would lose. Left unset, the field follows its density: `filled` under `data-density="comfortable"`, `outlined` otherwise. |
| `class` | `string` | no | — | Additional class merged with `.cinder-search-field`. |
| `disabled` | `boolean` | no | — | Disables the input and the clear button. |
| `id` | `string` | no | — | Stable id for the input element. Required when composing with `FormField`. |
| `name` | `string` | no | — | `name` attribute for form submission. |
| `placeholder` | `string` | no | — | Placeholder text. |
| `readonly` | `boolean` | no | — | Marks the input as read-only; the clear button becomes inert. |
| `shortcut` | `string` | no | — | Optional keyboard shortcut hint (e.g. `'⌘K'`). Rendered as a trailing `<kbd aria-hidden="true">` badge. The shortcut itself is not wired by this component. |
| `size` | `"sm"` \| `"md"` \| `"lg"` | no | `"md"` | Height step from the shared `--cinder-control-height-*` scale, forwarded to the inner Input: `sm` 28px, `md` 32px, `lg` 40px. |
| `value` | `string` | no | — | Bindable search value. |
| `onClear` | `(opaque)` | no | — | Fires when the clear button is clicked. Not expressible in JSON Schema; see the component types for the signature. |
| `onSearch` | `(opaque)` | no | — | Fires when the native `search` event triggers (Enter or programmatic dispatch). Not expressible in JSON Schema; see the component types for the signature. |
| `onValueChange` | `(opaque)` | no | — | Fires on every keystroke with the current value. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
