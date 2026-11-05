<script lang="ts" module>
  export const title = 'Transcript: a reply that is streaming';
  export const description =
    'While a reply streams, its tool call shows as a rail row with a spinner, “Running…” and the elapsed time, and the reply ends in a caret, with no line of time, Copy or Quote under it yet and no typing dots. Stop replaces Send in the composer.';
</script>

<script lang="ts">
  import {
    appendStreamingMessage,
    appendUserMessage,
    Chat,
    createConversation,
    updateStreamingMessage,
    type ChatAdapter,
  } from '@lostgradient/chat';
  import { ToolCallRail } from '@lostgradient/cinder';

  const adapter: ChatAdapter = {
    sendMessage: async () => undefined,
    stopGenerating: async () => undefined,
  };
  // The reply is a streaming row, so it draws a caret and no line of actions.
  const opened = appendStreamingMessage(
    appendUserMessage(
      createConversation({ id: 'transcript-streaming' }),
      'Also look up order 4398, the same carrier.',
    ),
    'assistant',
  );
  const conversation = updateStreamingMessage(
    opened.conversation,
    opened.messageId,
    'Looking up order 4398…',
  );
</script>

<div
  style="display: grid; gap: 0.5rem; block-size: 24rem; grid-template-rows: auto minmax(0, 1fr);"
>
  <ToolCallRail
    calls={[
      { id: 'call-1', name: 'Lookup order', input: '4398', duration: '1.2s', status: 'running' },
    ]}
  />
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
