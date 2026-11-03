# Breadcrumbs

A navigation trail that shows the current page's position in a hierarchy.

## Usage

```svelte
<script lang="ts">
  import { Breadcrumbs } from '@lostgradient/cinder';
</script>

<Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Docs' }]} />
```

## Phone form

Below `collapseBelow` (640px by default) the trail collapses to a back link labelled with the parent, then the current page, which truncates first. The back link is a real link with the accessible name "Back to Runs" (`backLabel` words it), at least 44px tall. A trail with one entry shows just that entry, and `collapseBelow={false}` keeps the whole trail at every width. The choice is made in script from the viewport, so the ancestors that are not shown are not in the page.

## A long current page

Give the last item a `popover` and it draws as a bordered button with a chevron that truncates its label with an ellipsis at 300px. `popover: true` fills the popover with the full label, which is what a long chat title needs; a snippet fills it with anything else.

```svelte
<script lang="ts">
  import { Breadcrumbs } from '@lostgradient/cinder';
</script>

<Breadcrumbs
  separator="›"
  items={[
    { label: 'Chat', href: '/chat' },
    { label: 'A very long chat title …', popover: true },
  ]}
/>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `backLabel` | `string` | no | `"Back to {label}"` | Accessible name of the phone back link; `{label}` is replaced by the parent's label. |
| `class` | `string` | no | — | Additional class names merged with `.cinder-breadcrumbs`. |
| `collapseBelow` | `string` \| `false` | no | `"640px"` | Viewport width below which the trail collapses to a back link and the current page. A simple CSS length such as `'640px'`, or `false` to always show the whole trail. |
| `label` | `string` | no | `"Breadcrumb"` | Accessible name for the nav landmark. |
| `separator` | `string` | no | `"/"` | Custom string separator between entries. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

<!-- generated:subcomponents:end -->
