# EmptyState

Placeholder layout for zero-data views, with optional illustration, heading, and action.

## Usage

```svelte
<script lang="ts">
  import { Button } from '@lostgradient/cinder';
  import { EmptyState } from '@lostgradient/cinder';
</script>

<EmptyState title="No results found" description="Try adjusting your filters or search query.">
  {#snippet action()}
    <Button variant="primary" label="Clear filters" />
  {/snippet}
</EmptyState>
```

Start-aligned — the content reads from the inline start instead of the centre, for a state that explains what to do rather than marking an absence:

```svelte
<script lang="ts">
  import { EmptyState } from '@lostgradient/cinder';
</script>

<EmptyState
  align="start"
  title="No provider is configured"
  description="Add a model provider to create an agent."
/>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `align` | `"center"` \| `"start"` | no | `"center"` | Alignment of the content. `'center'` centres the icon, text, and action in the region; `'start'` aligns them to the inline start, for a state that reads as instructions rather than a placeholder. A start-aligned state also leads with a larger, semibold, default-colour title and a muted description. |
| `class` | `string` | no | — | Additional class merged onto the `.cinder-empty-state` root element. |
| `description` | `string` | no | — | Secondary descriptive text rendered as a paragraph below the title. |
| `headingLevel` | `1` \| `2` \| `3` \| `4` \| `5` \| `6` | no | `3` | Heading level for the title element. |
| `title` | `string` | yes | — | Primary heading text rendered as a heading element at the configured `headingLevel`. |
| `action` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `icon` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
