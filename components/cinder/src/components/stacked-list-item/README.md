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
- **line two**: muted `meta`, kind first, then agent, then detail. Its pieces are told apart by a space and a step, never by a comma or a dot, and never as a bare run of words in one weight and one colour: the status word is semibold beside the muted line, and inside the line each piece is its own element (an identifier in a `Text` of `variant="code"`, a reason in a tone) so a piece that stands apart takes a step in face, weight or colour. It starts under the title, not under the status, and ends in an ellipsis rather than wrapping.

The column is the same 128px on every page, so titles start at one x position down the list. The dot and word sit on the baseline of the first line of the title and the time shares that baseline, so both stay beside the first line when a title clamps to two lines with an ellipsis. Pass `tooltip` with the title's text so the full title is the row's tooltip.

```svelte
<script lang="ts">
  import { DataList, StackedListItem, StatusDot, Text } from '@lostgradient/cinder';

  const runs = [
    {
      id: 'a',
      title: 'Refund order 4471',
      status: 'Waiting on you',
      time: '10:42 AM',
      kind: 'Chat',
      agent: 'tool-runner',
      wait: 'waiting 4 min',
    },
    {
      id: 'b',
      title: 'Say hello',
      status: 'Done',
      time: '4:12 PM',
      kind: 'Chat',
      agent: 'assistant',
      wait: '8 s',
    },
  ];
</script>

<DataList items={runs} key={(run) => run.id}>
  {#snippet children(run)}
    <StackedListItem href={`/runs/${run.id}`} tooltip={run.title}>
      {#snippet status()}<StatusDot word={run.status} />{/snippet}
      {#snippet title()}{run.title}{/snippet}
      {#snippet time()}{run.time}{/snippet}
      <!-- Each piece is its own element, a space apart, and the identifier steps in face. -->
      {#snippet meta()}{run.kind}
        <Text as="span" variant="code">{run.agent}</Text>
        {run.wait}{/snippet}
    </StackedListItem>
  {/snippet}
</DataList>
```

Pieces of line two need a step, never a bare run of words: `Chat tool-runner waiting 4 min` is three pieces, and the middle one is set apart by its monospace face. Words in one weight and one colour with only spaces between them read as one sentence, so give each piece that should read on its own an element of its own and a step.

A row with nothing to report (a workflow, an available agent) keeps the column's width and leaves it empty: pass `statusColumn` on the row, or `statusColumn` on the `DataList` to keep it for every row. A leading visual such as an avatar follows the column.

The status column is optional. A row (or a list) that has nothing to say about state leaves out `status` and `statusColumn`, and the row reserves no column, so the title starts at the row's edge; do not add a status only to fill the column. When a row does have a status, the documented form is a `StatusDot` with its word: a neutral dot and a word, with colour kept for a warning or a failure. A tinted Badge or pill is not a row status.

### Phone and the chat list

On a phone (a row narrower than 640px: its own width, not the viewport's, so a 360px pane in a wide window takes it too, and so does any row narrower than 448px, which is inside that range) the status moves to line two beside the kind and agent (`Waiting on you Chat Tool runner`, told apart by weight and colour) and the time stays on line one, so the title keeps the whole first line. The word and dot are unchanged, and a row with no status simply has none. The status word is never cut. The time stays on one line, beside a group row's Show as well, unless the two cannot fit together (200% text on a phone), when Show drops whole to its own line under the time rather than push the row past the page; only a row with a control at its end (a hook's switch) lets its time give way before its title. Pass that time as a string: the row draws its day over its clock ("Yesterday," over "6:00 PM", breaking only after the comma, never inside the day or the clock), and the time's column is exactly its widest line, so the title takes the rest. A time passed as a snippet stays on one line.

A list that fills the page's content column follows the window instead: pass `phoneWidth="viewport"` and its rows take the phone form only while the viewport is narrower than 640px, so a tablet whose navigation rail leaves each row a little under 640px still leads with the status column (the Runs list).

A row whose line two is too long for a phone passes `metaCompact` as well as `meta`: on a phone the compact words are line two in place of `meta` (the missed runs' `Schedule since Oct 30` for the wide line that ends `missed 4 times since Oct 30`), and only one of the two is ever drawn, so line two is read once. Keep `metaTooltip` the whole line. With `wrapMeta` the status leads the compact line, once, and the time and a group row's Show stay on line one.

The chat list is a recorded exception on every width, because its pane is too narrow for a leading column. Pass `statusPlacement="line-two"`: line one is the bold title with the time, and line two is the status in a fixed-width column, then a one-line preview, so previews line up. Pass `titleLines={1}` there so a long title truncates with an ellipsis. On a phone the chat list's status gives up its fixed column as well: line two reads the word, a space, then the preview (`Waiting on you I found order 4471…`, told apart by weight and colour), and the title clamps at two lines (`titleLines={2}`).

### A mark after the title

Pass `badge` for a short mark after the title, such as a neutral extra-small `Badge` reading "Plugin" on a hook a plugin made. It sits 6px after the title on the first line's baseline, outside the title's clamp: the title gives up its room and ends in an ellipsis first, and the mark is never cut and never takes a line of its own. On a phone the title takes one line with the mark, so the mark always sits right after the last character drawn ("Post settled r… Plugin"), never beside the box of a title that wrapped. The row's `tooltip` stays the whole title. Draw the mark only on the rows it marks: a row with no `badge` keeps its title as it was.

### A third line

Line two ends in an ellipsis, so a reason that must never be cut cannot live there on a narrow screen. Pass `detail` for a third line that wraps and is never cut: a schedule's phone row says what it is on line two (the status word `Active`, semibold, then `Workflow`, then the identifier `order-refund` in its monospace face, then `Tool runner`: pieces a space apart, each stepped from the one before) and the reason it will not run first on the third, with the cadence last (`Order refund can't load, won't run until a provider is connected, Mondays at 11:00 AM`). The line starts under the title, or at the left edge under the status on a phone, and a page passes it only where it wants it.

```svelte
<StackedListItem href="/schedules/weekly-refund-audit">
  {#snippet status()}<StatusDot word="Active" />{/snippet}
  {#snippet title()}Weekly refund audit{/snippet}
  {#snippet time()}Next today 11:00 AM{/snippet}
  {#snippet meta()}Workflow <Text as="span" variant="code">order-refund</Text> Tool runner{/snippet}
  {#snippet detail()}Order refund can't load, won't run until a provider is connected, Mondays at
    11:00 AM{/snippet}
</StackedListItem>
```

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

Line two ends in an ellipsis when it is long. Pass `metaTooltip` with the same text to carry it in full as a tooltip over the line, as `tooltip` does for the title. On a linked row the title link's cover lies over every line, so a tooltip on line two could never be reached: a linked row draws one native tooltip on the row itself instead (the title, a line break, then line two) and none on its lines, and line two is never raised above the cover, so a click on it follows the link. The tooltip is on the row, not the link, so it adds nothing to the link's description. A row with no link keeps one tooltip per line.

### A leading checkbox

A row that leads with a [`Checkbox`](../checkbox/README.md) in `leading` aligns the box to the first line of the title, not the row's top edge or its middle: the box's centre meets the centre of that line, whether the title takes one line or two, and the same rule holds for the two-line row. Pass the checkbox without a `label`, so the title is the row's text, and give it an `aria-label` that names the row. A checkbox that leads a task list can take `variant="task"`.

```svelte
<StackedListItem>
  {#snippet leading()}<Checkbox variant="task" aria-label="Send the quarterly report" />{/snippet}
  {#snippet title()}Send the quarterly report{/snippet}
</StackedListItem>
```

### Glyph tile

Pass `leadingTone` to draw `leading` as a 32px rounded tile tinted with that tone, one glyph per kind (the needs-attention rows on Health use `warning`). The glyph is decoration and is hidden from assistive technology. Pass `lines` to take the two-line layout (bold title, one-line muted description, a trailing region beside both lines) on a row that has no status, time or details; add `actions` for a secondary button per action.

### Trailing actions

Pass `actions` for trailing text buttons (Memory and New chat on Agents). Each is a secondary small button on a tablet or desktop; below 640px of row width two or more collapse into one menu button ("More actions", drawn at the compact height of a small Button, with a 44px touch target under a coarse pointer) with the same actions, and a single action stays its own compact secondary button, never a menu of one. A disabled action keeps `aria-disabled` and stays focusable, with `disabledReason` as its description and tooltip, in the menu too.

Trailing actions sit in a fixed column. The trailing region is the row's last grid column and is only as wide as its actions, so they sit against the row's end edge whatever the body holds. A status badge or other metadata in the body can lengthen or shorten the text beside the actions, and it never changes where an action button lands, because the body column takes the slack. Keep it that way: put a badge with the metadata in the content column (`meta`, `description` or the status cell), never inside `trailing` or `actions`, where it would take width from the buttons and move them from one row to the next. A list whose rows carry a figure in `trailing` (a cost, a count) sets `--cinder-stacked-list-item-trailing-track` on the list to the width of its widest figure, so the track is the same in every row, with or without a trailing region, and the times before it end at one edge; it sets `--cinder-stacked-list-item-trailing-align: baseline` to hold the figure on the first line's baseline. Without them each row sizes the track by its own content and centers the region on both lines. Set them only for the widths where the row keeps its trailing column. Below 448px of row width the trailing region drops under the body, or collapses to one menu button, on every row alike; one marked `trailingGlyph`, such as a chevron, stays beside the body.

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
| `phoneActions` | `"menu"` \| `"buttons"` | no | — | What `actions` become on a phone: one menu button (`'menu'`, the default) or full-width buttons stacked under the row's text (`'buttons'`), each a 44px target under a coarse pointer. |
| `phoneWidth` | `"row"` \| `"viewport"` | no | — | Which width decides the row's phone form: the row's own (`row`, the default) or the window's (`viewport`), each below 640px. Pass `viewport` on the rows of a list that fills the page's content column, so a tablet with a navigation rail keeps the leading status column. |
| `rel` | `string` \| `null` | no | — | `rel` attribute forwarded to the title anchor; `noopener noreferrer` is merged automatically when `target="_blank"`. |
| `retryLabel` | `string` | no | — | Text of the error's retry button. Default `Try again`. |
| `selected` | `boolean` | no | — | Marks the row as the one open in the detail beside the list. It takes an accent tint, which stays when the pointer is over it, and sets `aria-current` on the row's link (or on the row when it is not a link). |
| `statusColumn` | `boolean` | no | — | Keep the status column's width even when this row has no `status` (a workflow or an agent with nothing to report), so titles line up. Inherits the enclosing DataList's `statusColumn`. Setting it on a row that has a `status` has no effect. |
| `statusPlacement` | `"leading"` \| `"line-two"` | no | — | Where the status sits. Default `leading`. |
| `titleLines` | `1` \| `2` | no | — | How many lines the title may take before an ellipsis. Default `2`; the status and the time stay beside the first line, and the full title is the row's `tooltip`. A title never grows a row without bound, and an unbroken value (an identifier) wraps anywhere. |
| `tone` | `"neutral"` \| `"warning"` | no | — | The tint of a group row. Default `neutral`, the inset tint every group row has; `warning` is the amber band of the missed runs. |
| `tooltip` | `string` | no | — | The full title as text, shown as the row's tooltip when the title is clamped. Set it to the same text the `title` snippet renders. |
| `trailingGlyph` | `boolean` | no | — | Marks `trailing` as a non-interactive glyph, such as a chevron. Below 448px of row width a glyph stays beside the body, as the phone menu button does, where trailing actions drop under it. Default `false`. |
| `wrapMeta` | `boolean` | no | — | Lets line two wrap onto more lines instead of ending in an ellipsis, so a control in it (a "View payload" link after a sentence about why a task failed) is never cut off and can always be pressed. Default `false`. |
| `actions` | `(opaque)` | no | — | Text actions at the end of the row. On a tablet or desktop each is a secondary small button; on a phone (below 640px) two or more collapse into one menu button with the same actions, and a single action stays its own compact secondary button. Either is a 44px target under a coarse pointer. Not expressible in JSON Schema; see the component types for the signature. |
| `badge` | `(opaque)` | no | — | A short mark after the title, such as a neutral extra-small `Badge` reading "Plugin". It sits 6px after the title, outside the title's line clamp: the title gives up its room and ends in an ellipsis first, and the mark is never cut and never takes a line of its own. Not expressible in JSON Schema; see the component types for the signature. |
| `description` | `(opaque)` | no | — | Secondary description below the title. Not expressible in JSON Schema; see the component types for the signature. |
| `detail` | `(opaque)` | no | — | A third line under line two that wraps instead of ending in an ellipsis, so nothing on it is ever cut. A schedule row on a phone puts the reason it won't run first and the cadence last on it; the cadence is the part a narrow screen can lose, so it is the last thing the line says. It starts under the title, and is not drawn on a row with `details`. Not expressible in JSON Schema; see the component types for the signature. |
| `details` | `(opaque)` | no | — | Turns the row into a collapsed group row (the missed runs on Runs): a "Show" / "Hide" button at the right of line one reveals this snippet beneath the row, aligned with the title. A group row is not a link. Not expressible in JSON Schema; see the component types for the signature. |
| `leading` | `(opaque)` | no | — | Leading visual (avatar, icon, status dot). With a status column it follows the column. Not expressible in JSON Schema; see the component types for the signature. |
| `meta` | `(opaque)` | no | — | Line two: muted metadata, kind first, then agent, then detail. Pieces are told apart by a space and a step, never by a comma or a dot, and never as a bare run of words in one weight and one colour: each piece is its own element, and a piece that stands apart takes a step in face, weight or colour (the status word is semibold beside the muted line; inside the line, an identifier in a `Text` of `variant="code"`, or a reason in a tone). It starts under the title (not under the status) and ends in an ellipsis rather than wrapping. A line that must carry a control (an error with its own "Try again") may put one in. Not expressible in JSON Schema; see the component types for the signature. |
| `metaCompact` | `(opaque)` | no | — | Line two on a phone, in place of `meta`: the few words a narrow row has room for (the missed runs' "Schedule since Oct 30" for the wide "Schedule Assistant every day at 3:00 AM missed 4 times since Oct 30"). Only one of the two is drawn, so a screen reader reads line two once; keep `metaTooltip` the whole line. With `wrapMeta` the status leads it, once, on line two, and the time and a group row's disclosure stay on line one. Not expressible in JSON Schema; see the component types for the signature. |
| `onRetryClick` | `(opaque)` | no | — | Called when the row's "Try again" button is chosen. Without it the error shows no button. Not expressible in JSON Schema; see the component types for the signature. |
| `status` | `(opaque)` | no | — | The row's status: a `StatusDot` with its word. It leads the row in a fixed 128px column that every list on every page shares, so titles start at one x position down the list; on a phone it moves to line two, before the meta, followed by a space unless the snippet drew nothing. The dot and word sit on the first line of the title. The column is optional: a row with no `status` (and no `statusColumn`) reserves none. A dot with its word is the documented row status; a tinted Badge or pill is not. Not expressible in JSON Schema; see the component types for the signature. |
| `target` | `(opaque)` | no | — | Browsing context for the title anchor (`_blank`, `_self`, `_parent`, `_top`, or a named frame). Not expressible in JSON Schema; see the component types for the signature. |
| `time` | `(opaque)` | no | — | The time, or the next run, at the right edge of line one, aligned to its top. Pass a `RelativeTime` or a plain string. A string keeps its day and its clock each whole: on a phone row with a control at its end, "Yesterday, 6:00 PM" breaks only after the comma. Not expressible in JSON Schema; see the component types for the signature. |
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
