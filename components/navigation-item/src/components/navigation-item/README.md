# NavigationItem

Individual link or button within a navigation bar, supporting active and disabled states.

## Usage

```svelte
<script lang="ts">
  import { NavigationItem } from '@lostgradient/cinder';
</script>

<NavigationItem href="/dashboard">Dashboard</NavigationItem>
```

Pass an `icon` snippet to draw a glyph before the label in any placement. The icon is decorative and the label names the item. In a vertical row the active item is a raised white pill (the raised surface with the hairline shadow) with default text and semibold weight, because the accent is for actions and links; in a bottom `NavigationBar` the active item is an accent-coloured icon and label with no fill or top border.

```svelte
<script lang="ts">
  import { House, NavigationItem } from '@lostgradient/cinder';
</script>

<NavigationItem href="/" active>
  {#snippet icon()}<House class="cinder-icon-sm" />{/snippet}
  Home
</NavigationItem>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `active` | `boolean` | no | — | Marks this item as the currently active destination; emits `aria-current` and applies active visual styling. |
| `class` | `string` | no | — | Additional class merged onto the `.cinder-navigation-item` root element. |
| `current` | `"page"` \| `"step"` \| `"location"` \| `"date"` \| `"time"` \| `"true"` | no | — | The `aria-current` token emitted while `active` is true. Defaults to `'page'`, which is correct for navigation bars and breadcrumb-adjacent links. Use `'true'` (or another standard token such as `'step'` / `'location'`) for section/view switchers, where `'page'` would mislabel the current section as the current page in the browsing context. |
| `disabled` | `boolean` | no | — | Prevents interaction: removes the item from the tab order, blocks clicks, and applies disabled visual styling. |
| `href` | `string` | no | — | Destination URL. Providing this prop renders the item as an `<a>` element instead of a `<button>`. |
| `variant` | `"horizontal"` \| `"mobile"` \| `"vertical"` | no | — | Controls item geometry. Emitted as `data-variant`. Default `'horizontal'`. - `'horizontal'`: top-rounded radius, accent bottom-border active indicator. Used inside `NavigationBar` and similar horizontal tab-bar contexts. - `'mobile'`: stacked full-width layout when an owning navigation surface enters its narrow container mode. - `'vertical'`: a 30px rounded row (44px under a coarse pointer), a neutral hover tint, and a raised white pill with the hairline shadow, default text and semibold weight as the active indicator. Used inside `SideNavigation` (set automatically by `SideNavigationItem`) or standalone sidebar footers where flush sidebar edges are required. |
| `children` | `(opaque)` | yes | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `icon` | `(opaque)` | no | — | The item's icon, drawn before the label in every placement: beside it in a horizontal tab or a vertical row, above it in a bottom `NavigationBar` tab. The wrapper is `aria-hidden`, so the icon is decoration and the label names the item. The label is wrapped in a `[data-cinder-navigation-label]` element, so a bottom bar's `labelsVisible` can hide it visually and keep it in the accessibility tree. Without an icon the children render as they are. Not expressible in JSON Schema; see the component types for the signature. |
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
