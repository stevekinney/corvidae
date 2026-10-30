# ButtonGroup

Clusters related action buttons into a unified visual group with shared borders.

## Usage

```svelte
<script lang="ts">
  import { Button } from '@lostgradient/cinder';
  import { ButtonGroup } from '@lostgradient/cinder';
</script>

<ButtonGroup label="Document actions">
  <Button variant="secondary">Save</Button>
  <Button variant="secondary">Duplicate</Button>
  <Button variant="secondary">Archive</Button>
</ButtonGroup>
```

## Input with an attached Button

An `Input` can be the first member of a group, with a `Button` as the trailing part of the field. The pair shares one border, one height and the outer corners: the Input and the Button take their height from the same step of the shared control height scale, so give both the same `size` and they match at `sm`, `md` and `lg`.

```svelte
<script lang="ts">
  import { Button, ButtonGroup, FormField, Input } from '@lostgradient/cinder';

  let key = $state('');
</script>

<FormField id="api-key" label="API key">
  <ButtonGroup ariaLabelledby="api-key-label">
    <Input id="api-key" bind:value={key} />
    <Button variant="secondary">Test a key</Button>
  </ButtonGroup>
</FormField>
```

Keep the label, description and error outside the group, so nothing but the control sits beside the Button: label the field with an enclosing `FormField` (as above) or a visually hidden label (`labelVisible={false}`), and put any description or error on the `FormField`. Use this for a field the user submits with the button (Test a key, Add a tag). A field that updates as the user types needs no button. A group that holds a field is horizontal only.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `ariaLabelledby` | `string` | no | — | The `id` of a visible heading element that already names the group, applied as `aria-labelledby`. Provide exactly one of `label` or `ariaLabelledby`. |
| `class` | `string` | no | — | Additional class merged with `.cinder-button-group`. |
| `label` | `string` | no | — | Inline accessible name for the group, applied as `aria-label`. Provide exactly one of `label` or `ariaLabelledby`. |
| `orientation` | `"horizontal"` \| `"vertical"` | no | `"horizontal"` | Orientation of the visual collapse. Default: 'horizontal'. |
| `children` | `(opaque)` | yes | — | Buttons (or split-button compositions) to render inside the group. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
