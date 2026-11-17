# Sidebar

Persistent side panel that houses navigation, filters, or supplementary page content.

See the [SideNavigation versus Sidebar decision](https://github.com/stevekinney/cinder/blob/main/docs/decisions/side-navigation-vs-sidebar.md) for the boundary between the responsive shell here and the accessibility-focused nav landmark in SideNavigation.

## Usage

```svelte
<script lang="ts">
  import { Sidebar } from '@lostgradient/cinder';
  import { SideNavigation } from '@lostgradient/cinder';
</script>

<Sidebar label="App sidebar">
  {#snippet navigation()}
    <SideNavigation ariaLabel="Primary navigation">
      <SideNavigation.Item href="/dashboard">Dashboard</SideNavigation.Item>
      <SideNavigation.Item href="/projects">Projects</SideNavigation.Item>
    </SideNavigation>
  {/snippet}
</Sidebar>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional CSS class merged with `.cinder-sidebar`. |
| `closeLabel` | `string` | no | — | Accessible name of the drawer's close button. Default `'Close navigation'`. |
| `collapsed` | `boolean` | no | — | Whether the sidebar is collapsed. Bindable via `bind:collapsed`. Default `false`. Above `mobileBreakpoint`, `collapsed=true` switches the sidebar to icon-only mode. At or below `mobileBreakpoint`, the sidebar renders inside a `<Drawer>` and `collapsed=true` means the drawer is closed. |
| `drawerQuery` | `string` | no | — | A parenthesized media query that also turns the sidebar into the drawer, beside the width breakpoint, for a layout that depends on more than width: `'(pointer: coarse) and (max-width: 1023.98px)'` gives touch devices the drawer at every width below 1024, because an icon rail with tooltip-only labels has no labels on touch. Read after the page loads; the server markup is the inline column. |
| `label` | `string` | no | — | Accessible name for the outer landmark and the mobile drawer. Defaults to `'Sidebar'` for convenience but must be unique per page. Navigation content owns its own accessible name; for example, use `SideNavigation.ariaLabel`. |
| `mobileBreakpoint` | `string` | no | — | Viewport width below which the sidebar switches from the inline aside to the mobile drawer. Accepts a simple CSS length such as `'639.98px'` or `'1024px'`. Default `'639.98px'`, so tablets keep the inline column and its icon rail. |
| `railLabels` | `boolean` | no | — | When the sidebar is collapsed above `mobileBreakpoint`, draws it as a 76px rail with a short label under every icon instead of the 56px icon-only column whose labels are clipped. The labels are drawn, so the rail needs no tooltip and a touch screen needs no drawer. A row's count or dot rides the icon's corner, and the brand and the primary action keep to their icon or plus. Has no effect on an expanded sidebar or on the drawer. Default `false`. |
| `footer` | `(opaque)` | no | — | Optional footer region (e.g. user account, sign-out). Not expressible in JSON Schema; see the component types for the signature. |
| `navigation` | `(opaque)` | no | — | Navigation content. Typically a `<SideNavigation>` subtree, which owns the navigation landmark and its accessible name. Optional so the sidebar can serve as app chrome without a navigation list. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
