# Card

Surface container for grouping related content and actions into a distinct visual unit.

## Usage

```svelte
<script lang="ts">
  import { Card } from '@lostgradient/cinder';
</script>

<Card>
  <div
    style="min-block-size: 8rem; border: 1px dashed var(--cinder-border-muted); border-radius: var(--cinder-radius-sm); background: repeating-linear-gradient(-45deg, transparent, transparent 0.5rem, color-mix(in oklch, var(--cinder-border-muted), transparent 70%) 0.5rem, color-mix(in oklch, var(--cinder-border-muted), transparent 70%) 0.5625rem);"
  ></div>
</Card>
```

## Danger Zones

Use `tone="danger"` when a settings section or action group has destructive, irreversible, or broad-scope consequences. The tone paints the Card container, border, and generated title icon so applications do not need to hand-roll danger-zone borders or backgrounds. Put the concrete state or action in the body and use `ConfirmDialog` for irreversible or workspace-wide changes.

## Edge

A card draws one edge, never two. `edge="border"` (the default) is a hairline outline with no shadow; `edge="shadow"` is a soft shadow with no visible border. There is no prop that asks for both, so a card cannot end up with a border and a shadow together. The choice applies across every `variant` and `tone`, including `variant="well"` and `tone="danger"`.

## Header divider

The header is separated from the body by its surface alone. Pass `headerDivider` to draw a rule under it; the divider is opt-in, so a card that already has an edge is not ruled a second time.

## Interaction States

A card becomes interactive when it receives `href` (the whole card renders as an anchor) or `onclick` (the whole card renders as a `<div>` with a stretched hit-target `<button>` covering it). Either way, hover strengthens whichever edge the card has (a darker border for `edge="border"`, a deeper shadow for `edge="shadow"`) under a hover-capable pointer, and keyboard focus paints a visible ring on the outer card itself — never only on the inner control — so the whole-card-is-a-link pattern gets a correct focus indicator without a consumer needing to do anything extra.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `bodyTone` | `"default"` \| `"muted"` | no | — | Body surface treatment. `muted` renders a grey/inset body region. |
| `class` | `string` | no | — | Custom class merged with `.cinder-card`. |
| `description` | `string` | no | — | Optional subheading rendered as a paragraph below the title inside the header. |
| `edge` | `"border"` \| `"shadow"` | no | — | The one edge the card draws: a `border` (default) or a `shadow`, never both. An interactive card strengthens whichever edge it has on hover. |
| `edgeToEdgeOnMobile` | `boolean` | no | — | Remove side borders/radius and bleed to the viewport edge on narrow screens. |
| `footerTone` | `"default"` \| `"muted"` | no | — | Footer surface treatment. `muted` renders a grey/inset footer region. |
| `headerDivider` | `boolean` | no | — | Draw a divider rule under the header. Off by default: the header is separated from the body by its surface alone, and a divider is opt-in. |
| `headingLevel` | `2` \| `3` \| `4` \| `5` \| `6` | no | — | Heading level for the generated title. Defaults to `3`. Set this so the card title nests correctly within the surrounding document outline. |
| `href` | `string` | no | — | Destination URL that makes the entire card an anchor. |
| `padding` | `"default"` \| `"none"` | no | — | Body padding. `none` leaves header and footer padding intact while making body content flush with the card edges. |
| `title` | `string` | no | — | Primary heading text rendered inside the card's header region. |
| `tone` | `"default"` \| `"danger"` | no | — | Container risk treatment. `danger` renders a danger-zone surface for high-risk settings or destructive actions. |
| `variant` | `"card"` \| `"well"` | no | — | Visual container style. `card` is raised; `well` is flatter and inset. |
| `children` | `(opaque)` | yes | — | Basic card with no generated header. Not expressible in JSON Schema; see the component types for the signature. |
| `footer` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `header` | `(opaque)` | no | — | Card with a custom header snippet — full control over header content. Not expressible in JSON Schema; see the component types for the signature. |
| `onclick` | `(opaque)` | no | — | Click handler that makes the entire card a button. Not expressible in JSON Schema; see the component types for the signature. |
| `type` | `(opaque)` | no | — | A prop whose shape is not captured by the JSON schema; see the component types for the exact signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

- `--cinder-card-mobile-bleed`

<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
