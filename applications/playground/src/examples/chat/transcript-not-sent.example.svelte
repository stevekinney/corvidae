<script lang="ts" module>
  export const title = 'Transcript: a message that was not sent';
  export const description =
    'Online, a message that could not be delivered keeps its bubble and shows a focusable red icon, its time and the red words "Not sent". The icon opens a popover that says "Not sent. Interborough couldn\'t deliver this message. Your message is kept." with an enabled Retry button.';
</script>

<script lang="ts">
  import {
    appendAssistantMessage,
    appendUserMessage,
    Chat,
    createConversation,
    markMessageDeliveryFailed,
    type ChatAdapter,
  } from '@lostgradient/chat';
  const adapter: ChatAdapter = {
    sendMessage: async () => undefined,
    retryMessage: async () => undefined,
  };
  const base = appendUserMessage(
    appendAssistantMessage(
      appendUserMessage(
        createConversation({ id: 'transcript-not-sent' }),
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
    id="transcript-not-sent"
    {conversation}
    surfaceMode="transparent"
    variant="transcript"
    capabilities={{ editing: false }}
    composerPlaceholder="Message Tool runner…"
    {adapter}
    notSent={{
      summary: 'Not sent. Interborough couldn’t deliver this message. Your message is kept.',
    }}
  />
</div>
