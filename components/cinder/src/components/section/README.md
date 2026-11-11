# Section

<!-- generated:a11y-record:required -->

`Section` groups content under a heading with no box. It takes a heading, an optional description, an optional action aligned with the heading, and the content. Space, not a surface or a border, separates one section from the next. The content is a block, so its children never shrink inside a flex or scroll parent.

## Usage

```svelte
<script lang="ts">
  import { Button, Section } from '@lostgradient/cinder';
</script>

{#snippet actions()}
  <Button size="sm" variant="secondary">See all</Button>
{/snippet}

<Section title="Upcoming" description="Next seven days" {actions}>
  <p>Nothing scheduled.</p>
</Section>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with `.cinder-section`. |
| `description` | `string` | no | — | Supporting line under the heading, in muted text. |
| `level` | `2` \| `3` \| `4` \| `5` \| `6` | no | `2` | Heading level of the title. Pick the level that fits the page outline. |
| `title` | `string` | yes | — | The section's heading text. |
| `actions` | `(opaque)` | no | — | Controls aligned with the heading, such as an "Add" or "See all" button. They never make the header taller than its title. Not expressible in JSON Schema; see the component types for the signature. |
| `children` | `(opaque)` | no | — | The section's content. Children never shrink inside a flex or scroll parent. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## Authoring checklist

<!-- generated:authoring:start -->
<!-- generated:authoring:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
