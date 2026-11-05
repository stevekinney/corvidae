<script lang="ts" module>
  export const title = 'Transcript: a reply streaming after its call finished';
  export const description =
    'The call finished, so its rail row reads its result and its time (“Lookup order 4398 → $27.25, delivered Friday”, 0.4s), and the reply under it goes on streaming with a caret, longer than it was while the call ran. The chat header carries no line about settings: the status line is the only trace of a change.';
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
      createConversation({ id: 'transcript-streaming-call-done' }),
      'Also look up order 4398, the same carrier.',
    ),
    'assistant',
  );
  const conversation = updateStreamingMessage(
    opened.conversation,
    opened.messageId,
    'Order 4398 is $27.25 and was delivered Friday. Checking the carrier’s damage notes',
  );
</script>

<div
  style="display: grid; gap: 0.5rem; block-size: 24rem; grid-template-rows: auto minmax(0, 1fr);"
>
  <ToolCallRail
    calls={[
      {
        id: 'call-1',
        name: 'Lookup order',
        input: '4398',
        result: '$27.25, delivered Friday',
        duration: '0.4s',
        status: 'done',
      },
    ]}
  />
  <Chat
    id="transcript-streaming-call-done"
    {conversation}
    surfaceMode="transparent"
    variant="transcript"
    streaming
    capabilities={{ editing: false }}
    composerPlaceholder="Message Tool runner…"
    {adapter}
  />
</div>
