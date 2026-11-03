# Form

Form is a thin native form root that exposes asynchronous submission state to its child snippet and ignores duplicate submissions while the current handler is pending.

Use native validation and form controls as usual. The component owns only submit coordination; it does not replace native serialization, validation, or reset behavior.

## Usage

```svelte
<script lang="ts">
  import { Form } from '@lostgradient/cinder';
  import { Input } from '@lostgradient/cinder';
  import { Button } from '@lostgradient/cinder';
</script>

<Form onSubmit={() => undefined}>
  {#snippet children({ submitting })}
    <Input id="form-name" name="name" label="Name" value="" disabled={submitting} />
    <Button type="submit" disabled={submitting}>Save</Button>
  {/snippet}
</Form>
```

`onSubmit` may return a promise. While it is pending, the child snippet receives `{ submitting: true }`; duplicate submits are ignored until the handler settles. Native form serialization, constraint validation, reset behavior, and the submit event remain the browser's responsibility. If the handler rejects, catch it in the host and keep the controls mounted so the user can correct and resubmit.

## Problems at the fields

Validation never disables the submit button. Pressing it runs `onSubmit`, and once the handler settles `Form` moves focus to the first control that reports a problem (`aria-invalid="true"`, or `data-cinder-invalid="true"` on a custom control), skipping disabled ones, so the person lands on the first message, which sits under its field. Set `focusProblemOnSubmit={false}` when the page manages focus itself. `focusFirstProblem(form)` is exported for a page that needs the same move outside a submit.

`readingColumn` holds the form to a single column up to 720px (`--cinder-form-reading-column-width` changes the width), as a New goal page reads. For the bar at the end of the form, with the unsaved-change count and the failed-save message, see [`FormActions`](../form-actions/README.md).

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class merged with `.cinder-form`. |
| `focusProblemOnSubmit` | `boolean` | no | `true` | After `onSubmit` settles, moves focus to the first field that reports a problem (`aria-invalid="true"`), so a Save that stays enabled while the form is invalid tells the person where to look. Set `false` when the page manages focus itself. |
| `readingColumn` | `boolean` | no | `false` | Holds the form to a single reading column, up to 720px (45rem), instead of the full width of its container. Set `--cinder-form-reading-column-width` to change the width. |
| `children` | `(opaque)` | no | — | Form controls. Receives `{ submitting }` so descendants can disable themselves while `onSubmit` is pending. Not expressible in JSON Schema; see the component types for the signature. |
| `onSubmit` | `(opaque)` | no | — | May return a promise; while pending, the child snippet receives `{ submitting: true }` and duplicate submits are ignored until it settles. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->
