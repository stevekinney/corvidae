# Alert

A status message that communicates contextual feedback and can optionally be dismissed.

## Usage

```svelte
<script lang="ts">
  import { Alert } from '@lostgradient/cinder';
</script>

<Alert variant="success">Saved successfully.</Alert>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with `.cinder-alert`. |
| `dismissible` | `boolean` | no | `false` | Allow the alert to be dismissed. |
| `heading` | `string` | no | — | A bold first line in the status colour. With a heading, the alert draws its variant's glyph when no `icon` is given, and its body reads in the default text colour. |
| `variant` | `"info"` \| `"success"` \| `"warning"` \| `"danger"` \| `"error"` | no | `"info"` | Visual severity variant. `danger` is the canonical failure-severity spelling, consistent with banner and callout. `error` remains accepted as a deprecated alias. |
| `actions` | `(opaque)` | no | — | Buttons at the right edge, beside the content and before the dismiss button. Not expressible in JSON Schema; see the component types for the signature. |
| `children` | `(opaque)` | yes | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `icon` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onDismiss` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

- `--cinder-alert-info`

<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

<!-- generated:subcomponents:end -->
