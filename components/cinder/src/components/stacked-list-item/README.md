# StackedListItem

Single row within a stacked list, typically pairing a label with metadata or an action. It is also the status-first two-line row that every list page shares.

## Usage

```svelte
<script lang="ts">
  import { DataList } from '@lostgradient/cinder';
  import { StackedListItem } from '@lostgradient/cinder';

  const members = [{ id: 'alice', name: 'Alice Chen', role: 'Engineer' }];
</script>

<DataList items={members} key={(member) => member.id}>
  {#snippet children(member)}
    <StackedListItem>
      {#snippet title()}{member.name}{/snippet}
      {#snippet meta()}{member.role}{/snippet}
    </StackedListItem>
  {/snippet}
</DataList>
```

## Status-first two-line row

Pass `status` (a [`StatusDot`](../status-dot/README.md) with its word), `time`, and `meta` to draw the row the list pages share:

- **line one**: the status dot and word in a fixed 128px leading column, a bold title, and the time right-aligned at the edge;
- **line two**: muted `meta`, kind first, then agent, then detail, joined by middots. It starts under the title, not under the status, and ends in an ellipsis rather than wrapping.

The column is the same 128px on every page, so titles start at one x position down the list. The dot and word sit on the baseline of the first line of the title and the time shares that baseline, so both stay beside the first line when a title clamps to two lines with an ellipsis. Pass `tooltip` with the title's text so the full title is the row's tooltip.

```svelte
<script lang="ts">
  import { DataList, StackedListItem, StatusDot } from '@lostgradient/cinder';

  const runs = [
    {
      id: 'a',
      title: 'Refund order 4471',
      status: 'Waiting on you',
      time: '10:42 AM',
      kind: 'Chat · Tool runner · waiting 4 min',
    },
    {
      id: 'b',
      title: 'Say hello',
      status: 'Done',
      time: '4:12 PM',
      kind: 'Chat · Assistant · 8 s',
    },
  ];
</script>

<DataList items={runs} key={(run) => run.id}>
  {#snippet children(run)}
    <StackedListItem href={`/runs/${run.id}`} tooltip={run.title}>
      {#snippet status()}<StatusDot word={run.status} />{/snippet}
      {#snippet title()}{run.title}{/snippet}
      {#snippet time()}{run.time}{/snippet}
      {#snippet meta()}{run.kind}{/snippet}
    </StackedListItem>
  {/snippet}
</DataList>
```

A row with nothing to report (a workflow, an available agent) keeps the column's width and leaves it empty: pass `statusColumn` on the row, or `statusColumn` on the `DataList` to keep it for every row. A leading visual such as an avatar follows the column.

### Phone and the chat list

On a phone (a viewport narrower than 640px) the status moves to line two beside the kind and agent (`Waiting on you · Chat · Tool runner`) and the time stays on line one. The word and dot are unchanged, and a row with no status simply has none.

The chat list is a recorded exception on every width, because its pane is too narrow for a leading column. Pass `statusPlacement="line-two"`: line one is the bold title with the time, and line two is the status in a fixed-width column, then a one-line preview, so previews line up. Pass `titleLines={1}` there so a long title truncates with an ellipsis.

### The whole row is one link

With `href` the title's anchor is stretched over the row, so one click anywhere follows it, hover tints the whole row, and the keyboard focus ring wraps the whole row rather than the title. Anything interactive in `trailing`, `actions`, or a button inside `meta` stays separately usable.

### Long values

A title clamps at two lines (`titleLines`) and an unbroken value, such as a long identifier, wraps anywhere, so no value widens the row past its frame or grows it without bound. This is the default for every row, not a page fix.

### A row that fails

A row that cannot load its details passes `error`: it keeps its status, title and time on line one, and line two says the message beside a warning glyph, in the danger text colour, with the row's own secondary "Try again" button when you pass `onRetryClick` (rename it with `retryLabel`). The rest of the list stays live; there is no banner and no full-page error. A row with an `error` is not a link, and the message replaces `meta`.

```svelte
<StackedListItem error="Couldn't load this run's details." onRetryClick={retry}>
  {#snippet status()}<StatusDot word="Waiting on you" />{/snippet}
  {#snippet title()}Refund order 4471{/snippet}
  {#snippet time()}10:42 AM{/snippet}
</StackedListItem>
```

### Group row

Pass `details` to make a collapsed group row (the missed runs under Today on Runs). The row is not a link: a "Show" / "Hide" button at the right of line one reveals `details` beneath the row, aligned with the title, and `expanded` is bindable. Set `expandLabel` and `collapseLabel` to change the words.

A group row is tinted whether it is open or shut, so it reads as a different kind of row among its neighbours; open, it shows all of line two. Pass `tone="warning"` for the amber of something that did not happen.

Pass `groupLayout="band"` for the missed runs among one schedule's runs: one line with the status dot outside a tinted band that holds a chevron, the bold title, muted text and the toggle label at the right (`expandLabel="Show each"`). The whole band is the button, so a click anywhere on it opens the details.

### Selected row

Pass `selected` for the row open in the detail beside the list (the worker list). It takes an accent tint that stays under the pointer, and sets `aria-current` on the row's link (on the row itself when it is not a link).

### Line two tooltip

Line two ends in an ellipsis when it is long. Pass `metaTooltip` with the same text to carry it in full as a tooltip over the line, as `tooltip` does for the title.

### Glyph tile

Pass `leadingTone` to draw `leading` as a 32px rounded tile tinted with that tone, one glyph per kind (the needs-attention rows on Health use `warning`). The glyph is decoration and is hidden from assistive technology. Pass `lines` to take the two-line layout (bold title, one-line muted description, a trailing region beside both lines) on a row that has no status, time or details; add `actions` for a secondary button per action.

### Trailing actions

Pass `actions` for trailing text buttons (Memory and New chat on Agents). Each is a secondary small button on a tablet or desktop; below 640px they collapse into one menu button ("More actions", 44px under a coarse pointer) with the same actions. A disabled action keeps `aria-disabled` and stays focusable, with `disabledReason` as its description and tooltip, in the menu too.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `actionsLabel` | `string` | no | — | Accessible name of the phone menu button that holds `actions`. Default `More actions`. |
| `class` | `string` | no | — | Merged with `cinder-stacked-list-item`. |
| `collapseLabel` | `string` | no | — | Text of the button that closes a group row. Default `Hide`. |
| `density` | `"comfortable"` \| `"condensed"` | no | — | Density token surfaced as `data-cinder-density`. When omitted, inherits the enclosing DataList's list-level `density` (if any), then falls back to `comfortable`. An explicit value here always overrides the list default. |
| `error` | `string` | no | — | A row whose own details failed to load: line two says this message beside a warning glyph, in the danger text colour, in place of `meta`, and the rest of the list stays live (there is no banner and no full-page error). Pass `onRetryClick` for the secondary "Try again" button that belongs to the row. A row with an `error` is not a link. |
| `expanded` | `boolean` | no | — | Whether a group row's `details` are showing. Bindable; default `false`. |
| `expandLabel` | `string` | no | — | Text of the button that opens a group row. Default `Show`. |
| `groupLayout` | `"row"` \| `"band"` | no | — | How a group row is drawn. Default `row`. |
| `href` | `string` | no | — | Destination URL that turns the `title` snippet into an `<a>` link. The link covers the whole row, so the row is one target: hover tints the whole row and the keyboard focus ring wraps it. Controls inside the row (`actions`, `trailing`, a button in `meta`) stay separately usable. |
| `hreflang` | `string` \| `null` | no | — | `hreflang` attribute forwarded to the title anchor, indicating the language of the linked resource. |
| `leadingTone` | `"neutral"` \| `"info"` \| `"success"` \| `"warning"` \| `"danger"` | no | — | Draws `leading` as a 32px rounded glyph tile tinted with this tone, one glyph per kind (the needs-attention rows on Health use `warning`). The glyph is decoration, so give the tile no accessible name of its own. |
| `lines` | `boolean` | no | — | Draws the two-line layout (bold title, one-line muted description or meta, a trailing region centred beside both lines) for a row that has no status, time or details to trigger it. A row with a `leadingTone` tile and `actions` is the usual case. |
| `metaTooltip` | `string` | no | — | Line two as text, shown as a tooltip over line two, which ends in an ellipsis when it is long. Set it to the same text the `meta` (or `description`) snippet renders. |
| `rel` | `string` \| `null` | no | — | `rel` attribute forwarded to the title anchor; `noopener noreferrer` is merged automatically when `target="_blank"`. |
| `retryLabel` | `string` | no | — | Text of the error's retry button. Default `Try again`. |
| `selected` | `boolean` | no | — | Marks the row as the one open in the detail beside the list. It takes an accent tint, which stays when the pointer is over it, and sets `aria-current` on the row's link (or on the row when it is not a link). |
| `statusColumn` | `boolean` | no | — | Keep the status column's width even when this row has no `status` (a workflow or an agent with nothing to report), so titles line up. Inherits the enclosing DataList's `statusColumn`. Setting it on a row that has a `status` has no effect. |
| `statusPlacement` | `"leading"` \| `"line-two"` | no | — | Where the status sits. Default `leading`. |
| `titleLines` | `1` \| `2` | no | — | How many lines the title may take before an ellipsis. Default `2`; the status and the time stay beside the first line, and the full title is the row's `tooltip`. A title never grows a row without bound, and an unbroken value (an identifier) wraps anywhere. |
| `tone` | `"neutral"` \| `"warning"` | no | — | The tint of a group row. Default `neutral`, the inset tint every group row has; `warning` is the amber band of the missed runs. |
| `tooltip` | `string` | no | — | The full title as text, shown as the row's tooltip when the title is clamped. Set it to the same text the `title` snippet renders. |
| `actions` | `(opaque)` | no | — | Text actions at the end of the row. On a tablet or desktop each is a secondary small button; on a phone (below 640px) they collapse into one menu button with the same actions, which is a 44px target under a coarse pointer. Not expressible in JSON Schema; see the component types for the signature. |
| `description` | `(opaque)` | no | — | Secondary description below the title. Not expressible in JSON Schema; see the component types for the signature. |
| `details` | `(opaque)` | no | — | Turns the row into a collapsed group row (the missed runs on Runs): a "Show" / "Hide" button at the right of line one reveals this snippet beneath the row, aligned with the title. A group row is not a link. Not expressible in JSON Schema; see the component types for the signature. |
| `leading` | `(opaque)` | no | — | Leading visual (avatar, icon, status dot). With a status column it follows the column. Not expressible in JSON Schema; see the component types for the signature. |
| `meta` | `(opaque)` | no | — | Line two: muted metadata, kind first, then agent, then detail, joined by middots. It starts under the title (not under the status) and ends in an ellipsis rather than wrapping. A line that must carry a control (an error with its own "Try again") may put one in. Not expressible in JSON Schema; see the component types for the signature. |
| `onRetryClick` | `(opaque)` | no | — | Called when the row's "Try again" button is chosen. Without it the error shows no button. Not expressible in JSON Schema; see the component types for the signature. |
| `status` | `(opaque)` | no | — | The row's status: a `StatusDot` with its word. It leads the row in a fixed 128px column that every list on every page shares, so titles start at one x position down the list; on a phone it moves to line two, before the meta. The dot and word sit on the first line of the title. Not expressible in JSON Schema; see the component types for the signature. |
| `target` | `(opaque)` | no | — | Browsing context for the title anchor (`_blank`, `_self`, `_parent`, `_top`, or a named frame). Not expressible in JSON Schema; see the component types for the signature. |
| `time` | `(opaque)` | no | — | The time, or the next run, at the right edge of line one, aligned to its top. Pass a `RelativeTime` or a plain string. Not expressible in JSON Schema; see the component types for the signature. |
| `title` | `(opaque)` | yes | — | Primary label. Required. Not expressible in JSON Schema; see the component types for the signature. |
| `trailing` | `(opaque)` | no | — | Trailing region (chevron, action button, dropdown trigger). Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
