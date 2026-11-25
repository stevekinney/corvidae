# DropdownItem

Selectable item within a dropdown menu, supporting icons, labels, and keyboard navigation.

## Usage

`DropdownItem` is a compose-only leaf of [`Dropdown`](../dropdown/README.md). The idiomatic API is `Dropdown.Item`, reached through the parent namespace — see the [dropdown README](../dropdown/README.md#usage) for the composed snippet. The leaf is also a named export of `@lostgradient/cinder`.

A disabled item that cannot say why on its own takes `disabledReason`: the item draws the reason as a second line under its label, in the disabled colour at the extra-small size, so it never reads louder than the label, starting where the label's text starts, past a leading icon, and names it as its description (`aria-describedby`), while its name stays the label. It is drawn at every width, so a phone reads it without a hover, which a `title` never gives. An enabled item ignores it.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `checked` | `boolean` | no | — | Checked state for checkbox and radio menu items. A checked `menuitemradio` or `menuitemcheckbox` item draws a leading check mark, and every such item reserves its space, so the labels of a group start at one edge. The mark is hidden from assistive technology; `aria-checked` carries the state. Omitted for normal menu items. |
| `class` | `string` | no | — | Additional class names merged with the component's root class. |
| `closeOnSelect` | `boolean` | no | — | When true, the parent dropdown closes after this item is activated. Default `true`. |
| `disabled` | `boolean` | no | — | When true the item is inert: click is blocked and aria-disabled is set. |
| `disabledReason` | `string` | no | — | Why the item is off. While `disabled` is set it is drawn under the label as a second line in the disabled colour at the extra-small size, never louder than the label, and it is the item's description (`aria-describedby`), so it reads on a phone and by keyboard with no hover. Ignored while the item is enabled. Use it in place of a `title`, which touch never shows. |
| `href` | `string` | no | — | Destination URL. Any defined value — including an empty string — selects the anchor branch and renders an `<a>`. Omit `href` entirely to render a `<button>`. |
| `inset` | `boolean` | no | — | When true, adds leading padding to align the item with items that have a leading icon or indicator. Default `false`. |
| `itemRole` | `"menuitem"` \| `"menuitemcheckbox"` \| `"menuitemradio"` | no | — | ARIA role for the row. Use `menuitemcheckbox` or `menuitemradio` for selectable menu items. |
| `type` | `"button"` \| `"submit"` \| `"reset"` | no | — | Button type forwarded to the `<button>` element. Defaults to `"button"`. NOTE: `type="submit"` only submits a surrounding `<form>` when the menu stays inside that form's DOM subtree. DropdownMenu portals its panel to `document.body` on the non-popover fallback path, so a submit item is then NOT a form descendant and native submission is skipped. To submit a form from a portaled menu, set `form="<form-id>"` to associate the button with the form by id, or handle submission in `onclick`. |
| `variant` | `"default"` \| `"danger"` | no | — | Visual style of the item. Use `danger` to signal a destructive action. Default `default`. |
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
