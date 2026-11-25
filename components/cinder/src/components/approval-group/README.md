# ApprovalGroup

<!-- generated:a11y-record:required -->

Two or more approvals waiting together, as one bordered group of compact rows under a heading such as "2 approvals waiting". Each row is an `ApprovalCard` in the `row` layout, which gives up its own border inside the group, so the group is the only box.

## Usage

```svelte
<script lang="ts">
  import { ApprovalCard, ApprovalGroup, type ApprovalCardProps } from '@lostgradient/cinder';

  let { approvals }: { approvals: ApprovalCardProps[] } = $props();
</script>

<ApprovalGroup heading={`${approvals.length} approvals waiting`}>
  {#each approvals as approval (approval.idempotencyKey)}
    <div>
      <ApprovalCard {...approval} layout="row" />
    </div>
  {/each}
</ApprovalGroup>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with `.cinder-approval-group`. |
| `heading` | `string` | yes | — | The group's heading, which also names it, such as `2 approvals waiting`. Written at the top of the one bordered surface the rows share. |
| `headingLevel` | `2` \| `3` \| `4` \| `5` \| `6` | no | — | The heading's level, so the group slots into the page's outline. Default `3`. |
| `children` | `(opaque)` | yes | — | The rows: ApprovalCards in the `row` layout, each in an element of its own. They lose their own border and stand one inset separator apart on the group's surface. Not expressible in JSON Schema; see the component types for the signature. |

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
