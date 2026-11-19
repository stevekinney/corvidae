# EmptyState

Placeholder layout for zero-data views, with optional illustration, heading, and action.

## Usage

```svelte
<script lang="ts">
  import { EmptyState } from '@lostgradient/cinder';
  import { Webhook } from '@lucide/svelte';
</script>

<EmptyState
  title="No hooks yet"
  description="A hook does something when an event happens: send a webhook, start a workflow, or notify you."
  actions={[{ label: 'New hook', href: '/hooks/new' }]}
>
  {#snippet icon()}<Webhook aria-hidden="true" />{/snippet}
</EmptyState>
```

An empty state has one layout wherever it sits, a list page, a tab, a section or a panel: the parts stacked and centred across, top-aligned at one offset under whatever is above them (never centred in a tall window), never in a box, with the title, the sentence and the details held to about 60 characters. There is no size, alignment, border or row variant to pick, so every empty state in an application looks the same. A section or a tab that is empty shows the state alone: leave out the section's own heading and description when they would say the same thing.

Pick the `kind` that says why the view is empty. It sets the tint of the 48px disc, and the glyph it shows when you pass no `icon`:

- `first-use`: nothing exists yet. An accent disc that holds the view's own icon, and a primary button as the action. There is no default glyph, so pass the `icon`.
- `filtered`: a filter or search hid items that exist. A neutral disc with a funnel, and a secondary "Clear filters" button from `onClearFilters`, which is the only action.
- `done`: the work is finished. A green disc with a check, and optionally a secondary button as the action.
- `blocked`: something the person can fix keeps the view empty. An amber disc with a warning glyph.
- `not-found`: the thing asked for doesn't exist. A neutral disc with a magnifying glass.
- `disabled`: a setting the person chose (a disabled plugin) holds the content back, so it is not a warning. A neutral disc with a plug.

A title says what is missing or what happened, never an instruction ("No hooks yet", not "Build your first hook"), and the sentence under it is one sentence, with contractions.

```svelte
<script lang="ts">
  import { EmptyState } from '@lostgradient/cinder';

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
  actions={[{ label: 'See past decisions', href: '/reviews/done', variant: 'secondary' }]}
/>
```

A list page with nothing in it yet puts the state under its `PageHeader`. The page passes only its title, its sentence, its own icon (the one its navigation item shows) and its `actions`, which the component draws as buttons, the first primary and the rest secondary; use the header's verb ("New goal", never "Create a goal"). Leave out counts, search and filters until the first item exists.

```svelte
<script lang="ts">
  import { EmptyState } from '@lostgradient/cinder';
  import { Target } from '@lucide/svelte';
</script>

<EmptyState
  headingLevel={2}
  title="No goals yet"
  description="A goal runs an agent on a prompt until a check passes."
  actions={[
    { label: 'New goal', href: '/goals/new' },
    { label: 'Ask an agent', href: '/chats/new' },
  ]}
>
  {#snippet icon()}<Target aria-hidden="true" />{/snippet}
</EmptyState>
```

The action stays buttons: it is a wrapping row of call-to-action controls. Content that belongs under the action, such as the lines and numbered steps of a manual set-up, goes in the component's children, which follow the action in a block of their own at the words' measure:

```svelte
<script lang="ts">
  import { Button, EmptyState } from '@lostgradient/cinder';
</script>

<EmptyState
  title="Connect a model provider"
  description="Agents can't answer until one is connected."
>
  {#snippet action()}
    <Button variant="primary" label="Connect a provider" />
  {/snippet}
  <p>Or set it up by hand:</p>
  <ol>
    <li>Save the key in a file.</li>
    <li>Restart.</li>
  </ol>
</EmptyState>
```

The `icon` snippet replaces the glyph in the disc. The `illustration` snippet draws a larger picture above the title in place of the disc; it is decorative and sizes to its own content, so give it an `svg` or an `img` of the size you want. The action row wraps with even spacing.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class merged onto the `.cinder-empty-state` root element. |
| `clearFiltersLabel` | `string` | no | `"Clear filters"` | Label of the "Clear filters" button. |
| `description` | `string` | no | — | Secondary descriptive text rendered as a paragraph below the title. |
| `headingLevel` | `1` \| `2` \| `3` \| `4` \| `5` \| `6` | no | `3` | Heading level for the title element. |
| `kind` | `"first-use"` \| `"filtered"` \| `"done"` \| `"blocked"` \| `"not-found"` \| `"disabled"` | no | `"first-use"` | Why the view is empty. It sets the disc tint and the default glyph (first use, filtered, done, blocked, not found or disabled). Every kind renders its `actions`; `'filtered'` also adds a secondary "Clear filters" button before them when `onClearFilters` is set. Give `'first-use'` a primary button, `'done'` a secondary one, and `'filtered'` the Clear filters button alone. |
| `title` | `string` | yes | — | Primary heading text rendered as a heading element at the configured `headingLevel`. |
| `action` | `(opaque)` | no | — | Call-to-action content rendered after the `actions` buttons and the "Clear filters" button. Prefer `actions`, which are always drawn as buttons; whatever goes here should be a `Button` too, never a text link. Not expressible in JSON Schema; see the component types for the signature. |
| `actions` | `(opaque)` | no | — | The state's buttons, drawn by the component so they are always buttons, never text links: the first is primary (the page's create action, with the header's verb) and any later one is secondary. They come before the `action` snippet when both are passed. Not expressible in JSON Schema; see the component types for the signature. |
| `children` | `(opaque)` | no | — | Supporting content under the buttons, such as the steps of a manual set-up; the action stays buttons. It holds the same measure as the words and draws no border or background. Not expressible in JSON Schema; see the component types for the signature. |
| `icon` | `(opaque)` | no | — | Replaces the glyph in the disc. First use shows the view's own icon; every other kind has a default glyph. Decorative, so it is hidden from assistive technology. Not expressible in JSON Schema; see the component types for the signature. |
| `illustration` | `(opaque)` | no | — | A larger picture drawn above the title in place of the disc, for a state that wants more than a glyph. Decorative, so it is hidden from assistive technology; say what is missing in the title. Not expressible in JSON Schema; see the component types for the signature. |
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
