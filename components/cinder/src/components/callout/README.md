# Callout

Inline note for tips, warnings, or contextual notes within content flow. It is quiet by default: with no `variant` it is the neutral note, an icon and muted text with no tint. Emphasis comes from position, size and weight first; tints are for a warning or a blocking condition, with at most one tinted box on a screen. A caller that wants the tinted info look passes `variant="info"`.

## Usage

```svelte
<script lang="ts">
  import { Callout } from '@lostgradient/cinder';
</script>

<Callout title="Note">
  This setting applies to all projects in your organization and cannot be overridden per-project.
</Callout>
```

## Neutral note with an action

`variant="neutral"`, the default, is a plain note that is not a status: an icon and muted text, with no tint, edge or inset, and its row is vertically centred, so the `icon` lines up with the text however many lines it wraps to. The message is capped at 68 characters wide, and the `action` stacks under it in a row that wraps, so several actions break onto lines of their own and a button label never wraps (a Banner's actions stack the same way). Use it to explain a state, with one link or button under the message:

```svelte
<script lang="ts">
  import { Callout, Link } from '@lostgradient/cinder';
  import { Info } from '@lucide/svelte';
</script>

<Callout variant="neutral" semantic="note">
  {#snippet icon()}
    <Info size={16} />
  {/snippet}
  Gave up after 5 attempts. The check was never met. Open the last attempt to see what the agent produced,
  or start again with the same prompt and check.
  {#snippet action()}
    <Link href="/goals/draft-release-notes/attempts/5">Open attempt 5</Link>
  {/snippet}
</Callout>
```

## The one notice

Callout is the single notice in Cinder's chat surfaces: one box, one layout, and only the tone varies.

- `variant`: `info`, `warning` or `danger` tint the box with a 1px edge in the tone's colour; `neutral` is the quiet, untinted note.
- `icon`: the leading tone icon, a 16px glyph in the first track. Pass the icon for the tone (`Info`, `TriangleAlert`, `OctagonAlert`).
- `title`: an optional bold first line.
- children: the text.
- `progress`: an optional snippet under the text inside the content column, usually a small `Progress` with its own accessible name.
- `action` with `actionLayout="inline"`: one `sm` secondary `Button` at the trailing end of the text. It wraps under the text, at the text's own edge, only when the row cannot hold both.
- `onDismiss` and `dismissLabel`: a compact dismiss button at the trailing end, 20px painted with a 44px hit area that takes no layout space. Callout stays static, so the caller removes it.

```svelte
<script lang="ts">
  import { Button, Callout, Progress } from '@lostgradient/cinder';
  import { TriangleAlert } from '@lucide/svelte';
</script>

<Callout variant="warning" semantic="note" actionLayout="inline" onDismiss={hide}>
  {#snippet icon()}<TriangleAlert size={16} />{/snippet}
  Connection lost. Trying again in 8 s.
  {#snippet progress()}<Progress value={40} max={100} size="sm" ariaLabel="Next try" />{/snippet}
  {#snippet action()}<Button size="sm" variant="secondary" label="Retry now" />{/snippet}
</Callout>
```

## Keep controls out of a callout

A callout is a note beside the content it qualifies. Do not wrap a form control or an inline choice, such as a [`SegmentedControl`](../segmented-control/README.md), in a tinted callout: the tint makes a choice look like a warning, the control stretches to fill a box it was not drawn for, and its own colours clash with the status colour. Place the control in the page flow with a plain label, and keep the callout for one short note, with one link or button at its end.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `actionLayout` | `"stacked"` \| `"inline"` | no | — | Layout for the action slot. `inline` keeps one compact action beside the message. |
| `class` | `string` | no | — | Extra classes appended to the root element. Pass via the explicit `class` prop — it is excluded from rest-prop spread, so writing `class="x"` inside spread attributes will not reach the root. |
| `dismissLabel` | `string` | no | — | Accessible name of the dismiss button. Default `'Dismiss'`. |
| `semantic` | `"aside"` \| `"note"` | no | — | Root semantics. Default `'aside'`; use `'note'` for static note semantics without a complementary landmark. |
| `title` | `string` | no | — | Optional title rendered as a `<p class="cinder-callout__title">`. Rendered as a paragraph rather than a heading element so the callout does not inject an entry into the document outline. If a callout genuinely participates in the outline (e.g. it titles a standalone section), wrap it in a `<section>` with its own heading rather than promoting this prop to `<h*>`. When supplied and no `aria-label` or `aria-labelledby` is passed on rest props, the title also becomes the `aria-label` of the root element so the landmark or note has an accessible name. |
| `variant` | `"neutral"` \| `"info"` \| `"success"` \| `"warning"` \| `"danger"` | no | — | Visual + semantic variant. Default `'neutral'`, a quiet note of an icon and muted text with no tint; the status variants are tinted, so keep them for a warning or a blocking condition. |
| `action` | `(opaque)` | no | — | Optional action rendered under the message, usually one `Link` or `Button`, such as "Open attempt 5". Several actions sit in a row that wraps, and a button label never wraps. It is interactive content, so it is the one part of a callout a person can act on; the callout itself stays static. Not expressible in JSON Schema; see the component types for the signature. |
| `children` | `(opaque)` | yes | — | Callout body content. Not expressible in JSON Schema; see the component types for the signature. |
| `icon` | `(opaque)` | no | — | Optional decorative icon rendered inside an `aria-hidden` wrapper. The icon is a second visual channel alongside variant color — it helps satisfy WCAG 1.4.1 (Use of Color) by ensuring the variant is conveyed by more than color alone. The accessible meaning still lives in `title` and/or `children`; the icon must not be the only carrier of information. Not expressible in JSON Schema; see the component types for the signature. |
| `onDismiss` | `(opaque)` | no | — | When set, a compact dismiss button renders at the trailing end and calls this on activation. The callout stays static: the caller removes it. Not expressible in JSON Schema; see the component types for the signature. |
| `progress` | `(opaque)` | no | — | Optional progress line rendered under the message inside the content column, usually a small `Progress`. It is decorative to the callout: give the Progress its own accessible name. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
