<script lang="ts" module>
  import type { Snippet } from 'svelte';

  export type ChatApprovalDrawerProps = {
    /** Called when Review approval is activated: take the person to the approval that waits. */
    onreview: () => void;
    /** Transcript navigation shares the action row when present. */
    navigation?: Snippet;
  };
</script>

<script lang="ts">
  import { Button } from '@lostgradient/cinder';
  import { APPROVAL_DRAWER_ACTION } from './chat-approval-review.ts';

  let { onreview, navigation }: ChatApprovalDrawerProps = $props();
</script>

<!-- A compact navigation action above the composer while an approval waits. The transcript card
     owns the explanation and decision controls, so this row does not repeat its status. -->
<div
  class="chat-approval-drawer"
  role="group"
  aria-label="Approval waiting"
  data-chat-approval-drawer
>
  <div class="chat-approval-drawer-actions">
    <Button
      type="button"
      variant="secondary"
      size="sm"
      class="chat-approval-drawer-action"
      label={APPROVAL_DRAWER_ACTION}
      aria-label={APPROVAL_DRAWER_ACTION}
      onclick={onreview}
    >
      Review
    </Button>
    {@render navigation?.()}
  </div>
</div>

<style>
  .chat-approval-drawer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--cinder-space-2);
    margin-block: var(--cinder-space-1);
    padding-inline: var(--cinder-space-1);
    border: 0;
    border-radius: var(--cinder-radius-lg);
  }

  .chat-approval-drawer-actions {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-2);
  }

  /* Coarse pointers get a target of at least 44 px. */
  @media (any-pointer: coarse) {
    .chat-approval-drawer :global(.chat-approval-drawer-action) {
      min-block-size: var(--cinder-touch-target-min);
      min-inline-size: var(--cinder-touch-target-min);
    }
  }
</style>
