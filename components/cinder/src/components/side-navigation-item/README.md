# SideNavigationItem

Individual link within a side navigation, supporting nesting and active highlighting.

## Usage

`SideNavigationItem` is a compose-only leaf of [`SideNavigation`](../side-navigation/README.md). The idiomatic API is `SideNavigation.Item`, reached through the parent namespace — see the [side-navigation README](../side-navigation/README.md#usage) for the composed snippet. The leaf is also a named export of `@lostgradient/cinder`.

## Rows, counts and the collapsed rail

A row is one 30px control (44px under a coarse pointer): hover, focus and the active fill paint the whole row. Default text is secondary with no fill; hover gives a lighter neutral tint and primary text; the active row is a neutral tint (the ink at about 7%) with default text, semibold weight and `aria-current="page"` and takes no hover change, because the accent is for actions and links; keyboard focus draws the quiet ring around the whole row.

```svelte
<SideNavigation.Item href="/reviews" label="Reviews" count={2} countLabel="need you">
  {#snippet icon()}<Inbox aria-hidden="true" size={16} />{/snippet}
  Reviews
</SideNavigation.Item>
<SideNavigation.Item
  href="/health"
  label="Health"
  count={3}
  countLabel="need attention"
  dot="warning"
>
  {#snippet icon()}<Activity aria-hidden="true" size={16} />{/snippet}
  Health
</SideNavigation.Item>
```

- **Count**: a count is plain, muted, 13px text at the trailing edge of the row, never a badge. On the icon rail it becomes a small dot on the icon's corner.
- **Accessible name**: with `label` and a non-zero `count`, the link is named `"Health, 3 need attention"` or `"Reviews, 2 need you"`. The count and the dot are hidden from assistive technology, so colour is never the only signal.
- **Tooltip**: a row with a count shows its name as a tooltip on hover and focus (`"Health, 3 need attention"`). A collapsed row shows `"Reviews, 2 need you"`, or the label alone when there is no count.
- **Collapsed rail**: inside a `Sidebar` a row follows the sidebar's collapsed state on its own (pass `collapsed` to override). A row with an `icon` becomes a 40px target: the label is clipped but stays in the accessible name, and the count or dot moves onto the icon's corner. A row without `icon` is unchanged.
- **Do not also set `title`**: the browser would show its own tooltip beside this one.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `active` | `boolean` | no | — | Marks this item as the currently active destination; emits `aria-current` and applies active visual styling. |
| `class` | `string` | no | — | Additional class merged onto the `.cinder-navigation-item` root element. |
| `collapsed` | `boolean` | no | — | Whether the row is drawn as an icon-rail entry. Defaults to the enclosing `Sidebar`'s collapsed state, so a row follows its sidebar without being told. |
| `count` | `number` | no | — | A count of things that want attention. Zero, a negative number and `undefined` show nothing. Shown as plain, muted, right-aligned text at the trailing edge of the row (never a badge), or as a small dot on the icon when collapsed, unless `dot` is set; always part of the accessible name when `label` is given. |
| `countLabel` | `string` | no | — | The words that follow the count in the accessible name and tooltip: "need you" gives "Reviews, 2 need you". The count's own name is the number plus these words. |
| `current` | `"page"` \| `"step"` \| `"location"` \| `"date"` \| `"time"` \| `"true"` | no | — | The `aria-current` token emitted while `active` is true. Defaults to `'page'`, which is correct for navigation bars and breadcrumb-adjacent links. Use `'true'` (or another standard token such as `'step'` / `'location'`) for section/view switchers, where `'page'` would mislabel the current section as the current page in the browsing context. |
| `disabled` | `boolean` | no | — | Prevents interaction: removes the item from the tab order, blocks clicks, and applies disabled visual styling. |
| `dot` | `"neutral"` \| `"success"` \| `"warning"` \| `"danger"` \| `"info"` \| `"accent"` \| `"online"` \| `"offline"` \| `"pending"` | no | — | A status dot shown beside the label (or on the icon when collapsed) in place of the numeric count, for a row whose state is a signal and not a figure. The dot is hidden from assistive technology, so a row that sets it should also set `count` and `countLabel`, which carry the meaning in the accessible name. |
| `emptyLabel` | `string` | no | — | The words that follow the label in the accessible name and tooltip when `count` is zero or absent: "nothing needs attention" gives "Health, nothing needs attention". Without it a row with no count is named by its label alone. |
| `href` | `string` | no | — | Destination URL. Providing this prop renders the item as an `<a>` element instead of a `<button>`. |
| `label` | `string` | no | — | The row's name as plain text ("Health", "Reviews"). It names the row when a count is present ("Health, 3 need attention") and is the first part of the tooltip ("Reviews, 2 need you"). Without it the row has no composed name and no tooltip. |
| `listItemClass` | `string` | no | — | Class merged onto the outer <li>. |
| `children` | `(opaque)` | yes | — | The row's label, rendered after `icon`. When `icon` is also given, a collapsed row (an icon rail) hides this label visually and keeps it in the accessible name. Not expressible in JSON Schema; see the component types for the signature. |
| `icon` | `(opaque)` | no | — | The row's icon. Giving it lets the row collapse to an icon rail: the icon stays, the label stays in the accessible name, and the count or dot moves onto the icon's corner. The wrapper is `aria-hidden`, so the icon is decoration and the label names the row. Not expressible in JSON Schema; see the component types for the signature. |
| `onclick` | `(opaque)` | no | — | Optional click handler called for the rendered `<a>` element. Useful for intercepting plain left-clicks for SPA navigation while letting modified clicks (cmd/ctrl/shift/alt or middle-click) fall through to native browser behavior. Disabled-state preventDefault still applies. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
