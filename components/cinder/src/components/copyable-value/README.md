# CopyableValue

<!-- generated:a11y-record:required -->

`CopyableValue` shows a value such as an address or an identifier in monospace, with a copy control after it. The value breaks after a slash, colon, question mark, ampersand or equals sign when its place is narrow, so a host, a port and a path segment stay whole; it breaks after a dot only when one of those parts is longer than the place, and anywhere (`overflow-wrap: anywhere`) only when a piece between two dots is. Each part and piece is an `inline-block` with `max-inline-size: 100%`, the technique CodeBlock draws its flags with, so the browser's own break after a hyphen never splits one. The copied text is the value as given. The inline copy control follows the size of the text and stays on the value's last line, because the last character and the control are one stretch that never breaks. A `CopyButton` placed beside a `code` element wraps as two parts, so the button can land alone on a row while the value breaks above it.

The component is inline: put it in a sentence, after the words that name the value ("Deliveries go to"), and it flows with them. `value` is both what is shown and what is copied. Name the control with `label` and say what was copied with `copiedLabel`; other attributes, such as `data-testid`, land on the outer element.

## Usage

```svelte
<script lang="ts">
  import { CopyableValue } from '@lostgradient/cinder';
</script>

<p>
  Deliveries go to
  <CopyableValue
    value="https://example.com/triggers/nightly-digest"
    label="Copy the address"
    copiedLabel="Address copied"
  />
</p>
```

Use `breakHints` for addresses that should prefer breaks after dots, hyphens, at signs, colons and slashes. This mode also selects the value as a unit.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `breakHints` | `boolean` | no | — | Prefer separator breaks and select the text as one value. Defaults to false. |
| `class` | `string` | no | — | Custom class merged with `.cinder-copyable-value`. |
| `copiedLabel` | `string` | no | — | What is announced once the copy succeeds. Defaults to "Copied"; say what was copied when `label` does ("Address copied"). |
| `label` | `string` | no | — | Accessible name of the copy control, also its tooltip. Defaults to "Copy to clipboard". |
| `value` | `string` | yes | — | The text shown, in monospace, and the text the copy control writes to the clipboard, such as an address or an identifier. |

<!-- generated:props:end -->

## Authoring checklist

<!-- generated:authoring:start -->
<!-- generated:authoring:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
