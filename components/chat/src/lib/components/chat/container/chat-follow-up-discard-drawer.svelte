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
  import { Button, Callout, TriangleAlert } from '@lostgradient/cinder';
  import {
    FOLLOW_UP_DISMISS_LABEL,
    FOLLOW_UP_RESTORE_LABEL,
    followUpDiscardText,
  } from './chat-follow-up-queue.ts';

  let { discarded, onrestore, ondismiss }: ChatFollowUpDiscardDrawerProps = $props();
</script>

<!-- A warning drawer above the composer when the run was stopped or failed with follow-ups still
     waiting. The secondary action sits left of the primary one. -->
<Callout
  class="chat-follow-up-discard"
  variant="warning"
  semantic="note"
  actionLayout="inline"
  aria-label="Follow-ups not sent"
  data-chat-follow-up-discard={discarded.reason}
>
  <span class="chat-follow-up-discard-text" dir="auto">
    <TriangleAlert class="chat-follow-up-discard-glyph cinder-icon-sm" aria-hidden="true" />
    {followUpDiscardText(discarded.items.length, discarded.reason)}
  </span>
  {#snippet action()}
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
  {/snippet}
</Callout>

<style>
  :global(.chat-follow-up-discard) {
    display: block;
    margin-block-end: var(--cinder-space-2);
    font-size: var(--cinder-text-sm);
  }

  :global(.chat-follow-up-discard-text) {
    display: inline-flex;
    align-items: center;
    gap: var(--cinder-space-1);
    min-inline-size: 0;
    line-height: var(--cinder-leading-snug);
    text-align: start;
  }

  :global(.chat-follow-up-discard-actions) {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--cinder-space-2);
  }

  @media (pointer: coarse) {
    :global(.chat-follow-up-discard .chat-follow-up-discard-action) {
      min-block-size: var(--cinder-touch-target-min);
    }
  }
</style>
