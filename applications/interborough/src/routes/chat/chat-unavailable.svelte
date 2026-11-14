<script lang="ts">
  /**
   * An open chat that cannot be shown yet (COR-2285, rows V2 and V3): Chat's own `availability`
   * states stand where the conversation will be, in the page's layout. While the chat is read,
   * Chat draws skeleton turns with `Loading this chat…` and the seconds so far, keeps the editor,
   * and has Send wait for the history; once the read is slow it says so with the elapsed time and
   * Cancel. A canceled read offers Retry; a read that failed is Cinder's `ErrorState` with Try again
   * and All conversations, and no composer.
   *
   * Nothing is drawn for the first 300 ms, so a quick read never flashes a placeholder. What the
   * person types meanwhile goes to `onDraft`, so the conversation that replaces this one starts
   * with it in the box.
   */
  import { Chat, createConversationHistory, type ChatAvailability } from '@lostgradient/chat';
  import { Skeleton, VisuallyHidden } from '@lostgradient/cinder';
  import { untrack } from 'svelte';

  import { CHAT_COPY } from '../../app/copy/chat.ts';

  interface ChatUnavailableProps {
    /** The chat's identifier, for the stand-in conversation's own. */
    sessionId: string;
    /** Which state the chat is in: loading, a canceled read, or a read that failed. */
    availability: ChatAvailability;
    /** The agent the chat is with, as a person reads it, when the list has said; the composer asks for a message to it. */
    agent?: string | undefined;
    /** Hears what the person types while the chat is read. */
    onDraft?: ((text: string) => void) | undefined;
  }

  let { sessionId, availability, agent, onDraft }: ChatUnavailableProps = $props();

  /** How long a read may take before anything is drawn for it, as Cinder's skeleton waits. */
  const NO_FLASH_MILLISECONDS = 300;

  const conversation = createConversationHistory({ id: untrack(() => `${sessionId}-unavailable`) });

  // A failed read is said at once; only the placeholders of a read wait, so a quick read never
  // flashes them, as Cinder's skeleton waits 300 ms.
  let waited = $state(false);
  $effect(() => {
    // poll-reason: timer
    const timer = setTimeout(() => (waited = true), NO_FLASH_MILLISECONDS);
    return () => clearTimeout(timer);
  });
  const shown = $derived(waited || availability.kind !== 'loading');
</script>

<section
  class="weft-chat-route ib-chat-unavailable"
  aria-label={CHAT_COPY.regionLabel}
  data-testid="chat-unavailable"
  data-availability={availability.kind}
>
  <VisuallyHidden><h1>{CHAT_COPY.load.crumb}</h1></VisuallyHidden>
  {#if shown}
    {#if availability.kind === 'loading'}
      <!-- Where the chat's heading will be, so nothing moves when it arrives. -->
      <div class="ib-chat-unavailable__heading" aria-hidden="true">
        <Skeleton height="1.5rem" width="16rem" />
      </div>
    {/if}
    <div class="weft-chat-surface">
      <Chat
        id={`chat-unavailable-${sessionId}`}
        {conversation}
        {availability}
        surfaceMode="transparent"
        variant="transcript"
        composerPlaceholder={CHAT_COPY.composer.placeholder(agent ?? CHAT_COPY.load.unnamedAgent)}
        onComposerInput={(value) => onDraft?.(value)}
      />
    </div>
  {/if}
</section>

<style>
  /* The conversation's own inset: the heading row is padded and its rule runs edge to edge. */
  .ib-chat-unavailable__heading {
    padding: var(--cinder-space-5) var(--cinder-space-4);
    border-block-end: 1px solid var(--cinder-border-muted);
  }
</style>
