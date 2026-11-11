# EmptyState

Placeholder layout for zero-data views, with optional illustration, heading, and action.

## Usage

```svelte
<script lang="ts">
  import { Button } from '@lostgradient/cinder';
  import { EmptyState } from '@lostgradient/cinder';
</script>

<EmptyState
  title="No hooks yet"
  description="A hook does something when an event happens: send a webhook, start a workflow, or notify you."
>
  {#snippet action()}
    <Button variant="primary" label="New hook" />
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
  title="No provider is connected"
  description="Add a model provider to create an agent."
/>
```

Pick the `kind` that says why the view is empty. It sets the tint of the 48px disc, and the glyph it shows when you pass no `icon`:

- `first-use`: nothing exists yet. An accent disc that holds the view's own icon, and a primary button as the action. There is no default glyph, so pass the `icon`.
- `filtered`: a filter or search hid items that exist. A neutral disc with a funnel, and a secondary "Clear filters" button from `onClearFilters`, which is the only action.
- `done`: the work is finished. A green disc with a check, and optionally a quiet link as the action.
- `blocked`: something the person can fix keeps the view empty. An amber disc with a warning glyph.
- `not-found`: the thing asked for doesn't exist. A neutral disc with a magnifying glass.
- `disabled`: a setting the person chose (a disabled plugin) holds the content back, so it is not a warning. A neutral disc with a plug.

A title says what is missing or what happened, never an instruction ("No hooks yet", not "Build your first hook"), and the sentence under it is one sentence of at most 380px, with contractions.

```svelte
<script lang="ts">
  import { EmptyState, Link } from '@lostgradient/cinder';

  let query = $state('overdue');
</script>

<EmptyState
  kind="filtered"
  title="No runs match these filters"
  description="Model switcher has no runs. Try another agent."
  onClearFilters={() => (query = '')}
/>

<EmptyState
  kind="done"
  title="All caught up"
  description="Nothing is waiting on you. When an agent asks for approval, it shows up here."
>
  {#snippet action()}
    <Link href="/reviews/done">See past decisions</Link>
  {/snippet}
</EmptyState>
```

The state centres itself in the height it is given, with 8px of extra bottom padding for the optical centre, so give it the height left under the page header and filters. Add `bordered` when the list or page body has no container of its own and the state should draw one.

Use `size="compact"` inside a tab or a panel, where the default page-region padding and disc are too large:

```svelte
<script lang="ts">
  import { EmptyState } from '@lostgradient/cinder';
</script>

<EmptyState size="compact" title="No comments yet" description="Replies appear here." />
```

Use `layout="row"` for a state that sits inside a card or a list in place of its rows. The disc and the words read from the start and the action sits at the end of the one line; on a phone the action drops under the words:

```svelte
<script lang="ts">
  import { EmptyState, Link } from '@lostgradient/cinder';
</script>

<EmptyState
  kind="done"
  layout="row"
  headingLevel={3}
  title="Nothing is waiting on you"
  description="Approvals and questions from your agents show up here."
>
  {#snippet action()}
    <Link href="/reviews">Open Reviews</Link>
  {/snippet}
</EmptyState>
```

The `icon` snippet replaces the glyph in the disc. The `illustration` snippet draws a larger picture above the title in place of the disc, in the stacked layout only; it is decorative and sizes to its own content, so give it an `svg` or an `img` of the size you want. The description keeps a measure of 380px however wide the region is, and the action row wraps with even spacing.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `align` | `"center"` \| `"start"` | no | `"center"` | Alignment of the content. `'center'` centres the icon, text, and action in the region; `'start'` aligns them to the inline start, for a state that reads as instructions rather than a placeholder. |
| `bordered` | `boolean` | no | `false` | Draws the state inside a bordered, rounded box, for a list or page body that has no container of its own. Leave it off when a card or panel already surrounds the state. |
| `class` | `string` | no | — | Additional class merged onto the `.cinder-empty-state` root element. |
| `clearFiltersLabel` | `string` | no | `"Clear filters"` | Label of the "Clear filters" button. |
| `description` | `string` | no | — | Secondary descriptive text rendered as a paragraph below the title. |
| `headingLevel` | `1` \| `2` \| `3` \| `4` \| `5` \| `6` | no | `3` | Heading level for the title element. |
| `kind` | `"first-use"` \| `"filtered"` \| `"done"` \| `"blocked"` \| `"not-found"` \| `"disabled"` | no | `"first-use"` | Why the view is empty. It sets the disc tint and the default glyph (first use, filtered, done, blocked, not found or disabled). Every kind renders the `action` snippet; `'filtered'` also adds a secondary "Clear filters" button before it when `onClearFilters` is set. Give `'first-use'` a primary button, `'done'` a quiet `Link`, and `'filtered'` the Clear filters button alone. |
| `layout` | `"stacked"` \| `"row"` \| `"inline"` | no | `"stacked"` | Whether the state stacks its parts and centres them (`'stacked'`), lays them on one row, with the disc and the words at the start and the action at the end (`'row'`), or draws a 32px disc beside the title and the sentence on one line (`'inline'`). A row reads as the line of a list, such as "Nothing is waiting on you" with its link to the page that holds the rest, so it is the layout for a state inside a card; on a phone its action drops under the words. Inline sits among rows at the inline start, without the vertical padding of a region; use it with `size="compact"`. |
| `size` | `"default"` \| `"compact"` | no | `"default"` | Scale of the state. `'compact'` tightens the padding, disc, and type so the state fits a tab or a panel rather than a whole page region. |
| `title` | `string` | yes | — | Primary heading text rendered as a heading element at the configured `headingLevel`. |
| `action` | `(opaque)` | no | — | Call-to-action content rendered below the description, after the "Clear filters" button when both exist. A primary `Button` for first use, a `Link` (accent, underlined only on hover) for done, and a secondary button for a not-found or blocked state. Not expressible in JSON Schema; see the component types for the signature. |
| `icon` | `(opaque)` | no | — | Replaces the glyph in the disc. First use shows the view's own icon; every other kind has a default glyph. Decorative, so it is hidden from assistive technology. Not expressible in JSON Schema; see the component types for the signature. |
| `illustration` | `(opaque)` | no | — | A larger picture drawn above the title in place of the disc, for a page-sized state that wants more than a glyph. Drawn only in the `'stacked'` layout; a `'row'` or `'inline'` state keeps its disc and ignores it. Decorative, so it is hidden from assistive technology; say what is missing in the title. Not expressible in JSON Schema; see the component types for the signature. |
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
