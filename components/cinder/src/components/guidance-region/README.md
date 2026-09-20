# GuidanceRegion

`GuidanceRegion` provides a context-scoped claim registry. Claims are filtered by version windows and can be dismissed or reset through a consumer-owned storage adapter.

## Usage

```svelte
<script lang="ts">
  import { Button } from '@corvidae/cinder';
  import { GuidanceRegion, type GuidanceClaim, useGuidance } from '@corvidae/cinder';

  const claims = [
    { id: 'welcome', anchor: 'workspace-start', content: 'Start by exploring the workspace.' },
  ] satisfies GuidanceClaim[];
</script>

<GuidanceRegion
  {claims}
  version="1.0.0"
  anchorResolver={() => document.getElementById('workspace-start')}
>
  {#snippet children()}
    {@const guidance = useGuidance()}
    <Button id="workspace-start" onclick={() => guidance.claim('welcome')}>
      Show welcome guidance
    </Button>
  {/snippet}
</GuidanceRegion>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `storageKey` | `string` | no | `"cinder-guidance"` | Key used to namespace dismissal state in the storage adapter. Defaults to `'cinder-guidance'`—regions sharing one storage adapter without an explicit `storageKey` collide in that namespace. |
| `version` | `string` | no | — | Version window claims are filtered against. |
| `anchorResolver` | `(opaque)` | no | — | Resolves a claim anchor using consumer-owned DOM knowledge. Not expressible in JSON Schema; see the component types for the signature. |
| `children` | `(opaque)` | no | — | Descendant application surface that consumes guidance through `useGuidance`. Not expressible in JSON Schema; see the component types for the signature. |
| `claims` | `(opaque)` | no | — | Registered guidance claims available to descendants through `useGuidance`. Not expressible in JSON Schema; see the component types for the signature. |
| `storage` | `(opaque)` | no | — | Adapter used to persist which claims a user has dismissed, so dismissal survives a reload. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->
