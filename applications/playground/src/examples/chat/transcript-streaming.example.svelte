<script lang="ts" module>
  export const title = 'Transcript: a reply that is streaming';
  export const description =
    'While a reply streams it ends in a caret, with no line of time and actions under it yet. Stop replaces Send in the composer.';
</script>

<script lang="ts">
  import {
    appendAssistantMessage,
    appendUserMessage,
    Chat,
    createConversation,
    type ChatAdapter,
  } from '@lostgradient/chat';

  const adapter: ChatAdapter = {
    sendMessage: async () => undefined,
    stopGenerating: async () => undefined,
  };
  const conversation = appendAssistantMessage(
    appendUserMessage(
      createConversation({ id: 'transcript-streaming' }),
      'Also look up order 4398, the same carrier.',
    ),
    'Looking up order 4398…',
  );
</script>

<div style="block-size: 22rem;">
  <Chat
    id="transcript-streaming"
    {conversation}
    surfaceMode="transparent"
    variant="transcript"
    streaming
    capabilities={{ editing: false }}
    composerPlaceholder="Message Tool runner…"
    {adapter}
  />
</div>
