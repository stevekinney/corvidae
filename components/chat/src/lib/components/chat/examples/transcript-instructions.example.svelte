<script lang="ts" module>
  export const title = 'Transcript: the agent’s instructions';
  export const description =
    'The agent’s instructions open the transcript as left-aligned muted text with no status fill, folded to one line, "Instructions, Show", that opens to the full text.';
</script>

<script lang="ts">
  import {
    appendMessages,
    appendUserMessage,
    Chat,
    createConversation,
    type ChatAdapter,
  } from '@lostgradient/chat';

  const adapter: ChatAdapter = { sendMessage: async () => undefined };
  const conversation = appendUserMessage(
    appendMessages(createConversation({ id: 'transcript-instructions' }), {
      role: 'system',
      content:
        'You are Tool runner. Look an order up, then ask for approval to refund it. Keep replies short and plain, and never refund an order outside the 30-day window.',
    }),
    'Please refund order 4471, it arrived damaged.',
  );
</script>

<div style="block-size: 22rem;">
  <Chat
    id="transcript-instructions"
    {conversation}
    surfaceMode="transparent"
    variant="transcript"
    capabilities={{ editing: false }}
    composerPlaceholder="Message Tool runner…"
    {adapter}
  />
</div>
