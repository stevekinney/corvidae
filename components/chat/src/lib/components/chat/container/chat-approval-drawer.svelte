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
  import { Button, Info } from '@lostgradient/cinder';
  let { onreview, labels, draft = false, navigation }: ChatApprovalDrawerProps = $props();
</script>

<!-- One row above the composer while the approval card is out of view: the glyph, the sentence that
     names why the composer is paused, and Review at the row's end, which takes the person to the
     card. The card owns the detail. The row never stacks its action under the words: on a phone the
     button reads only Review (its name stays Review approval), so the row stays one row and the
     transcript keeps its room. Callout would put the action on a line of its own under 30rem, so
     the drawer draws its own row in the neutral note's colours. -->
<div
  class="chat-approval-drawer"
  role="note"
  aria-label={labels.approvalWaiting}
  data-chat-approval-drawer
>
  <div class="chat-approval-drawer-row">
    <Info class="chat-approval-drawer-glyph cinder-icon-sm" aria-hidden="true" />
    <span class="chat-approval-drawer-text"
      >{draft
        ? `${labels.approvalWaitingText} ${labels.approvalQueueNote}`
        : labels.approvalWaitingText}</span
    >
    <span class="chat-approval-drawer-actions">
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
    </span>
  </div>
</div>

<style>
  .chat-approval-drawer {
    /* The row asks how wide the composer's column is, not the screen: a tablet's pane is as
       narrow as a phone. */
    container-type: inline-size;
    margin-block: var(--cinder-space-1);
  }

  .chat-approval-drawer-row {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-2);
    padding-block: var(--cinder-space-1-5);
    padding-inline: var(--cinder-space-3);
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    background: var(--cinder-surface-inset);
    color: var(--cinder-text-default);
    font-size: var(--cinder-text-sm);
    line-height: var(--cinder-leading-snug);
  }

  .chat-approval-drawer-row :global(.chat-approval-drawer-glyph) {
    flex: none;
    color: var(--cinder-text-subtle);
  }

  .chat-approval-drawer-text {
    flex: 1 1 auto;
    min-inline-size: 0;
  }

  .chat-approval-drawer-actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--cinder-space-2);
    margin-inline-start: auto;
  }

  .chat-approval-drawer-action-short {
    display: none;
  }

  /* A narrow column: the button reads Review, so the words keep the rest of the row. */
  @container (inline-size < 30rem) {
    .chat-approval-drawer-action-full {
      display: none;
    }

    .chat-approval-drawer-action-short {
      display: inline;
    }
  }

  @media (forced-colors: active) {
    .chat-approval-drawer-row {
      border-color: CanvasText;
    }
  }
</style>
