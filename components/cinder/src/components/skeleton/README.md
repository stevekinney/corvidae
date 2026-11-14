# Skeleton

Animated placeholder shape that fills content areas while data is loading.

## Usage

```svelte
<script lang="ts">
  import { Skeleton } from '@lostgradient/cinder';
</script>

<Skeleton />
```

### Lines and variants

`lines` stacks text bars, and the last bar is shorter unless you pass `width`. `variant="card"` draws a heading bar and the lines inside a bordered card. Both match the real layout, so the page does not shift when content arrives:

```svelte
<script lang="ts">
  import { Skeleton } from '@lostgradient/cinder';
</script>

<Skeleton lines={4} />
<Skeleton variant="card" lines={3} />
```

### Form variant

`variant="form"` draws `rows` fields, each a short label bar over a full-width control bar at the control height, for the input of a form that is still loading. It takes `stillLoadingAfter`, `onCancel` and `label` like the other groups.

```svelte
<Skeleton
  variant="form"
  rows={2}
  label="Reading the workflow"
  stillLoadingAfter={10000}
  onCancel={stop}
/>
```

### List variant

`variant="list"` draws the placeholder for a status-first list in the real layout: a bordered surface of `rows` rows (default 3), each with the 8rem status column reserved, two text bars and a time bar at the right. No leading circle or avatar is drawn, so nothing shifts when the data arrives. `dayBand` adds a tinted day band above the rows for a list grouped by day. On a narrow container the status bar drops under the text bars, as a stacked list item does on a phone.

`label` names the loading region (for example `"Loading agents"`). The bars stay hidden from assistive technology, no spinner is drawn, and the name is announced politely when the rows appear:

```svelte
<script lang="ts">
  import { Skeleton } from '@lostgradient/cinder';
</script>

<Skeleton variant="list" rows={3} dayBand label="Loading runs" />
```

### Grouped variant

`variant="grouped"` is the placeholder for a `GroupedList`: `rows` rows (default 3) of two text bars on the same rounded raised surface, with no border and separators that start at the text. Each bar sits in a line box of the text it stands for, so a placeholder row is as tall as a row with a title and a subtitle. `action` adds a block the height of a small button at the end of each row, for a list whose rows end in text actions; in a row narrower than 26rem, as on a phone, the block drops under the text at its own width, starting at the text's leading edge, where the buttons go. `label` and the loading rules work as they do for the list variant:

```svelte
<script lang="ts">
  import { Skeleton } from '@lostgradient/cinder';
</script>

<Skeleton variant="grouped" rows={2} action label="Loading reviews" />
```

### Loading rules

Cinder's loading rules are timing rules, and Skeleton implements them so each view does not rebuild them:

- Show nothing for the first 300 ms, so a fast load never flashes a placeholder (`delay={300}`).
- Show the skeleton in the real layout until 10 seconds have passed.
- After 10 seconds, add a "Still loading" status with a Cancel button (`stillLoadingAfter={10000}` and `onCancel`).

```svelte
<script lang="ts">
  import { Skeleton } from '@lostgradient/cinder';

  let loading = $state(true);
</script>

{#if loading}
  <Skeleton lines={5} delay={300} stillLoadingAfter={10000} onCancel={() => (loading = false)} />
{/if}
```

The status is Skeleton's own line above the placeholders, at the inline start, and never a banner: after a long wait it is the first thing in view, never cut off below a page of placeholders. The header and filters of the page stay live. The default text is the shared line, "Still loading. This is taking longer than usual."; a page replaces it with its own noun through `stillLoadingLabel`, for example "Still loading runs. This is taking longer than usual.". Cancel is a ghost button that appears only when `onCancel` is set.

When the loading state is the shape of a whole page (real labels and headings with placeholder values and rows), give the Skeleton `children`. They are drawn instead of the bars, in a group marked busy, and the group keeps the timing: nothing is drawn until `delay`, and the status line leads the content, above it. Draw each placeholder block with a Skeleton of its own; text in the children is read as written.

```svelte
<script lang="ts">
  import { Skeleton } from '@lostgradient/cinder';
</script>

<Skeleton
  delay={300}
  stillLoadingAfter={10000}
  stillLoadingLabel="Still loading Home. This is taking longer than usual."
  onCancel={() => console.log('cancel')}
>
  <p>Monday, Nov 2</p>
  <h2>Needs you</h2>
  <Skeleton height="2.5rem" />
</Skeleton>
```

Both timers start when the Skeleton mounts, so render it only while the request is pending and unmount it when the request settles. Unmounting clears the timers. `stillLoadingAfter` counts from mount, not from the end of `delay`. Without `delay` or `stillLoadingAfter` a Skeleton renders immediately and never shows a status, exactly as a plain block always has.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `action` | `boolean` | no | `false` | Draw a block the size of a small button at the end of each row when `variant` is `'grouped'`, for a grouped list whose rows end in text actions. In a row narrower than 26rem, as on a phone, the block drops under the text at its own width, starting at the text's leading edge, where the real buttons go. Ignored by other variants. |
| `cancelLabel` | `string` | no | `"Cancel"` | Label of the Cancel button in the "Still loading" status. |
| `class` | `string` | no | — | Additional class merged onto the root element: `.cinder-skeleton` for a single block, or `.cinder-skeleton-group` when `lines`, `variant`, or `stillLoadingAfter` render a group. |
| `dayBand` | `boolean` | no | `false` | Draw a day band (a tinted header with one bar) above the rows when `variant` is `'list'`, the placeholder for a list that groups its rows by day. Ignored by other variants. |
| `delay` | `number` | no | `0` | Milliseconds to wait after mounting before anything renders. A load that finishes inside the delay never flashes a placeholder. Use `300` for the Cinder loading rule. |
| `framed` | `boolean` | no | `true` | Draw the list's own border and rounded corners when `variant` is `'list'`. Turn it off inside a card that already frames its rows, so the placeholder does not draw a box within the box. Ignored by other variants. |
| `height` | `string` | no | — | CSS height value applied as an inline style on the skeleton block (e.g. `'1rem'`, `'48px'`). |
| `label` | `string` | no | — | Accessible name of the loading region, announced politely once the placeholder appears (for example `'Loading agents'`). The placeholder bars stay hidden from assistive technology and no spinner is drawn. Applies to the grouped variants; omit it when the surrounding region already says what is loading. |
| `lines` | `number` | no | `1` | Number of text bars to stack. More than one renders a group, and the last bar is shorter unless `width` is set. Clamped to between 1 and 20. |
| `radius` | `string` | no | — | CSS border-radius value applied as an inline style, overriding the default pill shape (e.g. `'4px'`, `'50%'`). |
| `rows` | `number` | no | `3` | Number of fields to draw when `variant` is `'form'`, of list rows when it is `'list'`, and of grouped-list rows when it is `'grouped'`. A list row keeps the 8rem status column reserved, then shows two text bars and a time bar, with no leading circle, so nothing shifts when data arrives. Clamped to between 1 and 20. Ignored by other variants. |
| `statusColumn` | `boolean` | no | `true` | Keep the 8rem status column that every status-first list shares when `variant` is `'list'`. Turn it off for a list whose rows do not lead with a status word, such as a card of problems with a glyph and an action: the marker then sits right before the text, so the placeholder matches the row it stands for. Ignored by other variants. |
| `statusMarker` | `"bar"` \| `"dot"` | no | `"bar"` | What fills the status column of each row when `variant` is `'list'`. `'bar'` is a short bar where the status word reads; `'dot'` is a small circle where the status dot sits. The column keeps its width either way, so nothing shifts when data arrives. Ignored by other variants. |
| `stillLoadingAfter` | `number` | no | — | Milliseconds after mounting at which a "Still loading" status replaces silence, with a Cancel button when `onCancel` is set. Counted from mount, not from the end of `delay`. Use `10000` for the Cinder loading rule. Omit to never show the status. |
| `stillLoadingLabel` | `string` | no | `"Still loading. This is taking longer than usual."` | Text of the "Still loading" status. Pages replace the default with their own noun, for example `'Still loading runs. This is taking longer than usual.'`. |
| `variant` | `"row"` \| `"card"` \| `"list"` \| `"grouped"` \| `"form"` | no | `"row"` | Shape of the group. `'row'` stacks the bars directly; `'card'` wraps a heading bar and the `lines` bars in a bordered card; `'list'` draws `rows` status-first list rows; `'grouped'` draws `rows` grouped-list rows; `'form'` draws `rows` fields, a label bar over a control bar each. |
| `width` | `string` | no | — | CSS width value applied as an inline style on the skeleton block (e.g. `'200px'`, `'100%'`). |
| `children` | `(opaque)` | no | — | The page's own placeholder, drawn instead of the bars, for a loading state whose shape is a whole page (real labels and headings with placeholder values and rows). The group still owns the timing: nothing is drawn until `delay` has passed, and the "Still loading" status leads the content, above it, after `stillLoadingAfter`. The group is marked busy while it shows. Draw each placeholder block with a `Skeleton` of its own; the content is not hidden from assistive technology, so text in it is read as written. Not expressible in JSON Schema; see the component types for the signature. |
| `onCancel` | `(opaque)` | no | — | Called when the Cancel button in the "Still loading" status is pressed. The button renders only when this is set. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
