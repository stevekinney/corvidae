<script lang="ts" module>
  export const title = 'Transcript: not sent while the server is unreachable';
  export const description =
    'With the server unreachable the message stays visible as "Not sent". Its popover says "Not sent. Interborough can\'t be reached. Your message is kept.", Retry is inert, and "Retries when you\'re back online." says when it will try again.';
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
  const adapter: ChatAdapter = {
    sendMessage: async () => undefined,
    retryMessage: async () => undefined,
  };
  const base = appendUserMessage(
    appendAssistantMessage(
      appendUserMessage(
        createConversation({ id: 'transcript-not-sent-unreachable' }),
        'Please refund order 4471, it arrived damaged.',
      ),
      'Order 4471 is $42.00 and was flagged as damaged.',
    ),
    'Also look up order 4398, the same carrier.',
  );
  // The last message is the one that was not sent.
  const conversation = markMessageDeliveryFailed(base, base.ids[base.ids.length - 1]!);
</script>

<div style="block-size: 26rem;">
  <Chat
    id="transcript-not-sent-unreachable"
    {conversation}
    surfaceMode="transparent"
    variant="transcript"
    capabilities={{ editing: false }}
    composerPlaceholder="Message Tool runner…"
    {adapter}
    notSent={{
      summary: 'Not sent. Interborough can’t be reached. Your message is kept.',
      retryDisabled: true,
      retryNote: 'Retries when you’re back online.',
    }}
  />
</div>
