# Section

<!-- generated:a11y-record:required -->

`Section` groups content under a heading with no box. It takes a heading, an optional description, an optional action aligned with the heading, and the content. Space, not a surface or a border, separates one section from the next. The content is a block, so its children never shrink inside a flex or scroll parent.

The title steps down with its `level`, so a section inside a section reads as part of it: level 2 (the default) is the large size, level 3 is the base size, and level 4 and deeper are the small size in muted text. Pick the level from the page outline, never to make a title smaller: a level is never skipped.

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

### Sections side by side or in a gap

A section that directly follows another section takes a `--cinder-space-8` top margin, the space between sections in a page's flow. A flex or grid parent that spaces its sections with `gap` therefore gives each section a wrapper of its own: two adjacent sections in a gap container add that margin to the gap, so stacked sections sit twice as far apart and, side by side, the second one starts lower than the first.

```svelte
<script lang="ts">
  import { Section } from '@lostgradient/cinder';
</script>

<div class="bands">
  <div><Section title="Workflow activity"><p>No workflow activity yet.</p></Section></div>
  <div><Section title="Agent activity"><p>No agent activity yet.</p></Section></div>
</div>

<style>
  .bands {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--cinder-space-8);
  }
</style>
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
