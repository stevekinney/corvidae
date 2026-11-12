# Citation

<!-- generated:a11y-record:required -->

`Citation` pairs an inline source marker with a Popover of source details. Up to five sources are listed together, in the order given; more are paged one at a time.

Each source shows its title (clamped to two lines), its excerpt in quotation marks, and one of three things under them: an "Open example.com ↗" link for a safe web address, "Internal document, no public link" when it has no address, or "Link hidden: the address isn't a safe web link" when its address is refused. `resolveCitationLink` applies the same policy for a host that draws sources itself. Pass `labels` to translate the words Citation draws.

## Usage

```svelte
<script lang="ts">
  import { Citation } from '@lostgradient/cinder';
</script>

<Citation sources={[{ label: 'Component metadata guide', url: '/docs/components' }]} />
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with `.cinder-citation`. |
| `label` | `string` | no | — | Names the marker and the panel, such as `Sources`. The marker reads it with the source count. |
| `closeOnSourceRemoval` | `boolean` | no | `false` | Closes an open panel when a previously displayed source is withdrawn by the host. |
| `onCloseComplete` | `() => void` | no | — | Called after an open source panel or sheet has fully closed. |
| `children` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `labels` | `(opaque)` | no | — | The words Citation draws itself, for a host that translates them. Each one left out keeps its English default. Not expressible in JSON Schema; see the component types for the signature. |
| `sources` | `(opaque)` | yes | — | The sources behind the claim, in the order to show them. Up to five are listed together; more are paged one at a time. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## Authoring checklist

<!-- generated:authoring:start -->

Before publishing this component, complete the live [component authoring pre-flight](../../../README.md#component-authoring-checklist).
<!-- generated:authoring:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
