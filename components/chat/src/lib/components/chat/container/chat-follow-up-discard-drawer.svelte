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
  import { resolveChatLabels, type ChatLabels } from '../chat-labels.ts';

  let {
    discarded,
    onrestore,
    ondismiss,
    labels,
  }: ChatFollowUpDiscardDrawerProps & { labels?: Partial<ChatLabels> } = $props();
  const words = $derived(resolveChatLabels(labels));
</script>

<!-- A warning notice above the composer when the run was stopped or failed with follow-ups still
     waiting: the tone icon, the sentence, Restore inline, and Callout's own dismiss. -->
<Callout
  class="chat-follow-up-discard"
  variant="warning"
  semantic="note"
  actionLayout="inline"
  aria-label={words.followUpNotSent}
  dismissLabel={words.followUpDismiss}
  onDismiss={ondismiss}
  data-chat-follow-up-discard={discarded.reason}
>
  {#snippet icon()}
    <TriangleAlert class="cinder-icon-sm" aria-hidden="true" />
  {/snippet}
  <span class="chat-follow-up-discard-text" dir="auto">
    {words.followUpDiscardText(discarded.items.length, discarded.reason)}
  </span>
  {#snippet action()}
    <Button
      type="button"
      variant="secondary"
      size="sm"
      class="chat-follow-up-discard-action"
      label={words.followUpRestore}
      onclick={onrestore}
    />
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
</style>
