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

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `chevron` | `boolean` | no | — | Draws a trailing chevron. Left unset, a row with `href` draws one. |
| `class` | `string` | no | — | Custom class merged with `.cinder-grouped-list-item`. |
| `href` | `string` | no | — | Makes the whole row a link to this address. |
| `leadingKind` | `"icon"` \| `"avatar"` \| `"media"` \| `"control"` | no | `"icon"` | What the leading slot holds. |
| `rel` | `string` | no | — | The link's relationship; `noopener noreferrer` is added for `_blank`. |
| `selected` | `boolean` | no | `false` | Marks the row as the current one with a tint. |
| `target` | `string` | no | — | Where to open the link. |
| `action` | `(opaque)` | no | — | A trailing action such as a menu button. It sits in a fixed-width column, so a changing value never moves its click target. Not expressible in JSON Schema; see the component types for the signature. |
| `lead` | `(opaque)` | no | — | A fixed-width column for a time or number, such as "45 min left", drawn before the title. Rows in one list line up. Not expressible in JSON Schema; see the component types for the signature. |
| `leading` | `(opaque)` | no | — | A leading icon, thumbnail, avatar or control, drawn before the text. Not expressible in JSON Schema; see the component types for the signature. |
| `photo` | `(opaque)` | no | — | A trailing photo. It reserves no space when absent. Not expressible in JSON Schema; see the component types for the signature. |
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
