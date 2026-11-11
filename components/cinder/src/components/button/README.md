# Button

A clickable button or anchor with built-in loading state, icon slots, and a discriminated prop union that forces consumers to provide an accessible name at compile time.

## Usage

```svelte
<script lang="ts">
  import { Button } from '@lostgradient/cinder';
</script>

<Button variant="primary" size="md" label="Save" />
```

When `href` is set, the component renders as `<a>`; otherwise it renders as `<button>`. Setting `loading` swaps in a spinner, blocks the consumer's `onclick`, forces `aria-disabled` / `aria-busy`, and strips `href` to prevent navigation. While loading the cursor is `progress` and the button keeps full strength; a page that dims it sets `--cinder-button-loading-opacity` (for example `0.75`) on it. The width is held when the label stays or gets shorter; a longer label that arrives with `loading` ("Create", "Creating…") lets the width go so it never spills over the border.

## Sizes

`md` is the default and the size for inline actions: the buttons in a row, a card, a dialog footer, or a toolbar. Use `sm` or `xs` where space is tight. Reserve `lg` for a page-level primary action, such as the one call to action that a page is organized around. A screen with several `lg` buttons has no primary action.

## Filled by default

A Button is a pill, and with no `variant` it draws the filled `soft` face: a tinted fill with no outline, so a row of actions reads as filled controls rather than a row of boxes. `primary` is unchanged and marks the one action a region is organized around. Ask for `secondary` by name only where an outlined face is the point, such as a field's colour well.

Keep one labelled primary in a group of actions. The secondary options are icon-only Buttons (`iconOnly`) with an accessible name (`aria-label` or `label`) and a `Tooltip` that shows the same words, so the row is one labelled action and a few glyphs.

## Content

A label is a short verb phrase, about four words: "Save draft", "Run now", "Add a memory". It names the action, not what the action will produce. A proposal, a preview or a sentence the person should read before acting belongs beside the button, in the row or card it acts on, with the button keeping a short verb ("Apply", "Use this").

A button is never wider than its container. A label too long for the room truncates with an ellipsis, and the full words stay the accessible name, so nothing is lost to a screen reader; the sighted reader loses the end of the label, which is why a long label is a content defect rather than a layout to rely on. Labels never wrap onto a second line. Truncation applies to the `label` prop; content you pass as children is laid out as you write it, so pass the words through `label` when they could run long.

## Shortcut hint

`shortcut` takes a key (`"N"`) or an array of keys (`['Ctrl', 'K']`) and renders a ShortcutHint after the label. The hint is decorative and `aria-hidden`, so the button's accessible name stays its label, and it only displays the shortcut; registering the key is the application's job. The hint is plain glyphs in the button's own text color, on every variant: no border, fill, shadow, or key-cap chip, and slightly dimmed so the label stays dominant. It is hidden on touch devices (`pointer: coarse` or `hover: none`), which have no keyboard to press it with. A `Kbd` or `ShortcutHint` you nest in a button by hand gets the same treatment, so do not restyle it per page.

## Disabled

A disabled button looks the same in every variant: a neutral surface (or none, for `ghost` and `ghost-danger`), `--cinder-text-disabled` text, and never an opacity fade (a fade would drop the label under 4.5:1). It never keeps its tone while disabled, so a disabled `danger` or `ghost-danger` button does not read as a faded red button. A primary button also never takes a tone from its container: inside a danger `Card` it is still the primary button.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with `.cinder-button`. |
| `fullWidth` | `boolean` | no | `false` | Expand to container width. |
| `href` | `string` | no | — | Render as an anchor `<a>` element with this href. |
| `iconOnly` | `boolean` | no | `false` | Render the button with only an icon. Requires an accessible name source. |
| `label` | `string` | no | — | Visible text label. Must be non-empty if provided. |
| `loading` | `boolean` | no | `false` | Show a spinner and make the button inert (`aria-disabled`, still focusable) while work is in flight; the label stays and the width holds. |
| `loadingStatus` | `string` | no | — | Text a polite, visually hidden status announces while `loading`, rendered beside the button. |
| `mutating` | `boolean` | no | `false` | Marks a button that changes something. Inside a stale `<StaleRegion>` it goes inert (`aria-disabled`, still focusable) and is described by the region's reason. |
| `quiet` | `boolean` | no | `false` | Rests as the bare glyph: drops the resting fill and rule an icon-only `ghost` button otherwise paints, for a toolbar such as the shell's top bar. Hover, pressed and focus still paint. It has no effect unless the button is `iconOnly` with `variant="ghost"`. |
| `shortcut` | `string` \| `string`[] | no | — | Keyboard shortcut hint rendered after the label, `aria-hidden`; a key or an array of keys. |
| `size` | `"xs"` \| `"sm"` \| `"md"` \| `"lg"` | no | `"md"` | Size of the button. `lg` is for page-level primary actions only; inline actions use `md`. |
| `variant` | `"primary"` \| `"secondary"` \| `"soft"` \| `"danger"` \| `"soft-danger"` \| `"ghost"` \| `"ghost-danger"` \| `"ghost-accent"` | no | `"soft"` | Visual style. |
| `children` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `leadingIcon` | `(opaque)` | no | — | DECORATIVE icon rendered before the label/children. Always wrapped in aria-hidden. If the icon conveys meaning, supply accessible text via `label`/`aria-label` instead. Not expressible in JSON Schema; see the component types for the signature. |
| `trailingIcon` | `(opaque)` | no | — | DECORATIVE icon rendered after the label/children. Always wrapped in aria-hidden. Same accessible-name guidance as `leadingIcon`. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

### Toggle buttons

Pass `aria-pressed="true"` or `"false"` to make a button a toggle. A pressed button takes the filled accent face (every variant except `primary` and `danger`, which are already filled); see `button.a11y.md`. This applies to every `Button` that carries `aria-pressed="true"`, including a consumer's own: for example, `kanban-board.svelte` sets it on a column's drag handle while that column is lifted, so a lifted column's handle now takes the filled face. No committed Cinder baseline shows a pressed `Button` at rest besides the new `button/*-pressed` images, which the baseline refresh confirmed.

## CSS Variables

<!-- generated:variables:start -->

- `--cinder-button-background`
- `--cinder-button-border`
- `--cinder-button-font-size-lg`
- `--cinder-button-font-size-md`
- `--cinder-button-font-size-sm`
- `--cinder-button-font-size-xs`
- `--cinder-button-foreground`
- `--cinder-button-height-lg`
- `--cinder-button-height-md`
- `--cinder-button-height-sm`
- `--cinder-button-height-xs`
- `--cinder-button-padding-x-lg`
- `--cinder-button-padding-x-md`
- `--cinder-button-padding-x-sm`
- `--cinder-button-padding-x-xs`
- `--cinder-button-padding-y-lg`
- `--cinder-button-padding-y-md`
- `--cinder-button-padding-y-sm`
- `--cinder-button-padding-y-xs`
- `--cinder-button-radius`
- `--cinder-button-radius-lg`
- `--cinder-button-radius-md`
- `--cinder-button-radius-sm`
- `--cinder-button-radius-xs`

<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
