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

Pick the `kind` that says why the view is empty. `first-use` is the default and shows the `action` snippet. `filtered` means a filter or search hid items that exist, so it offers a Clear filters button from `onClearFilters`. `done` means the work is finished, so it shows no action at all:

```svelte
<script lang="ts">
  import { EmptyState } from '@lostgradient/cinder';

  let query = $state('overdue');
</script>

<EmptyState
  kind="filtered"
  title="No runs match"
  description="Nothing matches the current filters. Clear them to see every run."
  onClearFilters={() => (query = '')}
/>

<EmptyState kind="done" title="Inbox zero" description="Every approval has been answered." />
```

Use `size="compact"` inside a tab or a panel, where the default page-region padding and disc are too large:

```svelte
<script lang="ts">
  import { EmptyState } from '@lostgradient/cinder';
</script>

<EmptyState size="compact" title="No comments yet" description="Replies appear here." />
```

The icon snippet renders inside a tinted disc: neutral for `filtered`, accented for `first-use`, and success-tinted for `done`. The description keeps a readable measure of about 42 characters however wide the region is, and the action row wraps with even spacing.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `align` | `"center"` \| `"start"` | no | `"center"` | Alignment of the content. `'center'` centres the icon, text, and action in the region; `'start'` aligns them to the inline start, for a state that reads as instructions rather than a placeholder. |
| `class` | `string` | no | — | Additional class merged onto the `.cinder-empty-state` root element. |
| `clearFiltersLabel` | `string` | no | `"Clear filters"` | Label of the "Clear filters" button. |
| `description` | `string` | no | — | Secondary descriptive text rendered as a paragraph below the title. |
| `headingLevel` | `1` \| `2` \| `3` \| `4` \| `5` \| `6` | no | `3` | Heading level for the title element. |
| `kind` | `"first-use"` \| `"filtered"` \| `"done"` | no | `"first-use"` | Why the view is empty. `'first-use'` shows the `action` snippet, `'filtered'` adds a "Clear filters" button when `onClearFilters` is set, and `'done'` shows no action at all, even when `action` is passed, because there is nothing left to do. |
| `size` | `"default"` \| `"compact"` | no | `"default"` | Scale of the state. `'compact'` tightens the padding, disc, and type so the state fits a tab or a panel rather than a whole page region. |
| `title` | `string` | yes | — | Primary heading text rendered as a heading element at the configured `headingLevel`. |
| `action` | `(opaque)` | no | — | Call-to-action content rendered below the description, after the "Clear filters" button when both exist. Not expressible in JSON Schema; see the component types for the signature. |
| `icon` | `(opaque)` | no | — | Icon rendered above the title, centred in a tinted disc. Decorative, so it is hidden from assistive technology. Not expressible in JSON Schema; see the component types for the signature. |
| `onClearFilters` | `(opaque)` | no | — | Called when the "Clear filters" button of a `'filtered'` state is pressed. The button renders only when this is set. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
