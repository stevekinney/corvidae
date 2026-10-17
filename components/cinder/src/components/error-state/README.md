# ErrorState

Placeholder layout for a region whose data failed to load, with a title, description, optional detail, and an optional retry button. It renders through `Alert` with the `danger` variant, so the failure is announced and never looks like an empty result.

## Usage

```svelte
<script lang="ts">
  import { ErrorState } from '@lostgradient/cinder';
</script>

<ErrorState
  title="Could not load runs"
  description="The server did not respond in time."
  detail="E_TIMEOUT"
  onRetry={() => console.log('retry')}
/>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class merged onto the `.cinder-error-state` root element. |
| `description` | `string` | yes | — | Secondary descriptive text rendered as a paragraph below the title. |
| `detail` | `string` | no | — | Optional technical detail, such as a fault code, rendered below the description. |
| `headingLevel` | `1` \| `2` \| `3` \| `4` \| `5` \| `6` | no | `2` | Heading level for the title element. |
| `retryLabel` | `string` | no | `"Try again"` | Label of the retry button. |
| `title` | `string` | yes | — | Primary heading text rendered as a heading element at the configured `headingLevel`. |
| `onRetry` | `(opaque)` | no | — | Called when the retry button is activated. The retry button renders only when this is given. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
