<script lang="ts" module>
  import type { DiscardedFollowUps } from './chat-follow-up-queue.ts';

  export type ChatFollowUpDiscardDrawerProps = {
    /** The follow-ups set aside, and why. */
    discarded: DiscardedFollowUps;
    /** Called when Restore is activated: put the follow-ups back in the composer. */
    onrestore: () => void;
    /** Called when Dismiss is activated: forget them. */
    ondismiss: () => void;
  };
</script>

<script lang="ts">
  import { Button, TriangleAlert } from '@lostgradient/cinder';
  import {
    FOLLOW_UP_DISMISS_LABEL,
    FOLLOW_UP_RESTORE_LABEL,
    followUpDiscardText,
  } from './chat-follow-up-queue.ts';

  let { discarded, onrestore, ondismiss }: ChatFollowUpDiscardDrawerProps = $props();
</script>

<!-- A warning drawer above the composer when the run was stopped or failed with follow-ups still
     waiting. The secondary action sits left of the primary one. -->
<div
  class="chat-follow-up-discard"
  role="group"
  aria-label="Follow-ups not sent"
  data-chat-follow-up-discard={discarded.reason}
>
  <TriangleAlert class="chat-follow-up-discard-glyph cinder-icon-sm" aria-hidden="true" />
  <p class="chat-follow-up-discard-text" dir="auto">
    {followUpDiscardText(discarded.items.length, discarded.reason)}
  </p>
  <div class="chat-follow-up-discard-actions">
    <Button
      type="button"
      variant="secondary"
      size="sm"
      class="chat-follow-up-discard-action"
      label={FOLLOW_UP_DISMISS_LABEL}
      onclick={ondismiss}
    />
    <Button
      type="button"
      variant="primary"
      size="sm"
      class="chat-follow-up-discard-action"
      label={FOLLOW_UP_RESTORE_LABEL}
      onclick={onrestore}
    />
  </div>
</div>

<style>
  .chat-follow-up-discard {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2) var(--cinder-space-3);
    margin-block-end: var(--cinder-space-2);
    padding: var(--cinder-space-2) var(--cinder-space-3);
    border: 1px solid var(--cinder-status-warning-border);
    border-radius: var(--cinder-radius-lg);
    background: var(--cinder-status-warning-background);
    color: var(--cinder-status-warning-text);
    font-size: var(--cinder-text-sm);
  }

  .chat-follow-up-discard :global(.chat-follow-up-discard-glyph) {
    flex: none;
  }

  .chat-follow-up-discard-text {
    flex: 1 1 14rem;
    min-inline-size: 0;
    margin: 0;
    line-height: var(--cinder-leading-snug);
    text-align: start;
  }

  .chat-follow-up-discard-actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--cinder-space-2);
    margin-inline-start: auto;
  }

  @media (pointer: coarse) {
    .chat-follow-up-discard :global(.chat-follow-up-discard-action) {
      min-block-size: var(--cinder-touch-target-min);
    }
  }
</style>
