<script lang="ts">
  /**
   * New chat while the agents it can start with are read (design rows 24o): the page's own layout
   * with placeholders where the agent's avatar, greeting and sentence will be, and the composer
   * already there with its placeholder "Message…" and a Send that cannot be pressed, a placeholder
   * in place of each control. Cinder's `skeleton` owns the timing: nothing is drawn for the first
   * 300 ms, so a quick read never flashes a placeholder, and after 10 s its own status line says
   * the read is slow, with a ghost Cancel that goes back to the chat list. The placeholders shimmer,
   * and are still under `prefers-reduced-motion`.
   */
  import { ChatInput } from '@lostgradient/chat';
  import { Skeleton } from '@lostgradient/cinder';

  import { CHAT_COPY } from '../../app/copy.ts';

  interface NewChatLoadingProps {
    /** Called when the person cancels a read that is taking long. */
    onCancel: () => void;
  }

  let { onCancel }: NewChatLoadingProps = $props();
</script>

<section
  class="weft-chat-route ib-new-chat-loading"
  aria-label={CHAT_COPY.regionLabel}
  data-testid="new-chat-loading"
>
  <Skeleton
    class="ib-new-chat-loading__body"
    label={CHAT_COPY.newChatWelcome.loadingLabel}
    delay={300}
    stillLoadingAfter={10_000}
    stillLoadingLabel={CHAT_COPY.newChatWelcome.stillLoading}
    {onCancel}
  >
    <div class="ib-new-chat-loading__greeting" aria-hidden="true">
      <Skeleton width="3rem" height="3rem" radius="var(--cinder-radius-full)" />
      <Skeleton height="1rem" width="12rem" />
      <Skeleton height="0.75rem" width="16rem" />
    </div>
    <div class="ib-new-chat-loading__composer">
      <ChatInput
        id="new-chat-loading-composer"
        placeholder={CHAT_COPY.newChatWelcome.loadingPlaceholder}
        allowAttachments={false}
        disabled
      >
        {#snippet controls()}
          <span class="ib-new-chat-loading__controls" aria-hidden="true">
            <Skeleton height="2rem" width="5rem" radius="var(--cinder-radius-full)" />
            <Skeleton height="2rem" width="6.5rem" radius="var(--cinder-radius-full)" />
          </span>
        {/snippet}
      </ChatInput>
    </div>
  </Skeleton>
</section>

<style>
  .ib-new-chat-loading :global(.ib-new-chat-loading__body) {
    flex: 1;
    justify-content: center;
    min-block-size: 0;
  }

  .ib-new-chat-loading__greeting {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    align-items: center;
    padding-block-end: var(--cinder-space-6);
  }

  .ib-new-chat-loading__composer {
    inline-size: 100%;
    max-inline-size: 42rem;
    margin-inline: auto;
  }

  .ib-new-chat-loading__controls {
    display: inline-flex;
    gap: var(--cinder-space-2);
  }
</style>
