<script lang="ts" module>
  export const title = 'Transcript: a reply and its message';
  export const description =
    "A reply is plain text with no card or role label; a person's message keeps its tinted bubble. One muted line under each message holds its time, the host's actions (a model name, Reply details, Branch), Copy and, on a reply only, Quote. A message you sent shows Branch and Copy only.";
</script>

<script lang="ts">
  import {
    appendAssistantMessage,
    appendMessages,
    appendUserMessage,
    Chat,
    CINDER_NOTES_METADATA_KEY,
    createConversation,
    markMessageDeliveryFailed,
    markMessageDeliveryPending,
    type ChatAdapter,
  } from '@lostgradient/chat';
  import { Button } from '@lostgradient/cinder';
  const adapter: ChatAdapter = { sendMessage: async () => undefined };
  const conversation = appendAssistantMessage(
    appendUserMessage(
      createConversation({ id: 'transcript-sent' }),
      'Please refund order 4471, it arrived damaged.',
    ),
    'Order 4471 is $42.00, delivered Monday, and the carrier flagged it as damaged. It is inside the 30-day window, so I can refund the full amount to the original card.',
  );
</script>

<div style="block-size: 26rem;">
  <Chat
    id="transcript-sent"
    {conversation}
    surfaceMode="transparent"
    variant="transcript"
    capabilities={{ editing: false, quote: true }}
    composerPlaceholder="Message Tool runner…"
    {adapter}
  >
    {#snippet messageActions({ message })}
      {#if message.role === 'assistant'}
        <span>· Claude Sonnet 5.5</span>
        <Button type="button" size="xs" variant="ghost">Reply details</Button>
      {:else}
        <Button type="button" size="xs" variant="ghost">Branch</Button>
      {/if}
    {/snippet}
  </Chat>
</div>
