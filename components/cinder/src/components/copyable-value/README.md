# CopyableValue

<!-- generated:a11y-record:required -->

`CopyableValue` shows a value such as an address or an identifier in monospace, with a copy control after it. The value breaks anywhere when its place is narrow (`overflow-wrap: anywhere`), and the control stays on the value's last line, because the last character and the control are one stretch that never breaks. A `CopyButton` placed beside a `code` element wraps as two parts, so the button can land alone on a row while the value breaks above it.

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

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
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
