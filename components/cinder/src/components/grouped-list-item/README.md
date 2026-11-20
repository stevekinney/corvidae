# GroupedListItem

<!-- generated:a11y-record:required -->

`GroupedListItem` is one row of a `GroupedList`. It has a leading slot (an icon, a 40 to 72px thumbnail, an avatar or a checkbox), a fixed `lead` column for a time or number, a title, a subtitle, a trailing photo, a trailing value, a chevron, an action and text actions. With `href` the whole row is the link, and rows have hover and selected fills. The action sits in a fixed-width column, so a badge or value never moves the click target. A status is a small dot plus a word in the subtitle.

## Usage

```svelte
<script lang="ts">
  import { GroupedList, GroupedListItem } from '@lostgradient/cinder';
</script>

<GroupedList header="Runs">
  <GroupedListItem href="/runs/1">
    {#snippet lead()}45 min left{/snippet}
    {#snippet title()}Nightly backup{/snippet}
    {#snippet subtitle()}Running{/snippet}
  </GroupedListItem>
</GroupedList>
```

## Text actions

Pass `actions` for a row whose button is its point, such as Review on an approval waiting on you. Each action is a secondary small button, or a link drawn as one when it has `href`, at the end of the row and above the row's own link. The row measures its own width: narrower than 26rem, as on a phone, the actions leave the end of the row for a line of their own under the text, each at its own width from the text's leading edge, each a 44px target under a coarse pointer; they never fold into a menu. A disabled action stays focusable with `aria-disabled`, says its `disabledReason` as its description, and does nothing when chosen. `changes` marks one that changes something (`data-changes`), so an application that holds such controls while its server does not answer holds it too. A status goes at the start of the subtitle as a `StatusDot` with its word, never in a column of its own.

```svelte
<script lang="ts">
  import { GroupedList, GroupedListItem } from '@lostgradient/cinder';
</script>

<GroupedList aria-label="Reviews waiting on you">
  <GroupedListItem actions={[{ label: 'Review', href: '/reviews/7', changes: true }]}>
    {#snippet title()}Refund order 4471 for $42.00?{/snippet}
    {#snippet subtitle()}Approval, Tool runner, waiting 2 h{/snippet}
  </GroupedListItem>
</GroupedList>
```

## Time-led rows

Pass `timeWindow` instead of a `lead` snippet for a row led by time, such as a happy hour or a run that is about to start. The lead is the window itself, such as `3–6 pm`, `10 pm–1 am` or `All day`: one line, right-aligned, bold and tabular, in a fixed column that holds `11 pm–2 am` without wrapping. The window leads the row. At widths of 26rem and up, it uses a 112px column and sits two type sizes above the name. On narrower rows, it uses a 100px column and sits one type size above the name. `timeCaption` is a small muted line under it and free text: `45 min left`, `1 h 45 min left`, `starts in 1 h`, `Sun to Tue`, or nothing, when the page heading already names the day, and then the lead draws no empty line. `urgency="urgent"` colours only the caption in the warning text colour, and the window stays the default text colour; `urgency="soon"` draws the window muted. Use `urgent` only for a window that ends within 15 minutes; a row with 45 minutes left is plain. The title and subtitle are the basic row's: the title wraps, and the subtitle is muted, one line per item. A trailing value carries a distance or other meta. `staleAge` draws a gray clock and a short age, and only when the row is stale. A trailing `photo` is a 56px column at the end of the row, after the trailing value, and reserves no space when absent: nothing else in the row moves when a photo is there.

The name leads. In a row at least 26rem wide the name keeps at least 10rem, and a trailing value that would leave it less moves to a line of its own under it, at the end. In a row narrower than 26rem, as on a phone, the trailing value sits at the end of the title's line instead of in a column of its own, and the subtitle takes the width under both, so a long subtitle uses the whole text column; the value is capped at 6rem and wraps inside it. A time-led row with no trailing value takes the same narrow form, so its stale marker and chevron stay on the title's line.

```svelte
<script lang="ts">
  import { GroupedList, GroupedListItem } from '@lostgradient/cinder';
</script>

<GroupedList header="Open now">
  <GroupedListItem
    href="/places/rooftop"
    timeWindow="3–6 pm"
    timeCaption="12 min left"
    urgency="urgent"
  >
    {#snippet title()}The Rooftop{/snippet}
    {#snippet subtitle()}Half-price wells{/snippet}
    {#snippet trailing()}0.4 mi{/snippet}
  </GroupedListItem>
</GroupedList>
```

## Clamped text and recent activity

`titleLines` and `subtitleLines` (`1` or `2`) hold the title and the subtitle to at most that many lines at every width, each ending in an ellipsis; left unset, the text wraps unclamped. The clamp is visual only, so the whole text stays in the document and in the row's accessible text. Pass the full text as `tooltip` and `subtitleTooltip`: the row draws them as one native tooltip on the row itself (the title, a line break, then line two), never one per line, because a linked row's link covers every line and a tooltip on line two could never be reached. The tooltip is on the `li`, not the link, so it adds nothing to the link's description and no focus stop.

A leading icon sits on the title's first line at every width, beside the trailing value and the chevron, so a row whose text runs to several lines never centres its glyph. Narrower than 26rem, a linked row's chevron is pinned to the title's first line at the content's inline end: its column is reserved, the title and the trailing value measure against what is left, a value too long to fit beside 5rem of title drops to a line of its own, and the subtitle runs under the chevron's column to the content's edge. The pinned chevron takes no pointer, so a press on it opens the row; a suggested row, and one led by an avatar or a thumbnail, keeps its chevron in the flow, since its title does not start at the top of its content. `chevronColumn` keeps that column on a row with no link, at every width, so the times of a list that mixes linked and unlinked rows end on one edge. `arriving` fades a row in over the fast duration when it arrives in a live list; reduced motion shows it at once.

A recent-activity summary on an overview page is a `GroupedList` of these rows: a glyph for the kind of event, the title, a `StatusDot` word for a warning or critical event at the start of line two, and the time as the trailing value. A full history or audit page stays a `Timeline`.

```svelte
<script lang="ts">
  import { GroupedList, GroupedListItem, StatusDot } from '@lostgradient/cinder';
  import { Activity } from '@lucide/svelte';
</script>

<GroupedList aria-label="Recent workflow activity">
  <GroupedListItem
    href="/runs/7"
    titleLines={2}
    subtitleLines={2}
    tooltip="Run failed"
    subtitleTooltip="Critical, Release notes digest stopped at step 3"
  >
    {#snippet leading()}<Activity aria-hidden="true" size={16} />{/snippet}
    {#snippet title()}Run failed{/snippet}
    {#snippet subtitle()}<StatusDot word="Critical" />, Release notes digest stopped at step 3{/snippet}
    {#snippet trailing()}<time datetime="2026-11-02T16:42:00.000Z">10:42 AM</time>{/snippet}
  </GroupedListItem>
  <GroupedListItem chevronColumn titleLines={2} tooltip="Worker connected">
    {#snippet leading()}<Activity aria-hidden="true" size={16} />{/snippet}
    {#snippet title()}Worker connected{/snippet}
    {#snippet trailing()}<time datetime="2026-11-02T16:40:00.000Z">10:40 AM</time>{/snippet}
  </GroupedListItem>
</GroupedList>
```

## Suggested rows

`suggested` marks a row the product drafted that is not saved until the person confirms it. The row says so in words: a quiet "Suggested" label in the accent text colour on a line above the title, which `suggestedLabel` can change, for example to "Suggested wording". The row keeps its own surface: no tint, no dashed or accent border and no pill.

```svelte
<script lang="ts">
  import { GroupedList, GroupedListItem } from '@lostgradient/cinder';
</script>

<GroupedList header="Next actions">
  <GroupedListItem suggested>
    {#snippet title()}Call the landlord about the lease{/snippet}
    {#snippet subtitle()}Drafted from your note{/snippet}
  </GroupedListItem>
</GroupedList>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `arriving` | `boolean` | no | `false` | Fades the row in over the fast duration when it is drawn, for a row that has just arrived in a live list. With reduced motion it appears at once. |
| `chevron` | `boolean` | no | — | Draws a trailing chevron. Left unset, a row with `href` draws one. |
| `chevronColumn` | `boolean` | no | `false` | Keeps the chevron's column on a row that draws no chevron, as reserved space at the end of its content at every width, so the trailing values that share their title's first line end on one edge in a list that mixes linked and unlinked rows. |
| `class` | `string` | no | — | Custom class merged with `.cinder-grouped-list-item`. |
| `href` | `string` | no | — | Makes the whole row a link to this address. |
| `leadingKind` | `"icon"` \| `"avatar"` \| `"media"` \| `"control"` | no | `"icon"` | What the leading slot holds. |
| `rel` | `string` | no | — | The link's relationship; `noopener noreferrer` is added for `_blank`. |
| `selected` | `boolean` | no | `false` | Marks the row as the current one with a tint. |
| `staleAge` | `string` | no | — | A short age, such as `3d`, drawn with a gray clock before the trailing value. Give it only when the row's information is stale; a fresh row draws no marker. |
| `subtitleLines` | `1` \| `2` | no | — | The most lines the subtitle takes, at every width, before it ends in an ellipsis. Left unset, the subtitle wraps unclamped. |
| `subtitleTooltip` | `string` | no | — | The subtitle's full text, the second line of the row's one native tooltip (see `tooltip`). |
| `suggested` | `boolean` | no | `false` | Marks the row as a suggestion that is not saved until the person confirms it: a quiet accent text label on a line above the title, with no tint, border or pill. |
| `suggestedLabel` | `string` | no | `"Suggested"` | The words of the suggested label, such as "Suggested wording". Used with `suggested`. |
| `target` | `string` | no | — | Where to open the link. |
| `timeCaption` | `string` | no | — | Free text in a small line under the time window, such as `45 min left`, `starts in 1 h` or `Sun to Tue`. Leave it out and the lead draws no empty line. Used with `timeWindow`. |
| `timeWindow` | `string` | no | — | The time window a time-led row leads with, such as `3–6 pm`, `10 pm–1 am` or `All day`, drawn right-aligned, bold and tabular on one line on the title's first line. Ignored when a `lead` snippet is given. |
| `titleLines` | `1` \| `2` | no | — | The most lines the title takes, at every width, before it ends in an ellipsis. Left unset, the title wraps unclamped. The whole title stays in the document and in the row's accessible text; pass `tooltip` so a pointer can read what the clamp cut. |
| `tooltip` | `string` | no | — | The full title as text. With `subtitleTooltip` it is the row's one native tooltip, on the row itself rather than on a line, so a pointer reads it anywhere on a linked row: the title, a line break, then the subtitle's text. |
| `urgency` | `"urgent"` \| `"soon"` | no | — | How pressing the row is. `urgent` draws only the caption in the warning text colour and `soon` mutes the window; left unset, both use their default colours. Used with `timeWindow`. |
| `action` | `(opaque)` | no | — | A trailing action such as a menu button. It sits in a fixed-width column, so a changing value never moves its click target. Not expressible in JSON Schema; see the component types for the signature. |
| `actions` | `(opaque)` | no | — | Text actions at the end of the row, each a secondary small button (a link drawn as one when it has `href`), for a row whose action is the point of the row, such as a review waiting on you. They sit above the row's own link. In a row narrower than 26rem, as on a phone, they leave the end of the row for a line of their own under its text, each at its own width from the text's leading edge, never collapsing into a menu, each a 44px target under a coarse pointer. Not expressible in JSON Schema; see the component types for the signature. |
| `lead` | `(opaque)` | no | — | A fixed-width column for a time or number, such as "45 min left", drawn before the title. Rows in one list line up. Not expressible in JSON Schema; see the component types for the signature. |
| `leading` | `(opaque)` | no | — | A leading icon, thumbnail, avatar or control, drawn before the text. Not expressible in JSON Schema; see the component types for the signature. |
| `photo` | `(opaque)` | no | — | A trailing 56px photo. It reserves no space when absent. Not expressible in JSON Schema; see the component types for the signature. |
| `subtitle` | `(opaque)` | no | — | A secondary line under the title, in muted text. A status is a small dot plus a word here, never a badge. Not expressible in JSON Schema; see the component types for the signature. |
| `title` | `(opaque)` | yes | — | The row's main text. With `href`, it becomes the link and the whole row is its target. Not expressible in JSON Schema; see the component types for the signature. |
| `trailing` | `(opaque)` | no | — | A trailing value, such as a count or a short status. It is right-aligned and never moves the action column. Not expressible in JSON Schema; see the component types for the signature. |

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
