# GroupedListItem

<!-- generated:a11y-record:required -->

`GroupedListItem` is one row of a `GroupedList`. It has a leading slot (an icon, a 40 to 72px thumbnail, an avatar or a checkbox), a fixed `lead` column for a time or number, a title, a subtitle, a trailing photo, a trailing value, a chevron and an action. With `href` the whole row is the link, and rows have hover and selected fills. The action sits in a fixed-width column, so a badge or value never moves the click target. A status is a small dot plus a word in the subtitle.

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

## Time-led rows

Pass `leadValue` and `leadUnit` instead of a `lead` snippet for a row led by time, such as a happy hour or a run that is about to start. The lead is a fixed 72px column, right-aligned, with a 24px tabular number and a 12px unit. The unit comes from a closed vocabulary: `min left`, `left`, `min to go`, `starts`, or a weekday (`Mon` to `Sun`). A range of times never goes in the lead; put it in the subtitle. `urgency="urgent"` draws the lead in the warning text colour and `urgency="soon"` mutes it. The name is 17px and wraps; the subtitle is 15px and muted, one line per item. A trailing value carries a distance or other meta. `staleAge` draws a gray clock and a short age, and only when the row is stale. A trailing `photo` is a 56px column at the end of the row and reserves no space when absent.

```svelte
<script lang="ts">
  import { GroupedList, GroupedListItem } from '@lostgradient/cinder';
</script>

<GroupedList header="Open now">
  <GroupedListItem href="/places/rooftop" leadValue={45} leadUnit="min left" urgency="urgent">
    {#snippet title()}The Rooftop{/snippet}
    {#snippet subtitle()}Half-price wells{/snippet}
    {#snippet trailing()}0.4 mi{/snippet}
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
| `chevron` | `boolean` | no | — | Draws a trailing chevron. Left unset, a row with `href` draws one. |
| `class` | `string` | no | — | Custom class merged with `.cinder-grouped-list-item`. |
| `href` | `string` | no | — | Makes the whole row a link to this address. |
| `leadUnit` | `"min left"` \| `"left"` \| `"min to go"` \| `"starts"` \| `"Mon"` \| `"Tue"` \| `"Wed"` \| `"Thu"` \| `"Fri"` \| `"Sat"` \| `"Sun"` | no | — | The small unit under the lead number, from a closed vocabulary. Used with `leadValue`. |
| `leadValue` | `string` \| `number` | no | — | The number or word of a time-led row's lead, such as `45` or `9:30`, drawn large. Pair it with `leadUnit`. Ignored when a `lead` snippet is given. A range of times never goes here. |
| `leadingKind` | `"icon"` \| `"avatar"` \| `"media"` \| `"control"` | no | `"icon"` | What the leading slot holds. |
| `rel` | `string` | no | — | The link's relationship; `noopener noreferrer` is added for `_blank`. |
| `selected` | `boolean` | no | `false` | Marks the row as the current one with a tint. |
| `staleAge` | `string` | no | — | A short age, such as `3d`, drawn with a gray clock before the trailing value. Give it only when the row's information is stale; a fresh row draws no marker. |
| `suggested` | `boolean` | no | `false` | Marks the row as a suggestion that is not saved until the person confirms it: a quiet accent text label on a line above the title, with no tint, border or pill. |
| `suggestedLabel` | `string` | no | `"Suggested"` | The words of the suggested label, such as "Suggested wording". Used with `suggested`. |
| `target` | `string` | no | — | Where to open the link. |
| `urgency` | `"urgent"` \| `"soon"` | no | — | How pressing the lead is. `urgent` uses the warning text colour and `soon` is muted; left unset, the lead uses the default text colour. Used with `leadValue`. |
| `action` | `(opaque)` | no | — | A trailing action such as a menu button. It sits in a fixed-width column, so a changing value never moves its click target. Not expressible in JSON Schema; see the component types for the signature. |
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
