<script lang="ts">
  /**
   * An open chat while it is read (design rows 17j and 17y): the page's own layout with
   * placeholders where the chat will be, so nothing moves when it arrives. The heading and the
   * conversation are placeholders; the composer is the real one, with the agent's placeholder text,
   * a placeholder in place of each select, and Send that cannot be pressed until the chat loads.
   * Cinder's `skeleton` owns the timing: nothing is drawn for the first 300 ms, so a quick read
   * never flashes a placeholder, and after 10 s its own status line says the read is slow, above the
   * composer, with a ghost Cancel that goes back to the list. The placeholders shimmer, and are
   * still under `prefers-reduced-motion`.
   */
  import { ChatInput } from '@lostgradient/chat';
  import { Skeleton } from '@lostgradient/cinder';

  import { CHAT_COPY } from '../../app/copy/chat.ts';

  interface ChatLoadingProps {
    /** The agent the chat is with, as a person reads it, when the list has said; the composer asks for a message to it. */
    agent?: string | undefined;
    /** Called when the person cancels a read that is taking long. */
    onCancel: () => void;
  }

  let { agent, onCancel }: ChatLoadingProps = $props();
</script>

<section
  class="weft-chat-route ib-chat-loading"
  aria-label={CHAT_COPY.regionLabel}
  data-testid="chat-loading"
>
  <Skeleton
    class="ib-chat-loading__body"
    label={CHAT_COPY.load.loadingLabel}
    delay={300}
    stillLoadingAfter={10_000}
    stillLoadingLabel={CHAT_COPY.load.stillLoading}
    {onCancel}
  >
    <div class="ib-chat-loading__heading" aria-hidden="true">
      <Skeleton height="1.5rem" width="16rem" />
    </div>
    <div class="ib-chat-loading__transcript" aria-hidden="true">
      <div class="ib-chat-loading__user">
        <Skeleton height="2.25rem" width="min(15rem, 60%)" radius="var(--cinder-radius-lg)" />
      </div>
      <div class="ib-chat-loading__reply">
        <Skeleton height="0.75rem" width="85%" />
        <Skeleton height="0.75rem" width="70%" />
        <Skeleton height="0.75rem" width="50%" />
      </div>
      <div class="ib-chat-loading__user">
        <Skeleton height="2.25rem" width="min(12rem, 50%)" radius="var(--cinder-radius-lg)" />
      </div>
    </div>
    <!-- Last in the markup and drawn last (`order`), so the status line the skeleton adds sits
         between the placeholders and the composer. -->
    <div class="ib-chat-loading__composer">
      <ChatInput
        id="chat-loading-composer"
        placeholder={CHAT_COPY.composer.placeholder(agent ?? CHAT_COPY.load.unnamedAgent)}
        allowAttachments={false}
        disabled
      >
        {#snippet controls()}
          <span class="ib-chat-loading__controls" aria-hidden="true">
            <Skeleton height="2rem" width="9.5rem" radius="var(--cinder-radius-md)" />
            <Skeleton height="2rem" width="6rem" radius="var(--cinder-radius-md)" />
            <Skeleton height="2rem" width="10.5rem" radius="var(--cinder-radius-md)" />
          </span>
        {/snippet}
      </ChatInput>
    </div>
  </Skeleton>
</section>

<style>
  .ib-chat-loading :global(.ib-chat-loading__body) {
    flex: 1;
    min-block-size: 0;
  }

  /* The conversation's own inset (board frame e): the heading row is padded and its rule runs edge
   * to edge, the transcript and the composer sit a step in from the pane, so nothing jumps when the
   * chat arrives. */
  .ib-chat-loading__heading {
    padding: var(--cinder-space-5) var(--cinder-space-4);
    border-block-end: 1px solid var(--cinder-border-muted);
  }

  .ib-chat-loading__transcript {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--cinder-space-6);
    min-block-size: 0;
    padding: var(--cinder-space-4);
  }

  .ib-chat-loading__user {
    display: flex;
    justify-content: flex-end;
  }

  .ib-chat-loading__reply {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
  }

  .ib-chat-loading__composer {
    order: 1;
    padding-inline: var(--cinder-space-4);
    padding-block-end: var(--cinder-space-4);
  }

  .ib-chat-loading__controls {
    display: inline-flex;
    gap: var(--cinder-space-2);
  }
</style>
