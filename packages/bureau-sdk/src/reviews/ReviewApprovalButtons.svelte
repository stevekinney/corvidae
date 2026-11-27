<script lang="ts">
  import { Button } from '@lostgradient/cinder';
  import type { Snippet } from 'svelte';
  import type { ToolApprovalActions } from './tool-approval-actions.svelte.ts';

  let {
    actions,
    label,
    note = '',
    children,
    controls,
    class: className,
  }: {
    actions: ToolApprovalActions;
    label: string;
    note?: string;
    children?: Snippet;
    controls?: Snippet;
    class?: string;
  } = $props();
</script>

<div role="group" aria-label={label} class={className}>
  {#if controls}
    {@render controls()}
  {:else}
    <Button
      mutating
      data-changes
      variant="primary"
      label="Approve"
      disabled={actions.disabled}
      onclick={() => actions.approve(note)}
    />
    <Button
      mutating
      data-changes
      variant="secondary"
      label="Deny"
      disabled={actions.disabled}
      onclick={() => actions.deny(note)}
    />
  {/if}
  {@render children?.()}
</div>
