# CopyButton

Button that copies a given text value to the clipboard with visual feedback.

## Usage

```svelte
<script lang="ts">
  import { CopyButton } from '@lostgradient/cinder';
</script>

<div style="display: flex; align-items: center; gap: 0.5rem;">
  <code
    style="padding: 0.25rem 0.5rem; background-color: var(--cinder-surface-inset); color: var(--cinder-text-default); border-radius: 4px;"
    >bun run validate</code
  >
  <CopyButton value="bun run validate" label="Copy validation command" />
</div>
```

By default the button is the Copy icon, the one copy glyph used across the interface, and turns to a check once the copy lands; `label` names it and shows as its tooltip (inside a page's own `Tooltip`, the page's tooltip is the only one). `textVisible` adds the words "Copy" and "Copied" after the icon, and `children` writes other words; the icon always leads them. Both states are laid out together, so the button keeps one width and nothing beside it moves. A successful copy is announced once through a polite live region, `copiedLabel` ("Copied" by default), while the button keeps its name.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class names merged with `.cinder-copy-button`. |
| `confirmDuration` | `number` | no | — | Duration in ms to show the confirmation state. Default 1500. |
| `copiedLabel` | `string` | no | — | Accessible label for the copied state — what `aria-live="polite"` announces when the copy succeeds. Defaults to "Copied". Override this when `label` is customized so the live-region announcement reflects what just happened (e.g. label="Copy code" + copiedLabel="Code copied"). |
| `html` | `string` | no | — | Optional HTML representation written alongside text/plain through ClipboardItem. |
| `label` | `string` | no | — | Accessible label for the idle state. Defaults to "Copy to clipboard". |
| `textVisible` | `boolean` | no | `false` | Shows the words "Copy", and "Copied" after a copy, after the icon. By default the button is the Copy icon alone (a Check after a copy), named by `label`, which also shows as a tooltip. The button keeps one width in both states. |
| `value` | `string` | yes | — | Text to copy to the clipboard. |
| `children` | `(opaque)` | no | — | The words of the text face at rest, after the Copy icon. Passing them shows the text face. Not expressible in JSON Schema; see the component types for the signature. |
| `confirmation` | `(opaque)` | no | — | The words of the text face once copied, after the Check icon. Defaults to "Copied". Not expressible in JSON Schema; see the component types for the signature. |
| `image` | `(opaque)` | no | — | Optional image blob or URL written alongside text and HTML when supported. Not expressible in JSON Schema; see the component types for the signature. |
| `onError` | `(opaque)` | no | — | Called when the clipboard write fails (permission denied, insecure context, or the legacy execCommand fallback also failing). Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
