# SideNavigationGroup

Collapsible group header that organises related items within a side navigation.

## Usage

`SideNavigationGroup` is a compose-only leaf of [`SideNavigation`](../side-navigation/README.md). The idiomatic API is `SideNavigation.Group`, reached through the parent namespace — see the [side-navigation README](../side-navigation/README.md#usage) for the composed snippet. The leaf is also a named export of `@lostgradient/cinder`.

## Sections with no visible heading

An app's main navigation often reads better as sections kept apart by space alone. Set `collapsible={false}` and `labelVisibility="hidden"`: the group renders no header, the label becomes the list's `aria-label` so a screen reader still hears "Work" or "System", and one gap above the list separates it from the section before. `labelVisibility` does nothing on a collapsible group, whose trigger is its label.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional CSS class merged with `.cinder-side-navigation-group`. |
| `collapsible` | `boolean` | no | — | Whether the group opens and closes. Default: true. Set `false` for a static section: its label is plain text over an always-visible list, and in a collapsed sidebar the label gives way to a hairline between sections. `expanded` and `disabled` do nothing on a static group. |
| `disabled` | `boolean` | no | — | When true, the disclosure button is disabled. Default: false. |
| `expanded` | `boolean` | no | — | Whether the group is expanded. Bindable. Default: true. |
| `id` | `string` | no | — | Optional stable id for the root <li>. Trigger uses `${id}-trigger`, panel uses `${id}-panel`. If omitted, generated via useId. |
| `label` | `string` | yes | — | The section's name: its visible header, or with `labelVisibility: 'hidden'` the list's accessible name. |
| `labelVisibility` | `"hidden"` \| `"visible"` | no | — | Whether a static group draws its label. Default: `'visible'`. `'hidden'` renders no header at all: the label becomes the list's `aria-label`, so a screen reader still hears the section's name, and sighted users see the sections apart by one gap. It does nothing on a collapsible group, whose trigger is its label. |
| `badge` | `(opaque)` | no | — | Optional trailing badge rendered inside the header button after the label, before the chevron. Not expressible in JSON Schema; see the component types for the signature. |
| `children` | `(opaque)` | yes | — | Must be <li>-wrapped NavigationItems (or SideNavigationItems) rendered inside the disclosed <ul>. Not expressible in JSON Schema; see the component types for the signature. |
| `icon` | `(opaque)` | no | — | Optional leading icon rendered inside the header button before the label. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
