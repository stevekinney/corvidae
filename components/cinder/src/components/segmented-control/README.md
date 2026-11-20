# SegmentedControl

Compact segmented selector for a small fixed set of options, including bindable selections and route-backed navigation links.

## Usage

```svelte
<script lang="ts">
  import { Segment } from '@lostgradient/cinder';
  import { SegmentedControl } from '@lostgradient/cinder';
</script>

<SegmentedControl id="view-filter" label="View filter" variant="navigation">
  <Segment href="/costs?source=actual" current>Actual</Segment>
  <Segment href="/costs?source=forecast">Forecast</Segment>
</SegmentedControl>
```

## Width and selection

A SegmentedControl is as wide as its options and no wider: it never stretches to fill a grid cell or a column, and its options never wrap onto a second line. When its options do not fit the room it has, a horizontal control falls back to a stacked radio list, one full-width option per row, so no option is clipped mid-word; it is the attached row again once the room fits them. A `density="toolbar"` control never stacks: a toolbar is one row and owns its own overflow. The arrow keys reach every option in both forms. `fullWidth` is the one explicit opt-in that spans the container.

The selected (or pressed) segment is a raised pill with a 1px ring in the control tier (`--cinder-border-control`), so the selection clears 3:1 against the track in both themes; the `segmented-control:selected-indicator:*` contrast pairings hold it there. The control's height is a Button's painted height for its size at every pointer: a coarse pointer does not draw it 44px tall, and each horizontal option reaches the 44px touch target through a hit area that takes no layout space. A stacked control's rows keep a list row's minimum.

## Overflow to a Select

`overflow="select"` keeps every option on screen when the segments are wider than the room the control has, such as four long choices on a phone. The control then draws the same options as a `Select` with the same accessible name, the same value and the same change callback, and returns to the strip when the room is there again. The strip stays in the document, out of sight and out of reach (`aria-hidden`, `inert`), so the control knows how wide the segments are by themselves and the choice never flips back and forth on its own: it measures the strip against the room its parent gives it, and showing the Select changes neither. It applies to a single-choice `radiogroup`; a tab list, a navigation and a multiple selection ignore it, because each is something a Select does not hold. Without the prop (`scroll`, the default) a control that does not fit scrolls sideways, as before.

```svelte
<script lang="ts">
  import { Segment, SegmentedControl } from '@lostgradient/cinder';
</script>

<SegmentedControl id="then" label="Then" value="webhook" overflow="select">
  <Segment value="webhook">Send a webhook</Segment>
  <Segment value="workflow">Start a workflow</Segment>
  <Segment value="notify">Notify me</Segment>
  <Segment value="plugin">Run an action from a plugin</Segment>
</SegmentedControl>
```

## Counts

A `Segment` takes a `count`, drawn after its label in a muted, tabular figure ("Waiting on you 2"). The count is part of the segment's accessible name ("Waiting on you, 2"), and zero still shows ("Running 0"). Only `undefined` hides it.

```svelte
<script lang="ts">
  import { Segment, SegmentedControl } from '@lostgradient/cinder';
</script>

<SegmentedControl id="status" label="Status" selectionMode="single" value="all">
  <Segment value="all" count={19}>All</Segment>
  <Segment value="waiting" count={2}>Waiting on you</Segment>
</SegmentedControl>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class names merged with `.cinder-segmented-control`. |
| `density` | `"toolbar"` | no | — | Opt the control into compact toolbar sizing so it lines up cleanly with sibling `Button` (size="sm"), `Chip` (density="toolbar"), and other toolbar elements. Toolbar density resolves to the compact `"sm"` font and padding scale — when set, any explicit `size` value is ignored and the resolved size (`data-cinder-size`) is `"sm"`, so the control's outer height is `--cinder-control-height-sm` and matches sibling toolbar controls. |
| `description` | `string` | no | — | Helper text under the control, wired into the group's `aria-describedby`. |
| `detached` | `boolean` | no | — | Render segments as detached individual buttons instead of a unified strip. |
| `disabled` | `boolean` | no | — | Disable the whole control. |
| `error` | `string` | no | — | Validation error under the control, with a warning glyph; sets `aria-invalid="true"` on the group. |
| `fullWidth` | `boolean` | no | — | Stretch the control to fill available width. |
| `id` | `string` | yes | — | Unique identifier for the control. |
| `label` | `string` | yes | — | Accessible label for the group. |
| `labelVisible` | `boolean` | no | `true` | Whether the label is visibly rendered. Set `false` to visually hide it while keeping it available to assistive technology. |
| `name` | `string` | no | — | Native form field name. Renders hidden input(s) carrying the selected value(s). |
| `note` | `string` | no | — | Neutral explanation under the helper text, wired into `aria-describedby`. Not an error and not a warning. |
| `orientation` | `"horizontal"` \| `"vertical"` | no | — | Layout orientation. |
| `overflow` | `"scroll"` \| `"select"` | no | `"scroll"` | What the control does when its segments are wider than the room it has (COR-2181). `scroll` (the default) keeps the strip and lets it scroll sideways, as it always has. `select` draws the same options as a Select with the same accessible name, so every option stays on screen on a phone; the segments stay in the document, hidden, so the control knows how much room they need and returns to the strip when the room is there. It applies to a single-choice `radiogroup` only. |
| `selectionMode` | `"single"` \| `"multiple"` | no | — | Selection mode. `"single"` allows exactly one segment to be selected at a time; `"multiple"` allows any number of segments to be selected simultaneously. Default `"single"`. |
| `selectionRequired` | `boolean` | no | `true` | When true, clicking the already-selected option is a no-op. When false, clicking the selected option clears value to undefined. |
| `size` | `"sm"` \| `"md"` \| `"lg"` | no | — | Requested visual size of the control. Defaults to `"md"`. The control's outer height is the shared `--cinder-control-height-*` step for the size (`sm` 28px, `md` 32px, `lg` 40px), the same as a Button or Input of that size. The resolved size is reflected as `data-cinder-size` on the root; when `density="toolbar"` is set, the resolved size is forced to `"sm"` and any explicit `size` value is ignored. `size="md"` option text uses `--cinder-text-sm`; `size="sm"` and `density="toolbar"` use `--cinder-text-xs`; `size="lg"` uses `--cinder-text-sm`. |
| `variant` | `"radiogroup"` \| `"tablist"` \| `"navigation"` | no | — | ARIA interaction pattern. Use `navigation` for route-backed links. |
| `children` | `(opaque)` | yes | — | Child `<Segment>` elements. Not expressible in JSON Schema; see the component types for the signature. |
| `errorAction` | `(opaque)` | no | — | Rendered after the error message inside the same live region, such as a quiet "Try again". Not expressible in JSON Schema; see the component types for the signature. |
| `onValueChange` | `(opaque)` | no | — | Called when the selected value changes (single mode only). Not expressible in JSON Schema; see the component types for the signature. |
| `value` | `(opaque)` | no | — | Currently selected value. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
