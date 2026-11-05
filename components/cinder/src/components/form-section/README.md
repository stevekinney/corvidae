# FormSection

Groups related form fields under a heading with optional description and layout control.

## Usage

```svelte
<script lang="ts">
  import { FormField } from '@lostgradient/cinder';
  import { FormSection } from '@lostgradient/cinder';
  import { Input } from '@lostgradient/cinder';
  let street = $state('');
  let city = $state('');
  let postalCode = $state('');
</script>

<FormSection
  as="fieldset"
  heading="Shipping address"
  description="Where should we send your order?"
  columns={2}
>
  <FormField id="street" label="Street address">
    <Input id="street" bind:value={street} placeholder="123 Main St" />
  </FormField>
  <FormField id="city" label="City">
    <Input id="city" bind:value={city} placeholder="Springfield" />
  </FormField>
  <FormField id="postal-code" label="Postal code">
    <Input id="postal-code" bind:value={postalCode} placeholder="12345" />
  </FormField>
</FormSection>
```

## Heading note

`meta` puts a short muted note beside the heading on its baseline ("Read with every chat", "3 of 9"). It is outside the heading element, so the heading's accessible name stays the heading text; in a `fieldset` the note sits inside the legend after the text. Use `description` for a sentence of guidance.

## Grouped sections

`grouped` draws the children as one bordered card with a divider between them, under a larger heading and its description. It is the frame of a settings page: each child is a [`SettingRow`](../setting-row/README.md), and a grouped section is always one column whatever `columns` says.

```svelte
<script lang="ts">
  import { FormSection, Input, SettingRow } from '@lostgradient/cinder';
</script>

<FormSection grouped heading="Runs" description="Settings that apply after a restart say so.">
  <SettingRow id="runs-limit" label="Max concurrent runs" identifier="engine.maxConcurrentRuns">
    {#snippet control()}<Input id="runs-limit" value="4" />{/snippet}
  </SettingRow>
</FormSection>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `as` | `"section"` \| `"fieldset"` | no | — | Wrapper element. Default. |
| `class` | `string` | no | — | Additional class merged with `.cinder-form-section`. |
| `columns` | `1` \| `2` \| `3` \| `4` | no | — | Column ceiling. Container queries pick the actual rendered count. Default 2. |
| `description` | `string` | no | — | Optional descriptive paragraph rendered under the heading/legend. |
| `grouped` | `boolean` | no | — | Draws the children as one bordered card, each child separated from the next by a divider, under a larger heading and description. For a page of settings: the children are `SettingRow`s, and a grouped section is always one column. |
| `heading` | `string` | no | — | Heading text rendered as `<h{level}>`. |
| `headingLevel` | `2` \| `3` \| `4` \| `5` \| `6` | no | — | Heading level. Default 2. |
| `meta` | `string` | no | — | A short muted note beside the heading, on its baseline ("Read with every chat", "3 of 9"). It says what the section is for or how much is in it; a sentence of guidance is the `description`. |
| `children` | `(opaque)` | yes | — | Children (FormField instances or arbitrary content). Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
