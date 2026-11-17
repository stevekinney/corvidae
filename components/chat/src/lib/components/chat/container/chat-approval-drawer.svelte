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
     detail. On a phone the button reads only Review (its name stays Review approval) and the
     Callout's fit layout keeps it beside the words while both fit, so the reminder stays one row
     and the transcript keeps its room. -->
<Callout
  class="chat-approval-drawer"
  semantic="note"
  actionLayout="fit"
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
      aria-label={labels.reviewApproval}
      onclick={onreview}
    >
      <span class="chat-approval-drawer-action-full">{labels.reviewApproval}</span>
      <span class="chat-approval-drawer-action-short" aria-hidden="true"
        >{labels.reviewApprovalShort}</span
      >
    </Button>
    {@render navigation?.()}
  {/snippet}
</Callout>

<style>
  /* The docked stack keeps one gap between its surfaces: the reminder stands --cinder-space-3 clear
     of the composer or the blocked row under it, at every width (COR-2327). */
  :global(.chat-approval-drawer) {
    margin-block: var(--cinder-space-1) var(--cinder-space-3);
  }

  :global(.chat-approval-drawer-text) {
    min-inline-size: 0;
  }

  .chat-approval-drawer-action-short {
    display: none;
  }

  /* The Callout is its own inline-size container: under 30rem the button reads Review, so the
     words and the button fit one row. */
  @container (inline-size < 30rem) {
    .chat-approval-drawer-action-full {
      display: none;
    }

    .chat-approval-drawer-action-short {
      display: inline;
    }
  }
</style>
