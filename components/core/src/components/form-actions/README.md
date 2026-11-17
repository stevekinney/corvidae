# FormActions

<!-- generated:a11y-record:required -->

`FormActions` is the bar at the end of a form. The left side says where the form stands: an unsaved-change count ("2 unsaved changes") and the effect of saving ("Saving raises the policy revision."). The right side holds the buttons, secondary first and the primary submit last, so it sits rightmost. A top divider and the page's canvas fill set the bar apart from the fields above it.

- **Sticky**: `sticky` keeps the bar at the bottom of the nearest scrolling container, so Save is in reach however long the form gets. The bar sits in the flow at the end of the form, so the content above it needs no bottom padding of its own, and it clears the home indicator and rides above the on-screen keyboard. While it is mounted it publishes its height so the toast region sits above it.
- **Failed save**: `error` (and `errorTitle`) draw a danger alert above the buttons. The fields keep what the person entered and Save keeps its label as the retry.
- **Narrow**: below 28rem of bar width the summary takes its own line and the buttons share the row under it.

Save stays enabled while the form is invalid. [`Form`](../form/README.md) moves focus to the first field with a problem when it is pressed.

## Usage

```svelte
<script lang="ts">
  import { Button, Form, FormActions } from '@lostgradient/cinder';
</script>

<Form onSubmit={() => undefined}>
  <FormActions sticky unsavedChanges={2}>
    {#snippet summary()}Saving raises the policy revision.{/snippet}
    {#snippet end()}
      <Button variant="secondary">Reset to default</Button>
      <Button type="submit" variant="primary">Save</Button>
    {/snippet}
  </FormActions>
</Form>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class merged with `.cinder-form-actions`. |
| `error` | `string` | no | — | What a failed save says, in a danger alert above the buttons: "Couldn't save. Interborough didn't answer. Your choices are still here." The first sentence is drawn as the title when `errorTitle` is not set. The buttons keep their labels, so Save is the retry. |
| `errorTitle` | `string` | no | — | Bold lead-in for `error`, such as "Couldn't save." |
| `label` | `string` | no | `"Form actions"` | Accessible name of the bar, read as the name of its group. |
| `sticky` | `boolean` | no | `false` | Keeps the bar at the bottom of the nearest scrolling container, so Save is in reach however long the form gets. It clears the home indicator and rides above the on-screen keyboard. |
| `unsavedChanges` | `number` | no | — | How many changes the form holds that are not saved. Above zero the bar's left side reads "1 unsaved change" or "N unsaved changes" in neutral text; at zero it says nothing. |
| `end` | `(opaque)` | yes | — | The buttons at the end of the bar, secondary first and the primary submit last, so it sits rightmost: Cancel, then Save. Not expressible in JSON Schema; see the component types for the signature. |
| `start` | `(opaque)` | no | — | Controls kept at the start of the bar, after the summary and before the buttons, such as a Delete outside the main pair. Not expressible in JSON Schema; see the component types for the signature. |
| `summary` | `(opaque)` | no | — | The left side of the bar: a status line such as "Not saved yet", or the effect of saving ("Saving raises the policy revision."). Follows the unsaved-change count when there is one. Not expressible in JSON Schema; see the component types for the signature. |

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
