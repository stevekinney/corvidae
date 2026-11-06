# FormField

Wraps an input, label, and helper or error text into a cohesive accessible field unit.

## Usage

```svelte
<script lang="ts">
  import { FormField } from '@lostgradient/cinder';
  import { Input } from '@lostgradient/cinder';

  let name = $state('');
</script>

<FormField id="full-name" label="Full name">
  <Input id="full-name" bind:value={name} placeholder="Jane Smith" />
</FormField>
```

## Errors, notes and trailing content

An `error` leads with a warning glyph (a triangle) and sits under the control in a polite live region; `errorGlyph="error"` draws a circle instead, for a conflict such as a URL that is already connected. `errorAction` renders after the message in the same region, for a link ("Open GitHub") or a quiet Retry. `trailing` shares the control's row, so a Try again button sits beside a field whose test failed. `note` is neutral text under the helper text, wired into `aria-describedby`, for why a field is cleared. `managed` leads with a lock glyph, and `managed.message` replaces the "Managed by" wording with a whole sentence. A label that wraps keeps its lines apart.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class merged with `.cinder-form-field`. |
| `description` | `string` | no | — | Helper text rendered below the control; wired into `aria-describedby`. |
| `disabled` | `boolean` | no | — | Propagated to opted-in controls via context. Does not style FormField itself. |
| `error` | `string` | no | — | Validation error; sets `aria-invalid="true"` on opted-in controls via context. |
| `errorGlyph` | `"warning"` \| `"error"` | no | `"warning"` | The glyph drawn before the error message: `warning` (a triangle, the default) for a value the person can fix, or `error` (a circle) for a conflict such as a URL that is already connected. |
| `id` | `string` | yes | — | Required stable id — used for `<label for>`, description, error, and the child control's id via context. |
| `label` | `string` | no | — | Visible label text. Omit only when the child control supplies its own accessible name, such as via aria-label or aria-labelledby. |
| `labelVisible` | `boolean` | no | `true` | Whether the label is visibly rendered. Set `false` to visually hide it while keeping it associated with the control. |
| `managed` | { by?: `string`; message?: `string`; reason?: `string` } | no | — | Policy ownership metadata displayed without disabling the control. |
| `note` | `string` | no | — | Neutral explanation drawn under the helper text and wired into `aria-describedby`, such as why a field is cleared. Not an error and not a warning. |
| `required` | `boolean` | no | — | Renders a visual required marker and exposes `required: true` on the context. |
| `warning` | `string` | no | — | Advisory for a legal but potentially risky value; does not mark the control invalid. |
| `children` | `(opaque)` | yes | — | Control(s) rendered inside the field. Not expressible in JSON Schema; see the component types for the signature. |
| `descriptionAction` | `(opaque)` | no | — | Rendered after the helper text inside the same paragraph, so it joins `aria-describedby`: a quiet link such as "Where do I get one?". Shown only with `description`. Not expressible in JSON Schema; see the component types for the signature. |
| `errorAction` | `(opaque)` | no | — | Rendered after the error message inside the same live region, such as a link to the record that conflicts ("Open GitHub") or a quiet Retry. Not expressible in JSON Schema; see the component types for the signature. |
| `trailing` | `(opaque)` | no | — | Rendered beside the control on the same row, such as a Try again button after a failed test. The control takes the room the trailing content leaves. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
