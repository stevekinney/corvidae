# Label

Accessible form label that associates descriptive text with its input element.

## Usage

```svelte
<script lang="ts">
  import { Label } from '@lostgradient/cinder';
</script>

<Label for="my-input" optional>Email address</Label>
```

Use either `optional` or `required`, never both. When both are supplied, Cinder renders the required marker.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class names merged with `.cinder-label`. |
| `disabled` | `boolean` | no | — | When true, render the label in the disabled color treatment. |
| `for` | `string` | yes | — | The id of the form control this label labels. Sets `for` on the rendered `<label>`. |
| `optional` | `boolean` | no | — | When true, append "Optional" to the label. Do not combine with `required`; required wins. |
| `required` | `boolean` | no | — | When true, append a visual indicator that the field is required. |
| `children` | `(opaque)` | yes | — | The label text or composed content. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
