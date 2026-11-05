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
| `variant` | `"info"` \| `"success"` \| `"warning"` \| `"danger"` \| `"error"` | no | `"info"` | Visual severity variant. `danger` is the canonical failure-severity spelling, consistent with banner and callout. `error` remains accepted as a deprecated alias. |
| `actions` | `(opaque)` | no | — | Buttons or links that act on the message, such as "Export again" after a failed export. They sit at the alert's trailing edge beside the message, and drop under it where the alert is too narrow for both. Give them the secondary or ghost variant: an alert states a problem, and the page's one primary action stays elsewhere. Not expressible in JSON Schema; see the component types for the signature. |
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
