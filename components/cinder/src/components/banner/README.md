# Banner

Full-width announcement strip for page-level alerts, promotions, or system messages.

## Usage

```svelte
<script lang="ts">
  import { Banner } from '@lostgradient/cinder';
</script>

<Banner>Your message here.</Banner>
```

### Unreachable preset

When the server or the connection is down, `preset="unreachable"` renders a warning banner named "Connection problem". Add `onRetry` for a Retry button and `dataUpdatedAt` for a stale-data notice with the live age of the data still on screen:

```svelte
<script lang="ts">
  import { Banner } from '@lostgradient/cinder';

  let updatedAt = $state(new Date(Date.now() - 120_000));
</script>

<Banner
  preset="unreachable"
  dismissible={false}
  dataUpdatedAt={updatedAt}
  onRetry={() => (updatedAt = new Date())}
>
  Can't reach the server. Retrying in 8 seconds.
</Banner>
```

The preset overrides `variant` with `warning`. Retry renders in the actions region before any `actions` snippet. The notice reads "Showing data from" and a relative time such as "2 minutes ago", and it keeps ticking. Use a banner only for the server or the connection; show a failure of one field, row, or step where it happened.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Extra classes appended to the root element. Pass via the explicit `class` prop — it is excluded from rest-prop spread, so writing `class="x"` inside spread attributes will not reach the root. |
| `dismissible` | `boolean` | no | `true` | Whether the banner shows a dismiss (×) button. Default `true`. |
| `preset` | `"unreachable"` | no | — | Applies a ready-made configuration. `'unreachable'` overrides `variant` with `'warning'` and names the region "Connection problem" unless `aria-label` or `aria-labelledby` is passed. Pair it with `onRetry` and `dataUpdatedAt`. |
| `retryLabel` | `string` | no | `"Retry"` | Label of the Retry button. |
| `staleDataLabel` | `string` | no | `"Showing data from"` | Text that precedes the relative time in the stale-data notice. |
| `variant` | `"info"` \| `"success"` \| `"warning"` \| `"danger"` | no | `"info"` | Visual + semantic variant. Default `'info'`. |
| `actions` | `(opaque)` | no | — | Optional trailing CTA region (e.g., "Renew now" button). Not expressible in JSON Schema; see the component types for the signature. |
| `children` | `(opaque)` | yes | — | Banner body content. Not expressible in JSON Schema; see the component types for the signature. |
| `dataUpdatedAt` | `(opaque)` | no | — | When the data still on screen was last fetched. Adds a stale-data notice that reads "Showing data from" followed by a live relative time such as "2 minutes ago". Not expressible in JSON Schema; see the component types for the signature. |
| `onDismiss` | `(opaque)` | no | — | Called after the dismiss button is clicked. Use to persist state. Not expressible in JSON Schema; see the component types for the signature. |
| `onRetry` | `(opaque)` | no | — | Called when the Retry button is pressed. The button renders in the actions region, before `actions`, only when this is set. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
