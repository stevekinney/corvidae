# DropdownTrigger

Activates the associated dropdown menu on click or keyboard interaction.

## Usage

`DropdownTrigger` is a compose-only leaf of [`Dropdown`](../dropdown/README.md). The idiomatic API is `Dropdown.Trigger`, reached through the parent namespace — see the [dropdown README](../dropdown/README.md#usage) for the composed snippet. The leaf is also a named export of `@lostgradient/cinder`.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `caretVisible` | `boolean` | no | — | Render the trailing disclosure caret. Defaults to true. |
| `class` | `string` | no | — | Additional class names merged with the component's root class. |
| `mutating` | `boolean` | no | `false` | Marks a menu of actions that change something. Inside a stale `<StaleRegion>` the trigger goes inert: it keeps focus and carries `aria-disabled`, the menu does not open, and the region's reason describes it. It returns by itself when the region stops being stale. |
| `children` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
