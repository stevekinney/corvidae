# SideNavigation

Vertical navigation panel for secondary or hierarchical app destinations.

See the [SideNavigation versus Sidebar decision](https://github.com/stevekinney/cinder/blob/main/docs/decisions/side-navigation-vs-sidebar.md) for the boundary between the accessibility-focused nav landmark here and the responsive shell in Sidebar.

## Usage

`SideNavigation` is a compound component. Import the parent and compose `SideNavigation.Group` and `SideNavigation.Item` via the namespace API.

```svelte
<script lang="ts">
  import { SideNavigation } from '@lostgradient/cinder';
</script>

<SideNavigation ariaLabel="Workspace">
  <SideNavigation.Item href="/dashboard">Dashboard</SideNavigation.Item>
  <SideNavigation.Group label="Projects">
    <SideNavigation.Item href="/projects/phoenix" active>Phoenix</SideNavigation.Item>
    <SideNavigation.Item href="/projects/atlas">Atlas</SideNavigation.Item>
  </SideNavigation.Group>
</SideNavigation>
```

The leaves are also named exports of `@lostgradient/cinder`.

`brand` and `primaryAction` are slots above the list. The sidebar is a soft tonal surface with no rule beside it, and the current row is a raised white pill with default text, because the accent is for actions and links. The primary action is one `<a>` or `<button>`, drawn as a neutral control the width of the sidebar: a leading accent "+", its label, and the shortcut glyph at the trailing edge as plain text with no key cap. The count on a row is plain muted text at the trailing edge, never a badge.

```svelte
<script lang="ts">
  import { SideNavigation } from '@lostgradient/cinder';
</script>

<SideNavigation ariaLabel="Workspace">
  {#snippet brand()}Corvidae{/snippet}
  {#snippet primaryAction()}
    <button type="button" aria-keyshortcuts="N">
      New chat
      <span data-cinder-shortcut aria-hidden="true">N</span>
    </button>
  {/snippet}
  <SideNavigation.Item href="/" active>Home</SideNavigation.Item>
</SideNavigation>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `ariaLabel` | `string` | yes | — | Accessible name for the <nav> landmark. Required, non-empty, distinct from other navs on the page. |
| `class` | `string` | no | — | Additional CSS class merged with `.cinder-side-navigation`. |
| `style` | `string` | no | — | Inline style string applied to the `.cinder-side-navigation` root. |
| `brand` | `(opaque)` | no | — | The product's name, mark or workspace switcher, drawn above the primary action and the list. Wrap it as you like; the slot adds only the padding that aligns it with the rows. Not expressible in JSON Schema; see the component types for the signature. |
| `children` | `(opaque)` | yes | — | Must be <li> elements containing NavigationItem and/or SideNavigationGroup. Not expressible in JSON Schema; see the component types for the signature. |
| `primaryAction` | `(opaque)` | no | — | The one action the product leads with ("Capture", "New chat"), drawn under `brand` and above the list. Render a single `<a>` or `<button>`: it is drawn as a neutral, sidebar-wide control with a leading accent "+", its label, and, for an element with `data-cinder-shortcut`, the shortcut glyph at the trailing edge as plain text with no key cap. It is never a full-width accent slab. Name the shortcut for assistive technology with `aria-keyshortcuts` on the control, and mark the glyph `aria-hidden`. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

- `--cinder-side-navigation-list-gap`

<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

- `SideNavigation.Group` — a collapsible labelled section; see [`side-navigation-group`](../side-navigation-group/README.md).
- `SideNavigation.Item` — a navigation link or button rendered inside the sidebar list; see [`side-navigation-item`](../side-navigation-item/README.md).

<!-- generated:subcomponents:end -->
