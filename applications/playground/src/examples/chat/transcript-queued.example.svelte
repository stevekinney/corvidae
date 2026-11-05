<script lang="ts" module>
  export const title = 'Transcript: a queued follow-up';
  export const description =
    'A message sent while the run is working is a dashed, pale bubble marked "Queued · sends when the run is ready", with Remove when the host can take it back. It never looks sent before the run reaches it, and becomes a normal message then.';
</script>

<script lang="ts">
  import {
    appendAssistantMessage,
    appendUserMessage,
    Chat,
    createConversation,
    markMessageDeliveryPending,
    type ChatAdapter,
  } from '@lostgradient/chat';
  const adapter: ChatAdapter = {
    sendMessage: async () => undefined,
    sendRunInput: async () => undefined,
    stopGenerating: async () => undefined,
  };
  const base = appendUserMessage(
    appendAssistantMessage(
      appendUserMessage(
        createConversation({ id: 'transcript-queued' }),
        'Also look up order 4398, the same carrier.',
      ),
      'Order 4398 is $27.25 and was delivered Friday. Checking the carrier’s damage notes',
    ),
    'Then look up order 4476.',
  );
  const conversation = markMessageDeliveryPending(base, base.ids[base.ids.length - 1]!);
</script>

<div style="block-size: 26rem;">
  <Chat
    id="transcript-queued"
    {conversation}
    surfaceMode="transparent"
    variant="transcript"
    streaming
    capabilities={{ editing: false }}
    composerPlaceholder="Message Tool runner…"
    {adapter}
    onRemoveQueued={() => undefined}
  />
</div>
