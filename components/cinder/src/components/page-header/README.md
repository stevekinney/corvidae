# PageHeader

Page-level heading with named title, description, breadcrumb, and action regions, as a default header, a large title that collapses on scroll, or a full-bleed hero band.

## Usage

```svelte
<script lang="ts">
  import { PageHeader } from '@lostgradient/cinder';
</script>

<PageHeader title="Approvals" />
```

## Create action, status and errors

A list page's create action is a `createAction`: a secondary icon-only "+" with a tooltip and an accessible name, drawn last in the actions region so it sits in the same place in every state, whether the list is empty or not. It is always secondary, because an empty state's own button is the only primary on an empty page. It goes inert under a stale `<StaleRegion>` (`mutating` defaults to `true`). A header whose only action is the create "+" keeps it at the right of the title on a phone, where any other actions drop to a row of their own.

```svelte
<script lang="ts">
  import { PageHeader } from '@lostgradient/cinder';
</script>

<PageHeader
  title="Agents"
  description="Agents run your chats, goals and schedules."
  createAction={{ label: 'New agent', href: '/agents/new' }}
/>
```

While a full-page `ErrorState` shows under the header, pass `error` so the header's primary buttons draw as secondary and Try again is the only primary.

`status` takes the page's status as a snippet and `statusPlacement` puts it beside the title (`inline`, on its first line) or under it (`below`, the default). The title wraps to two lines and then ends in an ellipsis; its tooltip carries the full text, from `title` or, when `title` is a snippet, from `titleText`.

## Flush

The header draws no rule by default; pass `divider` for one. `flush` draws the header with no padding around it, so its title lines up with the content beneath. Use it where the page lays out its own column, such as a page of settings with a section navigation beside it.

```svelte
<script lang="ts">
  import { PageHeader } from '@lostgradient/cinder';
</script>

<PageHeader flush title="Allowed models" description="Which models agents may use." />
```

## Decisions are never hidden

A page that waits on a decision puts it in `decisions`: approve, deny or edit for an approval, or Cancel for running or paused work. The group is drawn first among the actions and stays visible at every width; it is never put in the overflow menu. `overflow` holds the secondary actions behind one "More actions" button (`overflowLabel` renames it). An overflow action marked `decision: true` is drawn as a visible button beside the group instead of in the menu, so a list of actions that comes from data cannot hide one either.

```svelte
<script lang="ts">
  import { Button, PageHeader } from '@lostgradient/cinder';
</script>

<PageHeader
  title="Refund order 4471"
  overflow={[
    { label: 'Copy link', onclick: () => {} },
    { label: 'Cancel run', decision: true, onclick: () => {} },
  ]}
>
  {#snippet decisions()}
    <Button variant="primary">Approve</Button>
    <Button>Deny</Button>
  {/snippet}
</PageHeader>
```

## Large title

`variant="large"` sets the title at the large page-title step (28px). Once the title scrolls away, a sticky bar shows it at the default page-title size over the content, on a translucent surface that is opaque when the platform cannot blur or the person asks for less transparency. The bar is drawn just before the header, in the page's flow, so it stays stuck for the whole page; the heading itself stays where it is, and the bar is hidden from assistive technology.

`collapsed` is bindable and says whether the title has scrolled away. To show the title in an [`AppBar`](../app-bar/README.md) instead, bind it to the bar's `titleVisible` and turn off the header's own bar with `collapsedBar={false}`.

```svelte
<script lang="ts">
  import { AppBar, PageHeader } from '@lostgradient/cinder';

  let collapsed = $state(false);
</script>

<AppBar title="Runs" titleVisible={collapsed} />
<PageHeader variant="large" title="Runs" bind:collapsed collapsedBar={false} />
```

## Hero

`variant="hero"` is a full-bleed band at page level, never a card inside the page: place it outside the page's padded column, and its content is capped at the page's content width. It has an `eyebrow` (neutral, never the accent colour), a display title, `facts` such as a `KeyFacts` row, the actions beneath the title at their own size, and at the inline end either a `focal` value or `media`. It looks finished with no media at all, and none of the examples here use a photo.

`tone` sets the band: `plain` draws none, `tint` is a light or dark indigo wash, `accent` is a saturated indigo gradient with light text, and `night` is near-black with an indigo glow. Every tone keeps its text at 4.5:1 or better, and indigo is the only accent. On `accent` and `night` the hero provides its controls' defaults: a primary Button is a white fill with an indigo label, a secondary Button is translucent, and a SegmentedControl sits on a translucent track. The page sets nothing for this.

A dotted pattern fades in from the inline end of every hero, and `art` adds one large icon glyph at low opacity in the bottom inline-end corner. Both are hidden from assistive technology and are not drawn when the person asks for more contrast or forces colours. `art` is not drawn when `focal` is set: one focal element per screen.

`focal` holds one large tabular value first, then its label in a `<small>`, then an optional `Meter`. The layout answers to the hero's own width through a container query, not the viewport: below 720px it is one column with the focal value first, and the title and the focal value are sized in container units.

`titleSoft` adds a lighter phrase straight after the title, in the same heading at the same size, so a brand name can carry it: the title is weight 760 and the phrase 380, and the heading keeps one accessible name. Include any leading space or punctuation in it.

### Each tone, without a focal value

```svelte
<script lang="ts">
  import { Button, KeyFacts, PageHeader } from '@lostgradient/cinder';
  import { Martini } from '@lucide/svelte';
</script>

{#each ['plain', 'tint', 'accent', 'night'] as const as tone (tone)}
  <PageHeader
    variant="hero"
    {tone}
    eyebrow="Denver"
    title="Poor Decisions"
    titleSoft=", made easier"
    description="Happy hours near you, open right now."
  >
    {#snippet facts()}
      <KeyFacts items={[{ value: 'LoDo' }, { value: '14 open now' }, { value: 'Until 7 PM' }]} />
    {/snippet}
    {#snippet actions()}
      <Button variant="primary">Find a spot</Button>
      <Button>See the map</Button>
    {/snippet}
    {#snippet art()}<Martini aria-hidden="true" />{/snippet}
  </PageHeader>
{/each}
```

### Each tone, with a focal value

```svelte
<script lang="ts">
  import { Button, Meter, PageHeader } from '@lostgradient/cinder';
</script>

{#each ['plain', 'tint', 'accent', 'night'] as const as tone (tone)}
  <PageHeader
    variant="hero"
    {tone}
    eyebrow="Run 4471"
    title="Refund order 4471"
    description="Waiting on your approval to issue the refund."
  >
    {#snippet decisions()}
      <Button variant="primary">Approve</Button>
      <Button>Deny</Button>
    {/snippet}
    {#snippet focal()}
      <span>$84.20</span>
      <small>Refund amount</small>
      <Meter value={62} ariaLabel="Share of the order refunded" />
    {/snippet}
  </PageHeader>
{/each}
```

### At phone width

Below 720px of the hero's own width the focal value comes first and the copy follows in one column. A hero in a 375px frame:

```svelte
<script lang="ts">
  import { Button, PageHeader } from '@lostgradient/cinder';
</script>

<div style="inline-size: 375px;">
  <PageHeader
    variant="hero"
    tone="accent"
    eyebrow="Neighborhood"
    title="Capitol Hill"
    description="Eleven bars with a happy hour today."
  >
    {#snippet actions()}
      <Button variant="primary">Show them</Button>
    {/snippet}
    {#snippet focal()}
      <span>11</span>
      <small>Open now</small>
    {/snippet}
  </PageHeader>
</div>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class names merged with `.cinder-page-header`. |
| `collapsed` | `boolean` | no | `false` | Whether a `large` title has scrolled away. Bind it to pair the header with an AppBar's `titleVisible`. |
| `collapsedBar` | `boolean` | no | `true` | Whether a `large` header draws its own sticky bar with the title once the title scrolls away. Turn it off when an AppBar shows the title instead. |
| `description` | `string` | no | — | Optional supporting text rendered below the title; the runtime API also accepts a template-only snippet. |
| `divider` | `boolean` | no | `false` | Draws a rule under the header. Off by default: space separates the header from the page, and the rule is opt-in. A flush header never draws one. |
| `error` | `boolean` | no | `false` | A full-page error state shows under this header, so its primary buttons draw as secondary. |
| `eyebrow` | `string` | no | — | A short neutral line above a `hero` title, such as the section or the place. |
| `flush` | `boolean` | no | `false` | Draws the header with no padding around it, so its title lines up with the content beneath it. A page that lays out its own column, such as a page of settings with a section navigation beside it, uses this. |
| `headingLevel` | `1` \| `2` \| `3` \| `4` \| `5` \| `6` | no | `1` | Heading level for the title element. Defaults to `1`. |
| `overflowLabel` | `string` | no | `"More actions"` | The accessible name of the overflow menu button. |
| `statusPlacement` | `"inline"` \| `"below"` | no | `"below"` | Where `status` sits: `inline` beside the title on its first line, or `below` the title. |
| `title` | `string` | yes | — | Page-level heading text rendered inside the `headingLevel` heading; the runtime API also accepts a template-only snippet. |
| `titleSoft` | `string` | no | — | A lighter phrase drawn straight after the title, in the same heading at the same size, such as ", made easier" after a brand name. Include any leading space or punctuation. |
| `titleText` | `string` | no | — | The title's plain text, for the full-title tooltip when `title` is a snippet. |
| `tone` | `"plain"` \| `"tint"` \| `"accent"` \| `"night"` | no | `"plain"` | The band a `hero` header draws: `plain`, `tint`, `accent` or `night`. The other variants ignore it. |
| `variant` | `"default"` \| `"large"` \| `"hero"` | no | `"default"` | The header's layout: `default`, `large` (a large title that collapses into a sticky bar on scroll) or `hero` (a full-bleed band). |
| `actions` | `(opaque)` | no | — | Optional trailing actions (buttons, menus, controls). Not expressible in JSON Schema; see the component types for the signature. |
| `art` | `(opaque)` | no | — | One large icon glyph drawn at low opacity at the bottom inline-end corner of a `hero` band. It is decorative and hidden from assistive technology, and it is not drawn when `focal` is set. Not expressible in JSON Schema; see the component types for the signature. |
| `breadcrumbs` | `(opaque)` | no | — | Optional breadcrumb navigation rendered above the heading row. Not expressible in JSON Schema; see the component types for the signature. |
| `decisions` | `(opaque)` | no | — | The decision action group: approve, deny or edit for an approval, or Cancel for running or paused work. It is drawn first among the actions, is never put in the overflow menu, and stays visible at every width. Not expressible in JSON Schema; see the component types for the signature. |
| `facts` | `(opaque)` | no | — | A `hero` header's facts beneath the title, such as a KeyFacts row. Not expressible in JSON Schema; see the component types for the signature. |
| `focal` | `(opaque)` | no | — | A `hero` header's focal value at the inline end: one large tabular value first, then its label in a `<small>`, then an optional Meter. Below 720px of header width it sits above the title. Not expressible in JSON Schema; see the component types for the signature. |
| `media` | `(opaque)` | no | — | Optional media at the inline end of a `hero` header. A hero needs none to look finished. Not expressible in JSON Schema; see the component types for the signature. |
| `status` | `(opaque)` | no | — | The page's status, such as a dot and "Waiting on you". It is a snippet so the page owns the words and the tone; see `statusPlacement` for where it sits. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
