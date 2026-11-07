<script lang="ts">
  /**
   * What a new chat says under its composer when the first message could not be sent (design rows
   * 24c and 24r): that the chat did not start, why, and that the typed text is still in the box,
   * with a Retry that sends it again. It is the page's own line, not an alert above the page, and no
   * chat page opens behind it. While Interborough cannot be reached at all the shell's banner is the
   * one account of that, so the page draws none of this (row 24s).
   */
  import { Button } from '@lostgradient/cinder';
  import { CircleAlert } from '@lucide/svelte';

  import { CHAT_COPY } from '../../app/copy.ts';

  interface NewChatFailureProps {
    /** Why the chat did not start, as a sentence: that Interborough did not answer, or what it refused with. */
    reason: string;
    /** Called when the person chooses Retry. */
    onRetry: () => void;
  }

  let { reason, onRetry }: NewChatFailureProps = $props();

  const copy = CHAT_COPY.newChatWelcome.startFailed;
  /** A reason ends like a sentence, whatever the server wrote. */
  const sentence = $derived(/[.!?…]$/.test(reason.trim()) ? reason.trim() : `${reason.trim()}.`);
</script>

<div class="ib-new-chat-failure" role="alert" data-testid="new-chat-failure">
  <CircleAlert class="ib-new-chat-failure__glyph" size={16} aria-hidden="true" />
  <span class="ib-new-chat-failure__message">{copy.lead} {sentence} {copy.kept}</span>
  <Button size="sm" variant="secondary" label={copy.retry} onclick={onRetry} />
</div>

<style>
  .ib-new-chat-failure {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    align-items: center;
    justify-content: center;
    color: var(--cinder-status-danger-text);
    font-size: var(--cinder-text-sm);
  }

  .ib-new-chat-failure :global(.ib-new-chat-failure__glyph) {
    flex: none;
  }

  .ib-new-chat-failure__message {
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }
</style>
