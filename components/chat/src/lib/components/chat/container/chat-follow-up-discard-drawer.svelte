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
  import { Button, Callout, Tooltip, TriangleAlert, X } from '@lostgradient/cinder';
  import { resolveChatLabels, type ChatLabels } from '../chat-labels.ts';

  let {
    discarded,
    onrestore,
    ondismiss,
    labels,
  }: ChatFollowUpDiscardDrawerProps & { labels?: Partial<ChatLabels> } = $props();
  const words = $derived(resolveChatLabels(labels));
</script>

<!-- A warning drawer above the composer when the run was stopped or failed with follow-ups still
     waiting. The secondary action sits left of the primary one. -->
<Callout
  class="chat-follow-up-discard"
  variant="warning"
  semantic="note"
  actionLayout="stacked"
  aria-label={words.followUpNotSent}
  data-chat-follow-up-discard={discarded.reason}
>
  <span class="chat-follow-up-discard-text" dir="auto">
    <TriangleAlert class="chat-follow-up-discard-glyph cinder-icon-sm" aria-hidden="true" />
    {words.followUpDiscardText(discarded.items.length, discarded.reason)}
  </span>
  {#snippet action()}
    <div class="chat-follow-up-discard-actions">
      <Tooltip text={words.followUpDismiss} placement="top">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          class="chat-follow-up-discard-action"
          label={words.followUpDismiss}
          iconOnly
          aria-label={words.followUpDismiss}
          onclick={ondismiss}
        >
          <X class="cinder-icon-sm" aria-hidden="true" />
        </Button>
      </Tooltip>
      <Button
        type="button"
        variant="primary"
        size="sm"
        class="chat-follow-up-discard-action"
        label={words.followUpRestore}
        onclick={onrestore}
      />
    </div>
  {/snippet}
</Callout>

<style>
  :global(.chat-follow-up-discard) {
    margin-block-end: var(--cinder-space-2);
    font-size: var(--cinder-text-sm);
  }

  :global(.chat-follow-up-discard-text) {
    display: block;
    min-inline-size: 0;
    line-height: var(--cinder-leading-snug);
    text-align: start;
  }

  :global(.chat-follow-up-discard .cinder-callout__content),
  :global(.chat-follow-up-discard .cinder-callout__action) {
    grid-column: 1 / -1;
  }

  :global(.chat-follow-up-discard-glyph) {
    display: inline-block;
    margin-inline-end: var(--cinder-space-1);
    vertical-align: text-bottom;
  }

  :global(.chat-follow-up-discard-actions) {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: flex-end;
    inline-size: 100%;
    gap: var(--cinder-space-2);
  }

  @media (pointer: coarse) {
    :global(.chat-follow-up-discard .chat-follow-up-discard-action) {
      min-block-size: var(--cinder-touch-target-min);
      min-inline-size: var(--cinder-touch-target-min);
    }
  }
</style>
