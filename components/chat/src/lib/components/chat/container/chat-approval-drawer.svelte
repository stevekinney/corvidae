<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type { ChatLabels } from '../chat-labels.ts';

  export type ChatApprovalDrawerProps = {
    /** Called when Review approval is activated: take the person to the approval that waits. */
    onreview: () => void;
    labels: ChatLabels;
    /** The composer holds a draft: the reminder adds what sending it does now. */
    draft?: boolean;
    /** Transcript navigation shares the action row when present. */
    navigation?: Snippet;
  };
</script>

<script lang="ts">
  import { Button, Callout, Info } from '@lostgradient/cinder';
  let { onreview, labels, draft = false, navigation }: ChatApprovalDrawerProps = $props();
</script>

<!-- One line above the composer while the approval card is out of view: the sentence names why the
     composer is paused, and Review approval takes the person to the card. The card owns the
     detail. -->
<Callout
  class="chat-approval-drawer"
  semantic="note"
  aria-label={labels.approvalWaiting}
  data-chat-approval-drawer
>
  {#snippet icon()}
    <Info class="cinder-icon-sm" aria-hidden="true" />
  {/snippet}
  <span class="chat-approval-drawer-text"
    >{draft
      ? `${labels.approvalWaitingText} ${labels.approvalQueueNote}`
      : labels.approvalWaitingText}</span
  >
  {#snippet action()}
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
  {/snippet}
</Callout>

<style>
  :global(.chat-approval-drawer) {
    margin-block: var(--cinder-space-1);
  }

  :global(.chat-approval-drawer-text) {
    min-inline-size: 0;
    line-height: var(--cinder-leading-snug);
  }
</style>
