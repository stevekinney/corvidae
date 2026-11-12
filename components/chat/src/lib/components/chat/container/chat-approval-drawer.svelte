<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type { ChatLabels } from '../chat-labels.ts';

  export type ChatApprovalDrawerProps = {
    /** Called when Review approval is activated: take the person to the approval that waits. */
    onreview: () => void;
    labels: ChatLabels;
    /** Transcript navigation shares the action row when present. */
    navigation?: Snippet;
  };
</script>

<script lang="ts">
  import { Button } from '@lostgradient/cinder';
  let { onreview, labels, navigation }: ChatApprovalDrawerProps = $props();
</script>

<!-- A compact navigation action above the composer while an approval waits. The transcript card
     owns the detailed explanation; this short status names why the composer is paused without
     repeating the question, facts, or decision controls. -->
<div
  class="chat-approval-drawer"
  role="group"
  aria-label={labels.approvalWaiting}
  data-chat-approval-drawer
>
  <p class="chat-approval-drawer-text">{labels.approvalWaitingText}</p>
  <div class="chat-approval-drawer-actions">
    <Button
      type="button"
      variant="secondary"
      size="sm"
      class="chat-approval-drawer-action"
      label={labels.reviewApproval}
      aria-label={labels.reviewApproval}
      onclick={onreview}>{labels.reviewApproval}</Button
    >
    {@render navigation?.()}
  </div>
</div>

<style>
  .chat-approval-drawer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-2);
    margin-block: var(--cinder-space-1);
    padding-inline: var(--cinder-space-1);
    border: 0;
    border-radius: var(--cinder-radius-lg);
  }

  .chat-approval-drawer-text {
    min-inline-size: 0;
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-xs);
    line-height: var(--cinder-leading-snug);
  }

  .chat-approval-drawer-actions {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-2);
    flex: none;
  }

  /* Coarse pointers get a target of at least 44 px. */
  @media (any-pointer: coarse) {
    .chat-approval-drawer :global(.chat-approval-drawer-action) {
      min-block-size: var(--cinder-touch-target-min);
      min-inline-size: var(--cinder-touch-target-min);
    }
  }
</style>
